import type {VictoriaClientOptions} from '../src/main.ts'
import type {Signal} from '../src/types.ts'

import {afterEach} from 'bun:test'

import VictoriaClient from '../src/main.ts'

export type WireRecord = {
  attributes?: Array<{
    key: string
    value: {
      boolValue?: boolean
      doubleValue?: number
      stringValue?: string
    }
  }>
  body?: {
    stringValue: string
  }
  droppedEventsCount?: number
  endTimeUnixNano?: string
  events?: Array<{
    name: string
  }>
  flags?: number
  gauge?: {
    dataPoints: Array<{
      asDouble: number
    }>
  }
  name?: string
  parentSpanId?: string
  severityNumber?: number
  spanId?: string
  startTimeUnixNano?: string
  status?: {
    code: number
  }
  sum?: {
    aggregationTemporality: number
    dataPoints: Array<{
      asDouble: number
      startTimeUnixNano: string
    }>
  }
  timeUnixNano?: string
  traceId?: string
}
export const wireRecords = (body: string, signal: Signal = 'logs'): Array<WireRecord> => {
  const [root, scope, rows] = {
    logs: ['resourceLogs', 'scopeLogs', 'logRecords'],
    metrics: ['resourceMetrics', 'scopeMetrics', 'metrics'],
    traces: ['resourceSpans', 'scopeSpans', 'spans'],
  }[signal]
  const data = JSON.parse(body) as Record<string, Array<Record<string, Array<Record<string, Array<WireRecord>>>>>>
  return data[root].flatMap(resource => resource[scope].flatMap(group => group[rows]))
}
export const textBody = (init: RequestInit) => (new TextDecoder).decode(init.body as Uint8Array)
export const clients: Array<VictoriaClient> = []
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.shutdown({timeout: 5}).catch(() => { })
  }
})
export function fixture(options: Partial<VictoriaClientOptions> = {}) {
  let now = 1_789_865_200_000
  const calls: Array<{
    body: string
    init: RequestInit
    url: string
  }> = []
  const client = new VictoriaClient({
    serviceName: 'test',
    endpoint: 'http://collector.test',
    now: () => now,
    random: () => 0,
    fetch: async (url, init) => {
      calls.push({
        url,
        init,
        body: textBody(init),
      })
      return Response.json({})
    },
    ...options,
  })
  clients.push(client)
  return {
    client,
    calls,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}
