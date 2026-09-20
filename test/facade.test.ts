import {expect, test} from 'bun:test'

import {defaultOsServiceName} from '../src/defaults.ts'
import VictoriaClient from '../src/main.ts'
import {textBody, wireRecords} from './support.ts'

test('minimal constructor derives the OS service name and local OTLP endpoint', async () => {
  const originalArgv = process.argv
  try {
    process.argv = [String.raw`C:\portable\bun.exe`, String.raw`C:\apps\worker.ts`]
    expect(defaultOsServiceName()).toBe('worker.ts')
    const client = new VictoriaClient
    expect(client.resource['service.name']).toBe('worker.ts')
    expect(client.delivery.targets.logs?.url).toBe('http://localhost:4318/v1/logs')
    expect(client.delivery.targets.metrics?.url).toBe('http://localhost:4318/v1/metrics')
    expect(client.delivery.targets.traces?.url).toBe('http://localhost:4318/v1/traces')
    await client.shutdown()
    process.argv = [String.raw`C:\portable\bun.exe`]
    expect(defaultOsServiceName()).toBe('bun.exe')
    process.argv = []
    expect(defaultOsServiceName()).toBe('unknown')
  } finally {
    process.argv = originalArgv
  }
})
test('object constructor derives the OS service name when omitted', async () => {
  const originalArgv = process.argv
  try {
    process.argv = [String.raw`C:\portable\bun.exe`, String.raw`C:\apps\object-worker.ts`]
    const client = new VictoriaClient({
      endpoint: 'http://collector.test',
      interval: false,
    })
    expect(client.resource['service.name']).toBe('object-worker.ts')
    expect(client.options.serviceName).toBe('object-worker.ts')
    await client.shutdown()
  } finally {
    process.argv = originalArgv
  }
})
test('name-only constructor uses the local OTLP endpoint', async () => {
  const client = new VictoriaClient('worker')
  expect(client.resource['service.name']).toBe('worker')
  expect(client.delivery.targets.logs?.url).toBe('http://localhost:4318/v1/logs')
  await client.shutdown()
})
test('named constructor supports the usage sketch and starts delivery automatically', async () => {
  const calls: Array<{
    body: string
    url: string
  }> = []
  const client = new VictoriaClient('my-app', {
    host: 'http://collector.test/prefix',
    logs: {endpoint: 'logs'},
    metrics: {endpoint: 'metrics'},
    traces: {endpoint: 'traces'},
    interval: 5,
    fetch: async (url, init) => {
      calls.push({
        url,
        body: textBody(init),
      })
      return url.endsWith('/metrics') ? new Response(null, {status: 204}) : Response.json({})
    },
  })
  try {
    expect(client.pushMetric({
      ram_total: 1024,
      ram_free: 512,
    })).toBe(true)
    expect(client.pushTrace('weather-sensor.update', {
      sampleDuration: 89,
      degrees: {celsius: 20},
    })).toBe(true)
    client.log('Started')
    await Bun.sleep(30)
    expect(new Set(calls.map(call => call.url))).toEqual(new Set(['http://collector.test/prefix/logs', 'http://collector.test/prefix/metrics', 'http://collector.test/prefix/traces']))
    const span = wireRecords(calls.find(call => call.url.endsWith('/traces'))!.body, 'traces')[0]
    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano)
    expect(span.attributes).toContainEqual({
      key: 'degrees.celsius',
      value: {doubleValue: 20},
    })
    expect((await client.sync({timeout: 100})).complete).toBe(true)
  } finally {
    await client.shutdown()
  }
})
test('sync waits for transient retries rather than claiming completion during backoff', async () => {
  let calls = 0
  const client = new VictoriaClient('retry-test', {host: 'http://collector.test', metrics: false, traces: false, interval: false, initialRetry: 5, random: () => 0, fetch: async () => {
    calls++
    return calls === 1 ? new Response(null, {status: 503}) : Response.json({})
  }})
  try {
    client.info('retry')
    expect((await client.sync({timeout: 1000})).complete).toBe(true)
    expect(calls).toBe(2)
  } finally {
    await client.shutdown()
  }
})
test('sync rejects permanent loss and authentication pauses', async () => {
  for (const status of [400, 401]) {
    const client = new VictoriaClient('failed', {
      host: 'http://collector.test',
      interval: false,
      fetch: async () => new Response(null, {status}),
    })
    try {
      client.info('record')
      await expect(client.sync({timeout: 100})).rejects.toThrow(status === 400 ? 'rejected' : 'authentication')
    } finally {
      await client.shutdown({timeout: 5})
    }
  }
})
test('sync has a caller deadline even when joining a longer flush', async () => {
  const client = new VictoriaClient('deadline', {host: 'http://collector.test', interval: false, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
  })})
  try {
    client.info('pending')
    const long = client.flush({timeout: 1000})
    const started = performance.now()
    await expect(client.sync({timeout: 10})).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(500)
    await client.shutdown({timeout: 5})
    await long
  } finally {
    await client.shutdown()
  }
})
test('nested trace data rejects collisions and cycles, and supports explicit duration', async () => {
  const calls: Array<string> = []
  const client = new VictoriaClient('trace-data', {host: 'http://collector.test', interval: false, fetch: async (_url, init) => {
    calls.push(textBody(init))
    return Response.json({})
  }})
  try {
    expect(() => client.pushTrace('invalid', {
      a: {b: 1},
      'a.b': 2,
    })).toThrow('conflicting')
    const cycle: {value?: object} = {}
    cycle.value = cycle
    expect(() => client.pushTrace('cycle', cycle as never)).toThrow('nesting')
    client.pushTrace('measured', {duration: 25}, {
      time: 1000,
      duration: 25,
    })
    await client.sync()
    const [span] = wireRecords(calls[0], 'traces')
    expect(span.startTimeUnixNano).toBe('975000000')
    expect(span.endTimeUnixNano).toBe('1000000000')
  } finally {
    await client.shutdown()
  }
})
