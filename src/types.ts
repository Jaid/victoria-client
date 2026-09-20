export const signals = ['logs', 'metrics', 'traces'] as const
export type Signal = typeof signals[number]
export type AttributeValue = boolean | number | string
export type Attributes = Readonly<Record<string, AttributeValue>>
export type LogLevel = 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn'
export type TraceContext = {
  readonly spanId: string
  readonly traceFlags?: number
  readonly traceId: string
}
export type SpanKind = 'client' | 'consumer' | 'internal' | 'producer' | 'server'
export type SpanStatus = 'error' | 'ok' | 'unset'
export type LogOptions = {
  attributes?: Attributes
  context?: TraceContext
  level?: LogLevel
  time?: number
}
export type MetricOptions = {
  attributes?: Attributes
  time?: number
  unit?: string
}
export type SpanOptions = {
  attributes?: Attributes
  kind?: SpanKind
  parent?: TraceContext
  startTime?: number
}
export type Limits = {
  maxAttributeBytes?: number
  maxAttributes?: number
  maxSeries?: number
  maxSpanEvents?: number
}
export type SpanRecord = TraceContext & {
  attributes: Array<{
    key: string
    value: Record<string, unknown>
  }>
  droppedEventsCount: number
  endTimeUnixNano: string
  events: Array<{
    attributes: Array<{
      key: string
      value: Record<string, unknown>
    }>
    name: string
    timeUnixNano: string
  }>
  kind: number
  name: string
  parentSpanId?: string
  startTimeUnixNano: string
  status: {
    code: number
  }
}
