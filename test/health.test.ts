import {expect, test} from 'bun:test'

import VictoriaClient, {nativeEndpoints} from '../src/main.ts'
import OpenTelemetryClient from '../src/otel/main.ts'
import {clients, fixture, textBody} from './support.ts'

test('health probes every enabled ingestion route without observations or queue changes', async () => {
  const {client, calls} = fixture()
  client.info('still queued')
  const before = client.status()
  await expect(client.assertHealth()).resolves.toBeUndefined()
  expect(calls.map(call => call.url).toSorted()).toEqual(['http://collector.test/v1/logs', 'http://collector.test/v1/metrics', 'http://collector.test/v1/traces'])
  expect(calls.map(call => JSON.parse(call.body) as unknown)).toEqual([{resourceLogs: []}, {resourceMetrics: []}, {resourceSpans: []}])
  expect(client.status()).toEqual(before)
})
test.each([401, 403, 404, 429, 500, 503])('health throws on HTTP %s without retrying or changing backoff', async status => {
  let requests = 0
  const {client} = fixture({endpoints: {
    metrics: false,
    traces: false,
  }, fetch: async () => {
    requests++
    return new Response('secret', {status})
  }})
  const before = client.status()
  await expect(client.assertHealth()).rejects.toBeInstanceOf(AggregateError)
  expect(requests).toBe(1)
  expect(client.status()).toEqual(before)
  client.info('Connection failures do not interrupt collection.')
  await expect(client.flush()).resolves.toBeDefined()
})
test('health checks collect all failing signals and sanitize arbitrary errors', async () => {
  const {client} = fixture({fetch: async () => {
    throw new Error('secret-password')
  }})
  try {
    await client.assertHealth()
    throw new Error('Expected health failure.')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    expect(aggregate.errors).toHaveLength(3)
    expect(aggregate.errors.map((failure: Error) => failure.message).join(' ')).not.toContain('secret-password')
  }
})
test.each([
  () => new Response('<html>Login</html>', {headers: {'content-type': 'text/html'}}),
  () => Response.json({partialSuccess: {errorMessage: 'warning'}}),
  () => new Response('{broken', {headers: {'content-type': 'application/json'}}),
])('health rejects invalid or partial acknowledgments', async fetch => {
  const {client} = fixture({fetch: async () => fetch()})
  await expect(client.assertHealth()).rejects.toBeInstanceOf(AggregateError)
})
test('health has a bounded deadline even for a fetch that ignores cancellation', async () => {
  const {client} = fixture({fetch: () => new Promise<Response>(() => {})})
  const start = performance.now()
  await expect(client.assertHealth({timeout: 20})).rejects.toBeInstanceOf(AggregateError)
  expect(performance.now() - start).toBeLessThan(1000)
})
test('aborted and closed health checks do not send requests', async () => {
  const {client, calls} = fixture()
  await expect(client.assertHealth({signal: AbortSignal.abort()})).rejects.toBeDefined()
  expect(calls).toHaveLength(0)
  await client.shutdown()
  await expect(client.assertHealth()).rejects.toThrow('closed')
  expect(calls).toHaveLength(0)
})
test('native health probes contain no records and accept backend-specific acknowledgments', async () => {
  const bodies: Array<string> = []
  const client = new VictoriaClient({serviceName: 'health', endpoints: nativeEndpoints({
    logs: 'http://logs.test',
    metrics: 'http://metrics.test',
    traces: 'http://traces.test',
  }), fetch: async (url, init) => {
    bodies.push(textBody(init))
    return new Response(null, {status: url.includes('/api/v1/import') ? 204 : 200})
  }})
  clients.push(client)
  await client.assertHealth()
  expect(bodies.every(body => body.trim() === '' || body === '{"resourceSpans":[]}')).toBe(true)
})
test('SDK health uses empty protobuf without creating providers or periodic metrics', async () => {
  const requests: Array<Uint8Array> = []
  const client = new OpenTelemetryClient({serviceName: 'health-sdk', endpoint: 'http://collector.test', fetch: async (_url, init) => {
    requests.push(init.body as Uint8Array)
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-protobuf')
    return new Response(new Uint8Array, {headers: {'content-type': 'application/x-protobuf'}})
  }})
  try {
    await client.assertHealth()
    expect(requests).toHaveLength(3)
    expect(requests.every(body => body.byteLength === 0)).toBe(true)
    expect(client.status().pendingRecords).toBe(0)
  } finally {
    await client.shutdown()
  }
})
