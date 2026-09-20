import type {BrowserPage} from '../src/browser/main.ts'

import {expect, spyOn, test} from 'bun:test'

import BrowserVictoriaClient from '../src/browser/main.ts'
import {clients} from './support.ts'

test('minimal browser constructor derives service name from the current hostname', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://telemetry.example.com/page'),
  })
  try {
    const client = new BrowserVictoriaClient
    expect(client.resource['service.name']).toBe('telemetry.example.com')
    expect(client.delivery.targets.logs?.url).toBe('http://localhost:4318/v1/logs')
    expect(client.delivery.options.keepalive).toBe(true)
    expect(client.delivery.options.maxBatchBytes).toBe(16_000)
    expect(client.delivery.maxItemBytes).toBe(12_000)
    await client.shutdown()
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'location', descriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'location')
    }
  }
})
test('browser endpoints resolve relative to an explicit base and use bounded defaults', () => {
  const client = new BrowserVictoriaClient({
    serviceName: 'browser',
    baseUrl: 'https://app.test/page',
    endpoint: '/api/telemetry',
    endpoints: {metrics: false},
  })
  clients.push(client)
  expect(client.delivery.targets.logs?.url).toBe('https://app.test/api/telemetry/v1/logs')
  expect(client.delivery.targets.metrics).toBeUndefined()
  expect(client.delivery.options.keepalive).toBe(true)
  expect(client.delivery.options.maxBatchBytes).toBe(16_000)
  expect(client.delivery.maxItemBytes).toBe(12_000)
})
test('browser lifecycle flushes and shutdown removes listeners', async () => {
  const page = new EventTarget
  const document = new EventTarget
  Object.defineProperty(document, 'visibilityState', {value: 'hidden'})
  Object.assign(page, {document})
  const client = new BrowserVictoriaClient({
    serviceName: 'browser',
    endpoint: 'https://collector.test',
    interval: false,
    fetch: async () => Response.json({}),
  })
  clients.push(client)
  const flush = spyOn(client, 'flush')
  const firstCleanup = client.bindPage(page as unknown as BrowserPage)
  client.bindPage(page as unknown as BrowserPage)
  firstCleanup()
  document.dispatchEvent(new Event('visibilitychange'))
  page.dispatchEvent(new Event('pagehide'))
  page.dispatchEvent(new Event('pageshow'))
  await Bun.sleep(0)
  expect(flush).toHaveBeenCalledTimes(2)
  await client.shutdown({timeout: 5})
  document.dispatchEvent(new Event('visibilitychange'))
  page.dispatchEvent(new Event('pagehide'))
  expect(flush).toHaveBeenCalledTimes(2)
  flush.mockRestore()
})
test('browser lifecycle delivery failures do not become unhandled rejections', async () => {
  const page = Object.assign(new EventTarget, {document: new EventTarget})
  const client = new BrowserVictoriaClient({
    serviceName: 'browser',
    endpoint: 'https://collector.test',
    fetch: async () => {
      throw new Error('offline')
    },
  })
  clients.push(client)
  client.bindPage(page as unknown as BrowserPage)
  client.info('queued')
  page.dispatchEvent(new Event('pagehide'))
  await Bun.sleep(5)
  expect(client.status().signals.logs.records).toBe(1)
  await client.shutdown({timeout: 5})
  expect(() => page.dispatchEvent(new Event('pageshow'))).not.toThrow()
})
