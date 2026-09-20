import {expect, test} from 'bun:test'

import VictoriaClient, {MemoryOutbox, nativeEndpoints, parseTraceparent, traceparent} from '../src/main.ts'
import {clients, fixture, textBody, wireRecords} from './support.ts'

test('construction has no network side effects and disabled signals are harmless', async () => {
  const {client, calls} = fixture({endpoints: {
    metrics: false,
    traces: false,
  }})
  expect(calls).toHaveLength(0)
  const instanceId = client.resource['service.instance.id']
  expect(typeof instanceId).toBe('string')
  expect(instanceId).toMatch(/^[\dA-Za-z]{15}$/u)
  expect(client.metric('disabled', 1)).toBe(false)
  client.info('Hello.')
  expect(calls).toHaveLength(0)
  expect((await client.flush()).complete).toBe(true)
  expect(calls).toHaveLength(1)
})
test('logs snapshot attributes, honor severity and sanitize before storage', async () => {
  const {client, calls} = fixture({sanitizeAttributes: values => Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'secret'))})
  const attrs = {
    amount: 42,
    secret: 'private',
    changed: 'before',
  }
  expect(client.debug('Filtered.')).toBe(false)
  client.warn('Warning.', attrs)
  attrs.changed = 'after'
  await client.flush()
  const [record] = wireRecords(calls[0].body)
  expect(record.severityNumber).toBe(13)
  expect(record.attributes).toContainEqual({
    key: 'changed',
    value: {stringValue: 'before'},
  })
  expect(calls[0].body).not.toContain('private')
  expect(calls[0].init.credentials).toBe('omit')
  expect(calls[0].init.redirect).toBe('error')
})
test('native endpoint helpers preserve path prefixes and use real query parameters', () => {
  const result = nativeEndpoints({
    logs: 'http://logs.test/prefix',
    metrics: 'http://metrics.test',
    traces: 'http://traces.test',
  })
  const log = result.logs as {
    url: string
  }
  expect(new URL(log.url).pathname).toBe('/prefix/insert/jsonline')
  expect(new URL(log.url).searchParams.get('_stream_fields')).toBe('service.name')
  expect(result.metrics).toEqual({
    url: 'http://metrics.test/api/v1/import',
    format: 'victoria-json',
  })
  expect(result.traces).toBe('http://traces.test/insert/opentelemetry/v1/traces')
})
test('native metrics pack multiple timestamps per series and coalesce millisecond collisions', async () => {
  const bodies: Array<string> = []
  const {client} = fixture({
    endpoint: undefined,
    endpoints: {metrics: {
      url: 'http://metrics.test/api/v1/import',
      format: 'victoria-json',
    }},
    fetch: async (_url, init) => {
      bodies.push(textBody(init))
      return new Response(null, {status: 204})
    },
  })
  client.metric('cpu', 1, {time: 1000.1})
  client.metric('cpu', 2, {time: 1000.9})
  client.metric('cpu', 3, {time: 1001})
  await client.flush()
  expect(bodies).toHaveLength(1)
  const row = JSON.parse(bodies[0]) as {
    timestamps: Array<number>
    values: Array<number>
  }
  expect(row.values).toEqual([2, 3])
  expect(row.timestamps).toEqual([1000, 1001])
})
test('OTLP metrics keep one descriptor with absolute and incremental cumulative points', async () => {
  const {client, calls, advance} = fixture()
  client.count('requests', 2)
  advance(10)
  client.increment('requests', 3)
  advance(10)
  client.count('requests', 8)
  await client.flush()
  const records = wireRecords(calls[0].body, 'metrics')
  expect(records).toHaveLength(1)
  expect(records[0].sum?.aggregationTemporality).toBe(2)
  expect(records[0].sum?.dataPoints.map(point => point.asDouble)).toEqual([2, 5, 8])
  expect(new Set(records[0].sum?.dataPoints.map(point => point.startTimeUnixNano)).size).toBe(1)
  expect(() => client.count('requests', 7)).toThrow('must not decrease')
})
test('gauge cardinality is bounded too and metric descriptors cannot change', () => {
  const {client} = fixture({maxSeries: 2})
  expect(client.metric('cpu', 1, {attributes: {host: 'a'}})).toBe(true)
  expect(client.metric('cpu', 2, {attributes: {host: 'b'}})).toBe(true)
  expect(client.metric('cpu', 3, {attributes: {host: 'c'}})).toBe(false)
  expect(client.collectionStatus()).toMatchObject({
    series: 2,
    droppedSeries: 1,
  })
  expect(() => client.count('cpu', 1)).toThrow('different kind')
  expect(() => client.metric('x', Number.NaN)).toThrow()
  expect(() => client.count('x', -1)).toThrow()
})
test('native series identity uses final string labels', () => {
  const {client} = fixture({
    maxSeries: 1,
    endpoints: {metrics: {
      url: 'http://metrics.test/api/v1/import',
      format: 'victoria-json',
    }},
  })
  expect(client.metric('x', 1, {attributes: {v: 1}})).toBe(true)
  expect(client.metric('x', 2, {attributes: {v: '1'}})).toBe(true)
  expect(client.collectionStatus().series).toBe(1)
})
test('wrap preserves sync and async behavior while spans retain correlation and original errors', async () => {
  const {client, calls} = fixture()
  const root = client.startSpan('root')
  const syncResult = client.wrap('child', span => {
    client.log('Correlated.', {context: span})
    return 42
  }, {parent: root})
  expect(syncResult).toBe(42)
  root.end()
  expect(root.end()).toBe(false)
  const original = new Error('private exception text')
  let caught: unknown
  try {
    client.wrap('failure', () => {
      throw original
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(original)
  const asyncResult = client.wrap('async-child', async () => {
    await Bun.sleep(0)
    return 43
  })
  expect(asyncResult).toBeInstanceOf(Promise)
  expect(await asyncResult).toBe(43)
  const asyncOriginal = new Error('private async exception text')
  await expect(client.wrap('async-failure', async () => {
    await Bun.sleep(0)
    throw asyncOriginal
  })).rejects.toBe(asyncOriginal)
  await client.flush()
  const traces = wireRecords(calls.find(call => call.url.endsWith('/traces'))!.body, 'traces')
  const child = traces.find(span => span.name === 'child')!
  const failure = traces.find(span => span.name === 'failure')!
  const asyncFailure = traces.find(span => span.name === 'async-failure')!
  expect(child.parentSpanId).toBe(root.spanId)
  expect(child.traceId).toBe(root.traceId)
  expect(failure.status?.code).toBe(2)
  expect(asyncFailure.status?.code).toBe(2)
  expect(JSON.stringify(calls)).not.toContain('private exception text')
  expect(JSON.stringify(calls)).not.toContain('private async exception text')
  const logs = wireRecords(calls.find(call => call.url.endsWith('/logs'))!.body)
  expect(logs[0].spanId).toBe(child.spanId)
})
test('span event limits and Unicode truncation are explicit', async () => {
  const {client, calls} = fixture({
    maxSpanEvents: 2,
    maxAttributeBytes: 32,
  })
  const span = client.startSpan('bounded', {attributes: {unicode: '🦄'.repeat(100)}})
  span.addEvent('first')
  span.addEvent('second')
  expect(span.addEvent('third')).toBe(false)
  span.end()
  await client.flush()
  const [record] = wireRecords(calls[0].body, 'traces')
  expect(record.droppedEventsCount).toBe(1)
  expect(record.events).toHaveLength(2)
  expect(record.attributes).toContainEqual({
    key: 'unicode',
    value: {stringValue: '🦄'.repeat(8)},
  })
})
test('span redaction also covers late attributes and events', async () => {
  const {client, calls} = fixture({sanitizeAttributes: values => Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'secret'))})
  const span = client.startSpan('redacted')
  span.setAttributes({secret: 'late-secret'})
  span.addEvent('event', {secret: 'event-secret'})
  span.end('ok', {secret: 'end-secret'})
  await client.flush()
  expect(calls[0].body).not.toContain('secret')
})
test('traceparent validates nonzero IDs and preserves unsampled parents', async () => {
  const valid = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-00'
  const context = parseTraceparent(valid)!
  expect(traceparent(context)).toBe(valid)
  expect(parseTraceparent('00-00000000000000000000000000000000-1234567890abcdef-01')).toBeUndefined()
  expect(parseTraceparent('ff-1234567890abcdef1234567890abcdef-1234567890abcdef-01')).toBeUndefined()
  const {client, calls} = fixture()
  const span = client.startSpan('unsampled', {parent: context})
  expect(span.end()).toBe(false)
  await client.flush()
  expect(calls).toHaveLength(0)
})
test('flush drains a complete snapshot rather than a single batch', async () => {
  const {client, calls} = fixture({maxBatchItems: 3})
  for (let i = 0; i < 20; i++) {
    client.info(`record-${i}`)
  }
  const report = await client.flush()
  expect(report.complete).toBe(true)
  expect(report.signals.logs.sent).toBe(20)
  expect(calls).toHaveLength(7)
})
test('queue admission is bounded by bytes and count independently per signal', () => {
  const {client} = fixture({outbox: new MemoryOutbox({
    maxItems: 1,
    maxBytes: 2000,
  })})
  expect(client.info('first')).toBe(true)
  expect(client.info('second')).toBe(false)
  expect(client.metric('x', 1)).toBe(true)
  expect(client.status().signals.logs.dropped).toBe(1)
})
test('oversized payloads are rejected before persistence', () => {
  const {client} = fixture({maxItemBytes: 1000})
  expect(client.info('x'.repeat(2000))).toBe(false)
  expect(client.status().signals.logs).toMatchObject({
    items: 0,
    dropped: 1,
  })
})
test('shutdown is idempotent and no longer accepts data', async () => {
  const {client} = fixture()
  client.info('last')
  const shutdown = client.shutdown()
  expect(client.shutdown()).toBe(shutdown)
  expect(client.info('too late')).toBe(false)
  expect((await shutdown).complete).toBe(true)
  expect(client.status().signals.logs.sent).toBe(1)
})
test('invalid endpoint schemes and incompatible formats fail before network access', () => {
  expect(() => new VictoriaClient({
    serviceName: 'x',
    endpoint: 'file:///tmp',
  })).toThrow()
  expect(() => new VictoriaClient({
    serviceName: 'x',
    endpoint: 'http://user:secret@collector.test',
  })).toThrow()
  expect(() => new VictoriaClient({
    serviceName: 'x',
    endpoints: {traces: {
      url: 'http://collector.test',
      format: 'victoria-json',
    }},
  })).toThrow()
  expect(() => new VictoriaClient({
    serviceName: 'x',
    endpoint: 'http://collector.test',
    maxBatchBytes: 10,
    maxItemBytes: 20,
  })).toThrow()
})
test('native logs protect reserved fields and reject misleading success pages', async () => {
  let body = ''
  const client = new VictoriaClient({
    serviceName: 'test',
    endpoints: {logs: {
      url: 'http://logs.test/insert/jsonline',
      format: 'victoria-logs',
    }},
    fetch: async (_url, init) => {
      body = textBody(init)
      return new Response('<html>Sign in</html>', {headers: {'Content-Type': 'text/html'}})
    },
  })
  clients.push(client)
  client.log('real', {attributes: {_msg: 'fake'}})
  const report = await client.flush()
  expect(Reflect.get(JSON.parse(body) as object, '_msg')).toBe('real')
  expect(report.signals.logs.rejected).toBe(1)
})
