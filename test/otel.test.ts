import {expect, test} from 'bun:test'

import {ROOT_CONTEXT, trace} from '@opentelemetry/api'
import {ExportResultCode} from '@opentelemetry/core'

import DeliveryEngine from '../src/delivery/DeliveryEngine.ts'
import {MemoryOutbox} from '../src/main.ts'
import OpenTelemetryClient, {ProtobufCodec, QueuedLogExporter} from '../src/otel/main.ts'

type Field = {
  field: number
  value: Uint8Array | bigint
}
/** Independent wire reader: assertions do not reuse the encoder being tested. */
function fields(bytes: Uint8Array): Array<Field> {
  let offset = 0
  const varint = () => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes.at(offset++)
      if (byte === undefined) {
        throw new Error('Truncated protobuf varint.')
      }
      value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) {
        return value
      }
    }
    throw new Error('Oversized protobuf varint.')
  }
  const result: Array<Field> = []
  while (offset < bytes.byteLength) {
    const tag = Number(varint())
    const wire = tag & 7
    if (wire === 0) {
      result.push({
        field: tag >>> 3,
        value: varint(),
      })
    } else {
      let length = -1
      if (wire === 1) {
        length = 8
      } else if (wire === 5) {
        length = 4
      } else if (wire === 2) {
        length = Number(varint())
      }
      if (length < 0 || offset + length > bytes.byteLength) {
        throw new Error('Invalid protobuf field.')
      }
      result.push({
        field: tag >>> 3,
        value: bytes.subarray(offset, offset + length),
      })
      offset += length
    }
  }
  return result
}
const messages = (bytes: Uint8Array, field: number) => fields(bytes).flatMap(item => {
  return item.field === field && item.value instanceof Uint8Array ? [item.value] : []
})
const text = (bytes: Uint8Array, field: number) => (new TextDecoder).decode(messages(bytes, field)[0])
const records = (body: Uint8Array) => messages(body, 1).flatMap(resource => messages(resource, 2).flatMap(scope => messages(scope, 2)))
for (const handoff of ['batch', 'immediate'] as const) {
  test(`official SDK ${handoff} handoff exports three valid protobuf signals and leaves globals alone`, async () => {
    const globalProvider = trace.getTracerProvider()
    const requests: Array<{
      bytes: Uint8Array
      contentType: string | null
      signal: string
    }> = []
    const client = new OpenTelemetryClient({ serviceName: 'sdk-test', endpoint: 'http://collector.test', handoff, compressionThreshold: 1, fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const payload = new Uint8Array(init.body as Uint8Array)
      requests.push({
        signal: new URL(url).pathname.split('/').at(-1)!,
        bytes: headers.get('Content-Encoding') === 'gzip' ? Bun.gunzipSync(payload) : payload,
        contentType: headers.get('Content-Type'),
      })
      return new Response(new Uint8Array, {headers: {'Content-Type': 'application/x-protobuf'}})
    } })
    try {
      expect(requests).toHaveLength(0)
      const parent = client.tracer.startSpan('sdk-parent')
      const child = client.tracer.startSpan('sdk-child', {}, trace.setSpan(ROOT_CONTEXT, parent))
      client.logger.emit({
        body: 'sdk-log',
        severityNumber: 9,
        context: trace.setSpan(ROOT_CONTEXT, child),
      })
      client.meter.createCounter('sdk.counter').add(3, {job: 'test'})
      client.meter.createHistogram('sdk.duration', {unit: 's'}).record(0.25)
      child.end()
      parent.end()
      expect((await client.flush()).complete).toBe(true)
      expect(new Set(requests.map(request => request.signal))).toEqual(new Set(['logs', 'metrics', 'traces']))
      expect(requests.every(request => request.contentType === 'application/x-protobuf')).toBe(true)
      const logs = records(requests.find(request => request.signal === 'logs')!.bytes)
      expect(text(messages(logs[0], 5)[0], 1)).toBe('sdk-log')
      const spans = records(requests.find(request => request.signal === 'traces')!.bytes)
      expect(spans.map(span => text(span, 5))).toEqual(['sdk-child', 'sdk-parent'])
      expect(messages(spans[0], 4)[0]).toEqual(messages(spans[1], 2)[0])
      expect(messages(logs[0], 10)[0]).toEqual(messages(spans[0], 2)[0])
      const metrics = records(requests.find(request => request.signal === 'metrics')!.bytes)
      expect(metrics.map(metric => text(metric, 1))).toEqual(['sdk.counter', 'sdk.duration'])
      expect(messages(metrics[0], 7)).toHaveLength(1)
      expect(messages(metrics[1], 9)).toHaveLength(1)
      expect(trace.getTracerProvider()).toBe(globalProvider)
      const shutdown = client.shutdown()
      expect(client.shutdown()).toBe(shutdown)
      await shutdown
      expect(() => client.tracer).toThrow('closed')
    } finally {
      await client.shutdown()
    }
  })
}
test('protobuf partial success is decoded by the official serializer and never retried', async () => {
  let calls = 0
  const client = new OpenTelemetryClient({ serviceName: 'test', endpoints: {logs: 'http://collector.test/v1/logs'}, fetch: async () => {
    calls++
            // ExportLogsServiceResponse.partialSuccess.rejectedLogRecords = 1.
    return new Response(new Uint8Array([10, 2, 8, 1]), {headers: {'Content-Type': 'application/x-protobuf'}})
  } })
  try {
    client.logger.emit({body: 'a'})
    client.logger.emit({body: 'b'})
    const result = await client.flush()
    expect(result.signals.logs).toMatchObject({
      sent: 1,
      rejected: 1,
      records: 0,
    })
    await client.flush()
    expect(calls).toBe(1)
  } finally {
    await client.shutdown()
  }
})
test('SDK handoff refuses data after exporter shutdown', async () => {
  const outbox = new MemoryOutbox({maxItems: 1})
  const engine = new DeliveryEngine({
    targets: {logs: {
      url: 'http://collector.test/v1/logs',
      codec: new ProtobufCodec('logs'),
    }},
    outbox,
  })
  const exporter = new QueuedLogExporter(engine)
  await exporter.shutdown()
  const results: Array<number> = []
  exporter.export([], result => results.push(result.code))
  expect(results).toEqual([ExportResultCode.FAILED])
  await engine.shutdown()
})
test('SDK transport failures retain queued protobuf rather than failing application collection', async () => {
  const client = new OpenTelemetryClient({
    serviceName: 'test',
    endpoints: {traces: 'http://collector.test/v1/traces'},
    timeout: 5,
    fetch: async () => {
      throw new Error('offline')
    },
  })
  client.tracer.startSpan('retained').end()
  const report = await client.flush()
  expect(report.signals.traces.records).toBe(1)
  expect(report.signals.traces.attempts).toBe(1)
  expect((await client.shutdown({timeout: 5})).pendingRecords).toBe(1)
})
