import type {BrowserPage} from '../src/browser/main.ts'

import {expect, spyOn, test} from 'bun:test'

import BrowserVictoriaClient from '../src/browser/main.ts'
import {clients, textBody, wireRecords} from './support.ts'

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
test('browser object constructor derives service name when omitted', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://object.example.com/page'),
  })
  try {
    const client = new BrowserVictoriaClient({
      endpoint: 'https://collector.test',
      interval: false,
    })
    expect(client.resource['service.name']).toBe('object.example.com')
    expect(client.options.serviceName).toBe('object.example.com')
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
  const dispatch = spyOn(client.delivery, 'dispatch')
  const firstCleanup = client.bindPage(page as unknown as BrowserPage)
  client.bindPage(page as unknown as BrowserPage)
  firstCleanup()
  document.dispatchEvent(new Event('visibilitychange'))
  page.dispatchEvent(new Event('pagehide'))
  page.dispatchEvent(new Event('pageshow'))
  await Bun.sleep(0)
  expect(dispatch).toHaveBeenCalledTimes(2)
  await client.shutdown({timeout: 5})
  document.dispatchEvent(new Event('visibilitychange'))
  page.dispatchEvent(new Event('pagehide'))
  expect(dispatch).toHaveBeenCalledTimes(2)
  dispatch.mockRestore()
})
const stalledPage = () => {
  const page = Object.assign(new EventTarget, {document: new EventTarget})
  const bodies: Array<string> = []
  const keepalive: Array<boolean | undefined> = []
  const releases: Array<() => void> = []
  const client = new BrowserVictoriaClient({
    serviceName: 'browser',
    endpoint: 'https://collector.test',
    interval: false,
    fetch: async (_url, init) => {
      bodies.push(textBody(init))
      keepalive.push(init.keepalive)
      await new Promise<void>(resolve => releases.push(resolve))
      return Response.json({})
    },
  })
  clients.push(client)
  client.bindPage(page as unknown as BrowserPage)
  const release = () => {
    for (const resolve of releases.splice(0)) {
      resolve()
    }
  }
  return {
    page,
    client,
    bodies,
    keepalive,
    release,
  }
}
const messages = (bodies: ReadonlyArray<string>) => bodies.flatMap(body => wireRecords(body).map(record => record.body?.stringValue))
test('pagehide sends what queued up behind a request in flight and what later pagehide listeners write', async () => {
  const {page, client, bodies, keepalive, release} = stalledPage()
  page.addEventListener('pagehide', () => {
    client.info('closing')
  })
  client.info('first')
  const draining = client.flush()
  await Bun.sleep(0)
  client.info('queued behind first')
  page.dispatchEvent(new Event('pagehide'))
  await Bun.sleep(0)
  // Nothing has answered yet, like on a page that is already gone.
  expect(messages(bodies)).toEqual(['first', 'queued behind first', 'closing'])
  expect(keepalive).toEqual([true, true, true])
  release()
  await draining
  await client.flush()
  expect(bodies).toHaveLength(3)
  expect(client.status().signals.logs).toMatchObject({
    records: 0,
    sent: 3,
  })
})
test('pageshow ends immediate dispatching', async () => {
  const {page, client, bodies, release} = stalledPage()
  page.dispatchEvent(new Event('pagehide'))
  page.dispatchEvent(new Event('pageshow'))
  client.info('back')
  await Bun.sleep(0)
  expect(bodies).toHaveLength(0)
  release()
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
