import {expect, test} from 'bun:test'

import OtlpJsonCodec from '../src/codecs/OtlpJsonCodec.ts'
import VictoriaClient from '../src/main.ts'
import ProtobufCodec from '../src/otel/ProtobufCodec.ts'
import {textBody, wireRecords} from './support.ts'

for (const Codec of [OtlpJsonCodec, ProtobufCodec]) {
  test(`${Codec.name} distinguishes Victoria empty acknowledgments from strict OTLP responses`, () => {
    expect(() => new Codec('traces').accept(new Uint8Array, null, 1)).toThrow()
    const native = new Codec('traces', 'victoria')
    expect(native.accept(new Uint8Array, null, 1)).toEqual({rejected: 0})
    expect(() => native.accept(new Uint8Array, 'text/html', 1)).toThrow()
    expect(() => native.accept((new TextEncoder).encode('<html>login</html>'), 'text/html', 1)).toThrow()
  })
}
test('protocol, bare host, port and path compose without changing explicit endpoint meaning', async () => {
  const calls: Array<{
    body: string
    url: string
  }> = []
  const client = new VictoriaClient('my-app', {protocol: 'https', host: 'victoria.example.com', port: 8443, path: 'api', logs: {path: 'logs'}, metrics: false, traces: false, minLogLevel: 'trace', interval: false, fetch: async (url, init) => {
    calls.push({
      url,
      body: textBody(init),
    })
    return Response.json({})
  }})
  try {
    expect(client.trace('noise')).toBe(true)
    client.debug('debug')
    await client.sync()
    expect(calls[0].url).toBe('https://victoria.example.com:8443/api/logs')
    expect(wireRecords(calls[0].body).map(record => record.severityNumber)).toEqual([1, 5])
  } finally {
    await client.shutdown()
  }
})
test('signal-specific authorization overrides shared headers case-insensitively', async () => {
  const seen: Array<string | null> = []
  const client = new VictoriaClient({serviceName: 'headers', endpoint: 'http://collector.test', headers: {Authorization: 'shared'}, signalHeaders: {logs: {authorization: 'specific'}}, fetch: async (_url, init) => {
    seen.push(new Headers(init.headers).get('Authorization'))
    return Response.json({})
  }})
  try {
    client.info('test')
    await client.flush()
    expect(seen).toEqual(['specific'])
  } finally {
    await client.shutdown()
  }
})
test('known native OTLP routes enable compatibility, which callers can explicitly override', async () => {
  for (const acknowledgment of [undefined, 'otlp'] as const) {
    const client = new VictoriaClient({
      serviceName: 'ack',
      endpoints: {traces: {
        url: 'http://collector.test/insert/opentelemetry/v1/traces',
        format: 'otlp-json',
        acknowledgment,
      }},
      fetch: async () => new Response(null),
    })
    try {
      client.pushTrace('test')
      const report = await client.flush()
      expect(report.signals.traces.sent).toBe(acknowledgment ? 0 : 1)
      expect(report.signals.traces.rejected).toBe(acknowledgment ? 1 : 0)
    } finally {
      await client.shutdown()
    }
  }
})
