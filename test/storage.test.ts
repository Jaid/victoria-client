import type Outbox from '../src/storage/base/Outbox.ts'
import type {PendingItem} from '../src/storage/base/Outbox.ts'

import {afterEach, expect, test} from 'bun:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import OtlpJsonCodec from '../src/codecs/OtlpJsonCodec.ts'
import DeliveryEngine from '../src/delivery/DeliveryEngine.ts'
import VictoriaClient, {MemoryOutbox} from '../src/main.ts'
import SqliteOutbox from '../src/storage/SqliteOutbox.ts'
import {textBody, wireRecords} from './support.ts'

const directories: Array<string> = []
const stores: Array<Outbox> = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
    })
  }
})
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'victoria-client-'))
  directories.push(directory)
  return join(directory, 'outbox.sqlite')
}
const item = (body = 'test', signal: PendingItem['signal'] = 'logs'): PendingItem => ({
  signal,
  body: (new TextEncoder).encode(body),
  createdAt: Date.now(),
  records: 1,
})
for (const kind of ['memory', 'sqlite'] as const) {
  const make = (maxItems = 2, maxBytes = 12) => {
    const store = kind === 'sqlite' ? new SqliteOutbox({
      path: temporary(),
      maxItems,
      maxBytes,
      maxDeadLetters: 2,
    }) : new MemoryOutbox({
      maxItems,
      maxBytes,
      maxDeadLetters: 2,
    })
    stores.push(store)
    return store
  }
  test(`${kind}: atomic multi-signal admission, byte limits and detached snapshots`, () => {
    const store = make()
    const first = item()
    expect(store.append([first])).toBe(true)
    first.body[0] = 0
    const rows = store.peek('logs', store.highWater(), 20)
    expect((new TextDecoder).decode(rows[0].body)).toBe('test')
    rows[0].body[0] = 0
    expect((new TextDecoder).decode(store.peek('logs', store.highWater(), 20)[0].body)).toBe('test')
    expect(store.append([item('one'), item('two'), item('metric', 'metrics')])).toBe(false)
    expect(store.stats('metrics').items).toBe(0)
    expect(store.append([item('x'.repeat(9))])).toBe(false)
    expect(store.append([item('one'), item('metric', 'metrics')])).toBe(true)
    expect(store.stats('logs')).toMatchObject({
      items: 2,
      records: 2,
      bytes: 7,
    })
  })
  test(`${kind}: acknowledgments remove only selected rows and clear retry state`, () => {
    const store = make(5, 100)
    store.append([item('first')])
    const first = store.peek('logs', store.highWater(), 10)
    store.append([item('second')])
    store.defer('logs', {
      attempts: 2,
      retryAt: 42,
      blocked: true,
      through: first[0].id,
    })
    store.settle('logs', first)
    expect(store.lane('logs')).toEqual({
      attempts: 0,
      retryAt: 0,
      blocked: false,
    })
    expect((new TextDecoder).decode(store.peek('logs', store.highWater(), 10)[0].body)).toBe('second')
  })
  test(`${kind}: dead-letter diagnostics are bounded and exclude payloads`, () => {
    const store = make(5, 100)
    for (let i = 0; i < 3; i++) {
      store.append([item('private-payload')])
      const rows = store.peek('logs', store.highWater(), 10)
      store.settle('logs', rows, {
        signal: 'logs',
        reason: `rejected-${i}`,
        records: 1,
        bytes: 15,
        time: Date.now(),
      })
    }
    expect(store.deadLetters()).toHaveLength(2)
    expect(store.deadLetters()[0].reason).toBe('rejected-1')
    expect(JSON.stringify(store.deadLetters())).not.toContain('private-payload')
  })
  test(`${kind}: one outbox instance cannot acquire two delivery engines`, async () => {
    const store = make(20, 10_000)
    const options = {
      outbox: store,
      targets: {logs: {
        url: 'http://collector.test/v1/logs',
        codec: new OtlpJsonCodec('logs'),
      }},
    }
    const engine = new DeliveryEngine(options)
    expect(() => new DeliveryEngine(options)).toThrow('already owned')
    await engine.shutdown()
  })
}
test('SQLite transactions commit application state and telemetry together or neither', () => {
  const store = new SqliteOutbox({path: temporary()})
  stores.push(store)
  store.database.run('CREATE TABLE business (id INTEGER PRIMARY KEY, value TEXT)')
  expect(() => store.transaction(() => {
    store.database.query('INSERT INTO business VALUES (1,?)').run('rolled back')
    store.append([item('rolled back')])
    throw new Error('abort transaction')
  })).toThrow('abort transaction')
  expect(store.database.query('SELECT * FROM business').all()).toHaveLength(0)
  expect(store.stats('logs').items).toBe(0)
  store.transaction(() => {
    store.database.query('INSERT INTO business VALUES (1,?)').run('committed')
    if (!store.append([item('committed')])) {
      throw new Error('outbox full')
    }
  })
  expect(store.stats('logs').items).toBe(1)
  expect(store.database.query('SELECT * FROM business').all()).toHaveLength(1)
})
test('SQLite restart preserves exact failed batches, backoff and resource identity', async () => {
  const path = temporary()
  let now = Date.now()
  let first = ''
  const initialStore = new SqliteOutbox({path})
  stores.push(initialStore)
  const original = new VictoriaClient({ serviceName: 'original', endpoint: 'http://collector.test', outbox: initialStore, now: () => now, random: () => 0, fetch: async (_url, init) => {
    first = textBody(init)
    return new Response(null, {
      status: 503,
      headers: {'Retry-After': '10'},
    })
  } })
  original.info('first')
  original.info('second')
  await original.flush()
  original.info('third')
  expect((await original.shutdown({timeout: 5})).pendingRecords).toBe(3)
  const reopened = new SqliteOutbox({path})
  stores.push(reopened)
  const bodies: Array<string> = []
  const next = new VictoriaClient({
    serviceName: 'new-process',
    endpoint: 'http://collector.test',
    outbox: reopened,
    now: () => now,
    fetch: async (_url, init) => {
      bodies.push(textBody(init))
      return Response.json({})
    },
  })
  try {
    await next.flush()
    expect(bodies).toHaveLength(0)
    expect(next.status().signals.logs.attempts).toBe(1)
    now += 10_000
    await next.flush()
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(first)
    expect(wireRecords(bodies[1])[0].body?.stringValue).toBe('third')
    expect(bodies[1]).toContain('original')
    expect(bodies[1]).not.toContain('new-process')
  } finally {
    await next.shutdown()
  }
})
test('SQLite prevents cross-process ownership and detects a stolen expired lease', () => {
  const path = temporary()
  let now = Date.now()
  const first = new SqliteOutbox({
    path,
    now: () => now,
    lease: 3000,
  })
  stores.push(first)
  expect(() => new SqliteOutbox({
    path,
    now: () => now,
    lease: 3000,
  })).toThrow('active sender')
  first.append([item('persistent')])
  now += 3001
  const second = new SqliteOutbox({
    path,
    now: () => now,
    lease: 3000,
  })
  stores.push(second)
  expect(second.stats('logs').items).toBe(1)
  expect(() => first.append([item('stale')])).toThrow('lease was lost')
  first.close()
  expect(second.stats('logs').items).toBe(1)
})
test('SQLite rejects schema and route mismatches instead of silently rerouting old data', async () => {
  const path = temporary()
  let store = new SqliteOutbox({path})
  const client = new VictoriaClient({
    serviceName: 'test',
    endpoint: 'http://original.test',
    outbox: store,
  })
  await client.shutdown()
  store = new SqliteOutbox({path})
  stores.push(store)
  expect(() => new VictoriaClient({
    serviceName: 'test',
    endpoint: 'http://other.test',
    outbox: store,
  })).toThrow('different endpoints')
  store.database.query("UPDATE victoria_meta SET value='99' WHERE key='schema'").run()
  store.close()
  expect(() => new SqliteOutbox({path})).toThrow('Unsupported')
})
test('SQLite does not persist authentication headers or endpoint credentials', async () => {
  const store = new SqliteOutbox({path: temporary()})
  stores.push(store)
  const client = new VictoriaClient({
    serviceName: 'test',
    endpoint: 'http://collector.test?token=endpoint-private',
    headers: {Authorization: 'Bearer header-private'},
    outbox: store,
  })
  client.info('intended observation')
  const metadata = store.database.query('SELECT * FROM victoria_meta').all()
  expect(JSON.stringify(metadata)).not.toContain('private')
  const body = store.peek('logs', store.highWater(), 10)[0].body
  expect((new TextDecoder).decode(body)).not.toContain('private')
  client.resume()
    // Keep the test entirely offline; closing the store emulates a process exit before delivery.
  store.close()
})
