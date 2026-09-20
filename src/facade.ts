import type {Endpoint, Format} from './endpoints.ts'
import type {Attributes, AttributeValue, SpanStatus} from './types.ts'
import type {VictoriaClientOptions} from './VictoriaClient.ts'

import {appendPath} from './endpoints.ts'
import {positiveInteger} from './util.ts'

export type HostSignalOptions = {
  acknowledgment?: 'otlp' | 'victoria'
  endpoint?: string
  format?: Format
  path?: string
} | false | string
export type VictoriaHostOptions = Omit<VictoriaClientOptions, 'endpoint' | 'endpoints' | 'serviceName'> & {
  host: string
  logs?: HostSignalOptions
  metrics?: HostSignalOptions
  path?: string
  port?: number
  protocol?: 'http' | 'https'
  traces?: HostSignalOptions
}
export type TraceData = {readonly [key: string]: AttributeValue | TraceData}
export type PushTraceOptions = {
  duration?: number
  status?: SpanStatus
  time?: number
}
export type SyncOptions = {
  required?: boolean
  timeout?: number
}

export function hostOptions(serviceName: string, options: VictoriaHostOptions): VictoriaClientOptions {
  const {host, protocol, port, path: prefix, logs, metrics, traces, ...delivery} = options
  const base = new URL(host.includes('://') ? host : `${protocol ?? 'https'}://${host}`)
  if (protocol) {
    base.protocol = `${protocol}:`
  }
  if (port !== undefined) {
    base.port = String(positiveInteger(port, 'port', 65_535))
  }
  if (prefix) {
    base.pathname = `${base.pathname.replace(/\/+$/u, '')}/${prefix.replace(/^\/+/u, '')}`
  }
  const endpoint = (value: HostSignalOptions | undefined, path: string, format: Format): Endpoint => {
    if (value === false) {
      return false
    }
    const setting: Exclude<HostSignalOptions, false | string> | undefined = typeof value === 'string' ? {endpoint: value} : value
    if (setting?.endpoint !== undefined && setting.path !== undefined) {
      throw new TypeError('Specify either a signal path or endpoint, not both.')
    }
    const configured = setting?.endpoint ?? setting?.path
    const resolved = configured !== undefined ? new URL(configured, appendPath(base.href, '')) : new URL(appendPath(base.href, path))
    const url = resolved.href
    return {
      url,
      format: setting?.format ?? format,
      acknowledgment: setting?.acknowledgment ?? 'victoria',
    }
  }
  return {...delivery, serviceName, endpoints: {
    logs: endpoint(logs, 'v1/logs', 'otlp-json'),
    metrics: endpoint(metrics, 'api/v1/import', 'victoria-json'),
    traces: endpoint(traces, 'v1/traces', 'otlp-json'),
  }}
}

/** Flatten nested objects into dotted scalar attributes, with bounded depth and output. */
export function flattenAttributes(data: TraceData, maxAttributes: number): Attributes {
  const output = new Map<string, AttributeValue>
  const visit = (values: TraceData, prefix: string, depth: number) => {
    if (depth > 8) {
      throw new RangeError('Trace data exceeds eight nesting levels or contains a cycle.')
    }
    for (const [key, value] of Object.entries(values)) {
      if (output.size >= maxAttributes) {
        return
      }
      const name = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'object') {
        visit(value, name, depth + 1)
      } else {
        if (output.has(name)) {
          throw new TypeError(`Trace data has a conflicting flattened attribute: ${name}`)
        }
        output.set(name, value)
      }
    }
  }
  visit(data, '', 0)
  return Object.fromEntries(output)
}
