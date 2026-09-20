/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- wrap() must preserve synchronous return and throw behavior. */
import type {DeliveryOptions, DeliveryReport, FlushOptions, HealthOptions} from './delivery/DeliveryEngine.ts'
import type {EndpointOptions} from './endpoints.ts'
import type {PushTraceOptions, SyncOptions, TraceData, VictoriaHostOptions} from './facade.ts'
import type {Attributes, Limits, LogLevel, LogOptions, MetricOptions, Signal, SpanOptions} from './types.ts'

import composeId from 'compose-id'

import OtlpJsonCodec from './codecs/OtlpJsonCodec.ts'
import VictoriaLogsCodec from './codecs/VictoriaLogsCodec.ts'
import VictoriaMetricsCodec from './codecs/VictoriaMetricsCodec.ts'
import {defaultEndpoint, defaultOsServiceName} from './defaults.ts'
import DeliveryEngine from './delivery/DeliveryEngine.ts'
import {createTargets} from './endpoints.ts'
import {flattenAttributes, hostOptions} from './facade.ts'
import {validateContext} from './tracing/context.ts'
import Span from './tracing/Span.ts'
import {attributes, canonical, clock, encode, encoder, otlpAttributes, positiveInteger, stringifyLabel, timestamp, unixNano} from './util.ts'

export type VictoriaClientOptions = Omit<DeliveryOptions, 'targets'> & EndpointOptions & Limits & {
  minLogLevel?: LogLevel
  resource?: Attributes
    /** Runs before attribute limits and persistence. Never receives request headers. */
  sanitizeAttributes?: (values: Attributes, signal: Signal) => Attributes
  serviceName?: string
}
type ResolvedVictoriaClientOptions = Omit<VictoriaClientOptions, 'serviceName'> & {
  serviceName: string
}
const severity: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
}
type Series = {
  startTime: number
  value: number
}
/** Portable collection API. No global providers, hidden environment defaults or constructor-time network requests. */
class VictoriaClient {
  readonly delivery: DeliveryEngine
  readonly now: () => number
  readonly options: ResolvedVictoriaClientOptions
  readonly resource: Attributes
  #closed = false
  readonly #descriptors = new Map<string, string>
  readonly #maxAttributeBytes: number
  readonly #maxAttributes: number
  readonly #maxSeries: number
  readonly #resourceAttributes
  readonly #series = new Map<string, Series>
  #seriesDropped = 0
  constructor()
  constructor(serviceName: string)
  constructor(options: VictoriaClientOptions)
  constructor(serviceName: string, options: VictoriaHostOptions)
  constructor(nameOrOptions?: VictoriaClientOptions | string, host?: VictoriaHostOptions) {
    let options: VictoriaClientOptions
    if (typeof nameOrOptions === 'string') {
      options = host === undefined ? {
        serviceName: nameOrOptions,
        endpoint: defaultEndpoint,
      } : hostOptions(nameOrOptions, host)
    } else {
      options = nameOrOptions ?? {
        serviceName: defaultOsServiceName(),
        endpoint: defaultEndpoint,
      }
    }
    const resolvedOptions: ResolvedVictoriaClientOptions = {
      ...options,
      serviceName: options.serviceName ?? defaultOsServiceName(),
    }
    this.options = resolvedOptions
    if (!resolvedOptions.serviceName.trim()) {
      throw new TypeError('serviceName must not be empty.')
    }
    this.#maxAttributes = positiveInteger(options.maxAttributes ?? 64, 'maxAttributes')
    this.#maxAttributeBytes = positiveInteger(options.maxAttributeBytes ?? 1024, 'maxAttributeBytes')
    this.#maxSeries = positiveInteger(options.maxSeries ?? 1024, 'maxSeries')
    positiveInteger(options.maxSpanEvents ?? 32, 'maxSpanEvents')
    if (options.minLogLevel !== undefined && !Object.hasOwn(severity, options.minLogLevel)) {
      throw new TypeError('Unknown log level.')
    }
    this.resource = Object.freeze(attributes({
      ...resolvedOptions.resource,
      'service.name': resolvedOptions.serviceName,
      'service.instance.id': resolvedOptions.resource?.['service.instance.id'] ?? composeId(),
    }, this.#maxAttributes, this.#maxAttributeBytes))
    this.#resourceAttributes = otlpAttributes(this.resource)
    this.now = resolvedOptions.now ?? clock
    this.delivery = new DeliveryEngine({
      ...resolvedOptions,
      targets: createTargets(resolvedOptions),
    })
  }
  assertHealth(options?: HealthOptions): Promise<void> {
    return this.delivery.assertHealth(options)
  }
  collectionStatus() {
    return {
      series: this.#series.size,
      droppedSeries: this.#seriesDropped,
      maxSeries: this.#maxSeries,
    }
  }
  count(name: string, amount = 1, options: MetricOptions = {}) {
    return this.#metric(name, amount, 'counter', options)
  }
  debug(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'debug',
      attributes: values,
    })
  }
  error(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'error',
      attributes: values,
    })
  }
  fatal(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'fatal',
      attributes: values,
    })
  }
  flush(options?: FlushOptions) {
    return this.delivery.flush(options)
  }
  info(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'info',
      attributes: values,
    })
  }
  log(message: string, options: LogOptions = {}) {
    if (this.#closed || !this.delivery.targets.logs) {
      return false
    }
    const level = options.level ?? 'info'
    if (!Object.hasOwn(severity, level)) {
      throw new TypeError('Unknown log level.')
    }
    if (severity[level] < severity[this.options.minLogLevel ?? 'info']) {
      return false
    }
    const time = timestamp(options.time ?? this.now())
    const values = this.#attributes(options.attributes, 'logs')
    const context = options.context ? validateContext(options.context) : undefined
    const date = new Date(time)
    const body = this.delivery.targets.logs.codec instanceof VictoriaLogsCodec ? encoder.encode(`${JSON.stringify({
      ...this.resource,
      ...values,
      _msg: message,
      _time: date.toISOString(),
      level,
      trace_id: context?.traceId,
      span_id: context?.spanId,
    })}\n`) : this.#otlp('logs', {
      timeUnixNano: unixNano(time),
      observedTimeUnixNano: unixNano(this.now()),
      severityNumber: severity[level],
      severityText: level.toUpperCase(),
      body: {stringValue: message},
      attributes: otlpAttributes(values),
      traceId: context?.traceId,
      spanId: context?.spanId,
      flags: context?.traceFlags,
    })
    return this.delivery.enqueue('logs', body)
  }
  metric(name: string, value: number, options: MetricOptions = {}) {
    return this.#metric(name, value, 'gauge', options)
  }
  pushMetric(values: Readonly<Record<string, number>>, options: MetricOptions = {}) {
    const admitted = Object.entries(values).map(([name, value]) => this.metric(name, value, options))
    return admitted.every(Boolean)
  }
  pushTrace(name: string, data: TraceData = {}, options: PushTraceOptions = {}) {
    const time = options.time ?? this.now()
    const duration = options.duration ?? 0
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError('duration must be finite and nonnegative.')
    }
    const span = this.startSpan(name, {
      startTime: time - duration,
      attributes: flattenAttributes(data, this.#maxAttributes),
    })
    return span.end(options.status ?? 'ok', {}, time)
  }
  resume(signal?: Signal) {
    this.delivery.resume(signal)
  }
  setInterval(interval: false | number | null) {
    this.delivery.setInterval(interval)
    return this
  }
  shutdown(options?: FlushOptions) {
    this.#closed = true
    return this.delivery.shutdown(options)
  }
  startSpan(name: string, options: SpanOptions = {}) {
    return new Span(name, record => {
      if (this.#closed || !this.delivery.targets.traces) {
        return false
      }
      if (!(this.delivery.targets.traces.codec instanceof OtlpJsonCodec)) {
        throw new TypeError('The portable trace API requires OTLP JSON.')
      }
      const {traceFlags, ...data} = record
      return this.delivery.enqueue('traces', this.#otlp('traces', {
        ...data,
        flags: traceFlags,
      }))
    }, options, this.options, this.now, values => this.#attributes(values, 'traces'))
  }
  status() {
    return this.delivery.status()
  }
  async [Symbol.asyncDispose]() {
    await this.shutdown()
  }
  sync(options: SyncOptions & {required: false}): Promise<boolean>
  sync(options?: SyncOptions & {required?: true}): Promise<DeliveryReport>
  sync(options: SyncOptions): Promise<DeliveryReport | boolean>
  sync(options?: SyncOptions) {
    return this.delivery.sync(options ?? {})
  }
  trace(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'trace',
      attributes: values,
    })
  }
  warn(message: string, values?: Attributes) {
    return this.log(message, {
      level: 'warn',
      attributes: values,
    })
  }
  wrap<T>(name: string, operation: (span: Span) => T, options: SpanOptions = {}): T {
    return this.#wrap(name, operation, options)
  }
  #attributes(values: Attributes | undefined, signal: Signal) {
    const input = {...values}
    return attributes(this.options.sanitizeAttributes?.(input, signal) ?? input, this.#maxAttributes, this.#maxAttributeBytes)
  }
  #isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
      return false
    }
    return typeof (value as {then?: unknown}).then === 'function'
  }
  #metric(name: string, value: number, kind: 'counter' | 'gauge', options: MetricOptions) {
    if (this.#closed || !this.delivery.targets.metrics) {
      return false
    }
    if (!name || !Number.isFinite(value) || kind === 'counter' && value < 0) {
      throw new TypeError('Metrics need a name and a finite value; counters must not decrease.')
    }
    const unit = options.unit ?? '1'
    const descriptor = `${kind}:${unit}`
    if (this.#descriptors.has(name) && this.#descriptors.get(name) !== descriptor) {
      throw new TypeError(`Metric ${name} already has a different kind or unit.`)
    }
    const values = this.#attributes(options.attributes, 'metrics')
    const labels = Object.fromEntries(Object.entries({
      ...this.resource,
      ...values,
      __name__: name,
    }).map(([key, labelValue]) => [key, stringifyLabel(labelValue)]))
    const native = this.delivery.targets.metrics.codec instanceof VictoriaMetricsCodec
    const key = native ? canonical(labels) : JSON.stringify([name, canonical(values)])
    const time = timestamp(options.time ?? this.now())
    let series = this.#series.get(key)
    if (!series) {
      if (this.#series.size >= this.#maxSeries) {
        this.#seriesDropped++
        return false
      }
      series = {
        value: 0,
        startTime: time,
      }
      this.#series.set(key, series)
      this.#descriptors.set(name, descriptor)
    }
    if (kind === 'counter') {
      if (!Number.isFinite(series.value + value)) {
        throw new RangeError('The cumulative counter overflowed.')
      }
      series.value += value
      value = series.value
    }
    const point = {
      attributes: otlpAttributes(values),
      timeUnixNano: unixNano(time),
      startTimeUnixNano: unixNano(series.startTime),
      asDouble: value,
    }
    const body = native ? encoder.encode(`${JSON.stringify({
      metric: labels,
      timestamps: [Math.trunc(time)],
      values: [value],
    })}\n`) : this.#otlp('metrics', {
      name,
      unit,
      ...kind === 'counter' ? { sum: {
        dataPoints: [point],
        aggregationTemporality: 2,
        isMonotonic: true,
      } } : {gauge: {dataPoints: [point]}},
    })
    return this.delivery.enqueue('metrics', body)
  }
  #otlp(signal: Signal, record: unknown) {
    const root = {
      logs: 'resourceLogs',
      metrics: 'resourceMetrics',
      traces: 'resourceSpans',
    }[signal]
    const scope = {
      logs: 'scopeLogs',
      metrics: 'scopeMetrics',
      traces: 'scopeSpans',
    }[signal]
    const records = {
      logs: 'logRecords',
      metrics: 'metrics',
      traces: 'spans',
    }[signal]
    return encode({ [root]: [{
      resource: {attributes: this.#resourceAttributes},
      [scope]: [{
        scope: {
          name: 'victoria-client',
          version: '0.1.0',
        },
        [records]: [record],
      }],
    }] })
  }
  #wrap<T>(name: string, operation: (span: Span) => T, options: SpanOptions): T {
    const span = this.startSpan(name, options)
    try {
      const result = operation(span)
      if (this.#isPromiseLike(result)) {
        return Promise.resolve(result).then(value => {
          span.end()
          return value
        }, error => {
          try {
            span.end('error', {'error.type': Error.isError(error) ? error.name : typeof error})
          } finally {
            throw error
          }
        }) as T
      }
      span.end()
      return result
    } catch (error) {
      try {
        span.end('error', {'error.type': Error.isError(error) ? error.name : typeof error})
      } finally {
        throw error
      }
    }
  }
}
export default VictoriaClient
