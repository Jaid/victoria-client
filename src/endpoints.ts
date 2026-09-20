import type {Target} from './delivery/HttpTransport.ts'
import type {Signal} from './types.ts'

import OtlpJsonCodec from './codecs/OtlpJsonCodec.ts'
import VictoriaLogsCodec from './codecs/VictoriaLogsCodec.ts'
import VictoriaMetricsCodec from './codecs/VictoriaMetricsCodec.ts'
import {signals} from './types.ts'
import {normalizeUrl} from './util.ts'

export type Format = 'otlp-json' | 'victoria-json' | 'victoria-logs'
export type Endpoint = {
  acknowledgment?: 'otlp' | 'victoria'
  format: Format
  url: string
} | false | string
export type EndpointOptions = {
  endpoint?: string
  endpoints?: Partial<Record<Signal, Endpoint>>
}
export const appendPath = (base: string, path: string) => {
  const url = new URL(normalizeUrl(base))
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`
  return url.href
}
export function createTargets(options: EndpointOptions): Partial<Record<Signal, Target>> {
  const targets: Partial<Record<Signal, Target>> = {}
  for (const signal of signals) {
    const endpoint = options.endpoints?.[signal] ?? (options.endpoint ? appendPath(options.endpoint, `v1/${signal}`) : undefined)
    if (endpoint === false || endpoint === undefined) {
      continue
    }
    const {url, format} = typeof endpoint === 'string' ? {
      url: endpoint,
      format: 'otlp-json',
    } : endpoint
    if (!['otlp-json', 'victoria-json', 'victoria-logs'].includes(format) || format === 'victoria-json' && signal !== 'metrics' || format === 'victoria-logs' && signal !== 'logs') {
      throw new TypeError(`Invalid format for ${signal}: ${format}`)
    }
    const explicitAck = typeof endpoint === 'object' ? endpoint.acknowledgment : undefined
    const parsedUrl = new URL(url)
    const pathname = parsedUrl.pathname
    const nativeOtlp = pathname.endsWith(`/insert/opentelemetry/v1/${signal}`) || signal === 'metrics' && pathname.endsWith('/opentelemetry/v1/metrics')
    let codec = new OtlpJsonCodec(signal, explicitAck ?? (nativeOtlp ? 'victoria' : 'otlp')) as Target['codec']
    if (format === 'victoria-json') {
      codec = new VictoriaMetricsCodec
    } else if (format === 'victoria-logs') {
      codec = new VictoriaLogsCodec
    }
    targets[signal] = {
      url: normalizeUrl(url),
      codec,
    }
  }
  return targets
}
/** Explicit native Victoria base URLs, without private network defaults. */
export function nativeEndpoints(bases: Partial<Record<Signal, string>>): NonNullable<EndpointOptions['endpoints']> {
  const endpoints: NonNullable<EndpointOptions['endpoints']> = {}
  if (bases.logs) {
    const url = new URL(appendPath(bases.logs, 'insert/jsonline'))
    url.searchParams.set('_stream_fields', 'service.name')
    endpoints.logs = {
      url: url.href,
      format: 'victoria-logs',
    }
  }
  if (bases.metrics) {
    endpoints.metrics = {
      url: appendPath(bases.metrics, 'api/v1/import'),
      format: 'victoria-json',
    }
  }
  if (bases.traces) {
    endpoints.traces = appendPath(bases.traces, 'insert/opentelemetry/v1/traces')
  }
  return endpoints
}
