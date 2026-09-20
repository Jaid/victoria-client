import type {Signal} from '../src/types.ts'

import {expect, test} from 'bun:test'

import BunVictoriaClient from '../src/bun/main.ts'
import {textBody, wireRecords} from './support.ts'

function fixture() {
  const requests: Array<{
    body: string
    signal: Signal
  }> = []
  const client = new BunVictoriaClient({ serviceName: 'bun-test', endpoint: 'http://collector.test', fetch: async (url, init) => {
    requests.push({
      signal: url.split('/').at(-1) as Signal,
      body: textBody(init),
    })
    return Response.json({})
  } })
  return {
    client,
    requests,
  }
}
test('wrap preserves synchronous return values and async-local context', async () => {
  const {client} = fixture()
  try {
    const result = client.wrap('sync', span => {
      expect(client.currentSpan()).toBe(span)
      client.info('sync')
      return 42
    })
    expect(result).toBe(42)
    expect(client.currentSpan()).toBeUndefined()
  } finally {
    await client.shutdown({timeout: 5})
  }
})
test('async context isolates concurrent operations and automatically correlates logs', async () => {
  const {client, requests} = fixture()
  try {
    await Promise.all(['alpha', 'beta'].map(name => client.wrap(name, async parent => {
      await Bun.sleep(1)
      await client.wrap(`${name}.child`, async child => {
        expect(client.currentSpan()).toBe(child)
        await Bun.sleep(1)
        client.info(name)
      })
      expect(client.currentSpan()).toBe(parent)
      expect(client.traceHeaders().traceparent).toContain(parent.traceId)
    })))
    expect(client.currentSpan()).toBeUndefined()
    await client.flush()
    const spans = wireRecords(requests.find(request => request.signal === 'traces')!.body, 'traces')
    const logs = wireRecords(requests.find(request => request.signal === 'logs')!.body)
    for (const name of ['alpha', 'beta']) {
      const parent = spans.find(span => span.name === name)!
      const child = spans.find(span => span.name === `${name}.child`)!
      expect(child.parentSpanId).toBe(parent.spanId)
      expect(logs.find(log => log.body?.stringValue === name)?.traceId).toBe(parent.traceId)
    }
    expect(new Set(spans.filter(span => !span.parentSpanId).map(span => span.traceId)).size).toBe(2)
  } finally {
    await client.shutdown()
  }
})
test('server spans include streamed response lifetime and incoming traceparent', async () => {
  const {client, requests} = fixture()
  const stream = new TransformStream<Uint8Array, Uint8Array>
  const writer = stream.writable.getWriter()
  try {
    const response = await client.traceRequest(new Request('http://server.test/path?secret=hidden', {
      headers: {traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'},
    }), () => new Response(stream.readable))
    await client.flush()
    expect(requests).toHaveLength(0)
    const text = response.text()
    await writer.write((new TextEncoder).encode('streamed'))
    expect(client.status().signals.traces.records).toBe(0)
    await writer.close()
    expect(await text).toBe('streamed')
    await client.flush()
    const [span] = wireRecords(requests[0].body, 'traces')
    expect(span.parentSpanId).toBe('1234567890abcdef')
    expect(span.traceId).toBe('1234567890abcdef1234567890abcdef')
    expect(requests[0].body).not.toContain('hidden')
  } finally {
    await client.shutdown()
  }
})
test('canceled server response ends a span once and cancels the original reader', async () => {
  const {client, requests} = fixture()
  const canceled: Array<boolean> = []
  try {
    const response = await client.traceRequest(new Request('http://server.test'), () => new Response(new ReadableStream<Uint8Array>({cancel() {
      canceled.push(true)
    }})))
    await response.body!.cancel()
    await client.flush()
    const spans = wireRecords(requests[0].body, 'traces')
    expect(spans).toHaveLength(1)
    expect(spans[0].status?.code).toBe(0)
    expect(canceled).toEqual([true])
  } finally {
    await client.shutdown()
  }
})
test('server exceptions remain the original exception without exporting their text', async () => {
  const {client, requests} = fixture()
  const failure = new Error('private exception')
  try {
    await expect(client.traceRequest(new Request('http://server.test'), () => {
      throw failure
    })).rejects.toBe(failure)
    await client.flush()
    expect(wireRecords(requests[0].body, 'traces')[0].status?.code).toBe(2)
    expect(requests[0].body).not.toContain('private exception')
  } finally {
    await client.shutdown()
  }
})
