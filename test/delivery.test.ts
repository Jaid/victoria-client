import {expect, test} from 'bun:test'

import DeliveryError from '../src/delivery/DeliveryError.ts'
import {retryAfter} from '../src/delivery/HttpTransport.ts'
import {MemoryOutbox} from '../src/main.ts'
import {fixture, textBody, wireRecords} from './support.ts'

for (const code of [429, 502, 503, 504]) {
  test(`OTLP HTTP ${code} retries the same batch after backoff`, async () => {
    const bodies: Array<string> = []
    let healthy = false
    const {client, advance} = fixture({fetch: async (_url, init) => {
      bodies.push(textBody(init))
      return healthy ? Response.json({}) : new Response(null, {
        status: code,
        headers: {'Retry-After': '2'},
      })
    } })
    client.info('original')
    await client.flush()
    client.info('later')
    await client.flush()
    expect(bodies).toHaveLength(1)
    expect(client.status().signals.logs.attempts).toBe(1)
    healthy = true
    advance(2000)
    await client.flush()
    expect(bodies).toHaveLength(3)
    expect(bodies[1]).toBe(bodies[0])
    expect(wireRecords(bodies[2])[0].body?.stringValue).toBe('later')
  })
}
for (const code of [400, 404, 500]) {
  test(`OTLP HTTP ${code} is not retried`, async () => {
    let calls = 0
    const {client} = fixture({fetch: async () => {
      calls++
      return new Response(null, {status: code})
    }})
    client.info('bad')
    await client.flush()
    await client.flush()
    expect(calls).toBe(1)
    expect(client.status().signals.logs.rejected).toBe(1)
    expect(client.delivery.outbox.deadLetters()[0].reason).toContain(String(code))
  })
}
test('signals fail independently', async () => {
  const {client} = fixture({fetch: async url => {
    return url.endsWith('/metrics') ? new Response(null, {status: 503}) : Response.json({})
  }})
  client.info('ok')
  client.metric('blocked', 1)
  client.startSpan('ok').end()
  const report = await client.flush()
  expect(report.signals.logs.sent).toBe(1)
  expect(report.signals.traces.sent).toBe(1)
  expect(report.signals.metrics.records).toBe(1)
})
test('partial acceptance consumes the batch once and does not expose echoed payloads', async () => {
  let calls = 0
  const {client} = fixture({fetch: async () => {
    calls++
    return Response.json({partialSuccess: {
      rejectedLogRecords: '1',
      errorMessage: 'secret body echoed by server',
    }})
  } })
  client.info('first')
  client.info('second')
  await client.flush()
  await client.flush()
  expect(calls).toBe(1)
  expect(client.status().signals.logs).toMatchObject({
    sent: 1,
    rejected: 1,
    records: 0,
  })
  expect(JSON.stringify(client.delivery.outbox.deadLetters())).not.toContain('secret body')
})
for (const rejected of [-1, '1.5', true, null, 'garbage', 10]) {
  test(`malformed partial success ${String(rejected)} is rejected without retry`, async () => {
    let calls = 0
    const {client} = fixture({fetch: async () => {
      calls++
      return Response.json({partialSuccess: {rejectedLogRecords: rejected}})
    }})
    client.info('x')
    await client.flush()
    expect(client.status().signals.logs.rejected).toBe(1)
    expect(calls).toBe(1)
  })
}
test('authentication failures preserve data and need explicit resumption', async () => {
  const headers: Array<string | null> = []
  let token = 'old'
  const {client} = fixture({ headers: () => ({Authorization: token}), fetch: async (_url, init) => {
    headers.push(new Headers(init.headers).get('Authorization'))
    return token === 'old' ? new Response(null, {status: 401}) : Response.json({})
  } })
  client.info('retained')
  await client.flush()
  await client.flush()
  expect(client.status().signals.logs).toMatchObject({
    records: 1,
    blocked: true,
  })
  expect(headers).toEqual(['old'])
  token = 'new'
  client.resume('logs')
  await client.flush()
  expect(headers).toEqual(['old', 'new'])
  expect(client.status().complete).toBe(true)
})
test('native import splits HTTP 413 batches while keeping every successful sample once', async () => {
  const accepted: Array<string> = []
  let calls = 0
  const {client} = fixture({ endpoint: undefined, endpoints: {metrics: {
    url: 'http://metrics.test/api/v1/import',
    format: 'victoria-json',
  }}, fetch: async (_url, init) => {
    calls++
    const lines = textBody(init).trim().split('\n')
    if (lines.length > 2) {
      return new Response(null, {status: 413})
    }
    accepted.push(...lines)
    return new Response(null, {status: 204})
  } })
  for (let i = 0; i < 7; i++) {
    client.metric(`series_${i}`, i)
  }
  const report = await client.flush()
  expect(report.complete).toBe(true)
  expect(accepted).toHaveLength(7)
  expect(new Set(accepted).size).toBe(7)
  expect(calls).toBeGreaterThan(4)
})
test('OTLP 413 is permanent rather than violating OTLP retry rules', async () => {
  let calls = 0
  const {client} = fixture({fetch: async () => {
    calls++
    return new Response(null, {status: 413})
  }})
  client.info('one')
  client.info('two')
  await client.flush()
  expect(calls).toBe(1)
  expect(client.status().signals.logs.rejected).toBe(2)
})
test('concurrent flush callers share work and a later barrier includes appended records', async () => {
  const first = Promise.withResolvers<Response>()
  const bodies: Array<string> = []
  let active = 0
  let maxActive = 0
  const {client} = fixture({ fetch: async (_url, init) => {
    bodies.push(textBody(init))
    active++
    maxActive = Math.max(maxActive, active)
    const response = bodies.length === 1 ? await first.promise : Response.json({})
    active--
    return response
  } })
  client.info('before')
  const running = client.flush()
  client.info('during')
  expect(client.flush()).toBe(running)
  first.resolve(Response.json({}))
  await running
  expect(bodies).toHaveLength(2)
  expect(maxActive).toBe(1)
  expect(client.status().complete).toBe(true)
})
test('shutdown cancels an existing request and respects its own deadline', async () => {
  const {client} = fixture({ fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
  }) })
  client.info('persistent candidate')
  const flush = client.flush({timeout: 1000})
  const started = performance.now()
  const report = await client.shutdown({timeout: 20})
  await flush
  expect(performance.now() - started).toBeLessThan(500)
  expect(report.pendingRecords).toBe(1)
})
test('response streams are bounded and cannot bypass the request timeout', async () => {
  const {client} = fixture({
    timeout: 10,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({start() { }}), {headers: {'Content-Type': 'application/json'}}),
  })
  client.info('body timeout')
  const started = performance.now()
  const report = await client.flush()
  expect(performance.now() - started).toBeLessThan(500)
  expect(report.signals.logs.attempts).toBe(1)
  expect(report.pendingRecords).toBe(1)
})
test('oversized responses are rejected rather than fully buffered', async () => {
  const {client} = fixture({
    maxResponseBytes: 8,
    fetch: async () => Response.json({huge: 'x'.repeat(100)}),
  })
  client.info('x')
  await client.flush()
  expect(client.status().signals.logs.rejected).toBe(1)
})
test('gzip reduces repetitive batches and is a valid request body', async () => {
  let compressed = 0
  let decoded = ''
  let encoding: string | null = null
  const {client} = fixture({ compression: 'gzip', compressionThreshold: 1, fetch: async (_url, init) => {
    const payload = init.body as Uint8Array
    compressed = payload.byteLength
    encoding = new Headers(init.headers).get('Content-Encoding')
    decoded = (new TextDecoder).decode(Bun.gunzipSync(new Uint8Array(payload)))
    return Response.json({})
  } })
  for (let i = 0; i < 100; i++) {
    client.info('A repeated message for compression.')
  }
  await client.flush()
  expect(encoding as string | null).toBe('gzip')
  expect(wireRecords(decoded)).toHaveLength(100)
  expect(compressed).toBeLessThan((new TextEncoder).encode(decoded).byteLength / 4)
})
test('ready expired records and exhausted retries are counted and removed', async () => {
  let calls = 0
  const {client, advance} = fixture({
    maxAge: 10,
    fetch: async () => {
      calls++
      return Response.json({})
    },
  })
  client.info('old')
  advance(11)
  await client.flush()
  expect(calls).toBe(0)
  expect(client.delivery.outbox.deadLetters()[0].reason).toContain('maxAge')
  const failed = fixture({
    maxAttempts: 1,
    fetch: async () => {
      throw new Error('offline')
    },
  }).client
  failed.info('x')
  await failed.flush()
  expect(failed.status().signals.logs.rejected).toBe(1)
})
test('diagnostic callbacks cannot interrupt delivery', async () => {
  const {client} = fixture({onEvent: () => {
    throw new Error('observer failed')
  }})
  client.info('x')
  expect((await client.flush()).complete).toBe(true)
})
test('storage errors are surfaced and never acknowledged as successful admission', () => {
  class BrokenOutbox extends MemoryOutbox {
    override append(): boolean {
      throw new Error('disk full')
    }
  }
  const {client} = fixture({outbox: new BrokenOutbox})
  expect(() => client.info('x')).toThrow('disk full')
  expect(client.status().signals.logs.admitted).toBe(0)
})
test('Retry-After supports seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-20T00:00:00Z')
  expect(retryAfter('2.5', now)).toBe(2500)
  expect(retryAfter('Sun, 20 Sep 2026 00:00:03 GMT', now)).toBe(3000)
  expect(retryAfter('invalid', now)).toBe(0)
  expect(new DeliveryError('test', 'retry').kind).toBe('retry')
})
