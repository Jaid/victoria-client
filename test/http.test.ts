import {expect, test} from 'bun:test'

import VictoriaClient from '../src/main.ts'
import {fixture, wireRecords} from './support.ts'

test('real HTTP transport sends gzip, batches records and validates acknowledgments', async () => {
  const received: Array<{
    body: string
    encoding: string | null
    path: string
  }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = new Uint8Array(await request.arrayBuffer())
    const encoding = request.headers.get('Content-Encoding')
    received.push({
      path: new URL(request.url).pathname,
      body: (new TextDecoder).decode(encoding === 'gzip' ? Bun.gunzipSync(body) : body),
      encoding,
    })
    return Response.json({})
  } })
  const client = new VictoriaClient({
    serviceName: 'http-integration',
    endpoint: server.url.href,
    compression: 'gzip',
    compressionThreshold: 1,
  })
  try {
    for (let i = 0; i < 50; i++) {
      client.info('A real request to a disposable local receiver.')
    }
    const report = await client.flush({throwOnPending: true})
    expect(report.signals.logs.sent).toBe(50)
    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/v1/logs')
    expect(received[0].encoding).toBe('gzip')
    expect(wireRecords(received[0].body)).toHaveLength(50)
  } finally {
    await client.shutdown()
    await server.stop(true)
  }
})
test('real fetch refuses redirects instead of forwarding telemetry or authorization', async () => {
  let redirected = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/unexpected') {
      redirected++
      return Response.json({})
    }
    return new Response(null, {
      status: 307,
      headers: {Location: '/unexpected'},
    })
  } })
  const client = new VictoriaClient({
    serviceName: 'http-integration',
    endpoint: server.url.href,
    headers: {Authorization: 'test-only'},
  })
  try {
    client.info('Do not forward.')
    const report = await client.flush()
    expect(redirected).toBe(0)
    expect(report.signals.logs.records).toBe(1)
    expect(report.signals.logs.attempts).toBe(1)
  } finally {
    await client.shutdown({timeout: 5})
    await server.stop(true)
  }
})
test('interval scheduler starts automatically and setInterval can disable, enable and reschedule it', async () => {
  const scheduled = fixture({interval: 5})
  scheduled.client.info('scheduled')
  await Bun.sleep(30)
  expect(scheduled.calls).toHaveLength(1)
  scheduled.client.setInterval(false)
  scheduled.client.info('paused')
  await Bun.sleep(15)
  expect(scheduled.calls).toHaveLength(1)
  scheduled.client.setInterval(5)
  await Bun.sleep(30)
  expect(scheduled.calls).toHaveLength(2)
  for (const interval of [0, false, null] as const) {
    const disabled = fixture({interval})
    disabled.client.info('manual')
    await Bun.sleep(15)
    expect(disabled.calls).toHaveLength(0)
    disabled.client.setInterval(5)
    await Bun.sleep(30)
    expect(disabled.calls).toHaveLength(1)
  }
})
test('portable entry bundles for browsers without importing Bun or the OpenTelemetry SDK', async () => {
  const result = await Bun.build({
    entrypoints: ['./src/main.ts'],
    target: 'browser',
    minify: true,
  })
  expect(result.success).toBe(true)
  const text = await result.outputs[0].text()
  expect(text).not.toContain('bun:sqlite')
  expect(text).not.toContain('node:async_hooks')
  expect(text).not.toContain('LoggerProvider')
  expect(result.outputs[0].size).toBeLessThan(50_000)
})
