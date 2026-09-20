/* eslint-disable promise/prefer-await-to-then -- Concurrent flush callers share the exact same promise. */

import type {DeliveryOptions, DeliveryReport, FlushOptions, HealthOptions} from '../delivery/DeliveryEngine.ts'
import type {EndpointOptions} from '../endpoints.ts'
import type {SyncOptions} from '../facade.ts'
import type {Attributes} from '../types.ts'

import {resourceFromAttributes} from '@opentelemetry/resources'
import {BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor} from '@opentelemetry/sdk-logs'
import {MeterProvider, PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics'
import {BatchSpanProcessor, SimpleSpanProcessor, TracerProvider} from '@opentelemetry/sdk-trace'
import composeId from 'compose-id'

import OtlpJsonCodec from '../codecs/OtlpJsonCodec.ts'
import DeliveryEngine from '../delivery/DeliveryEngine.ts'
import {createTargets} from '../endpoints.ts'
import {abortable, isAborted, positiveInteger} from '../util.ts'
import ProtobufCodec from './ProtobufCodec.ts'
import {QueuedLogExporter, QueuedMetricExporter, QueuedSpanExporter} from './QueuedExporters.ts'

export type OpenTelemetryClientOptions = Omit<DeliveryOptions, 'targets'> & {
  cardinalityLimit?: number
  endpoint?: string
  endpoints?: Partial<Record<'logs' | 'metrics' | 'traces', {
    acknowledgment?: 'otlp' | 'victoria'
    url: string
  } | false | string>>
  exportInterval?: number
  exportTimeout?: number
  handoff?: 'batch' | 'immediate'
  resource?: Attributes
  sdkQueueSize?: number
  serviceName: string
}
/** Official SDK collection and protobuf serialization, with the same delivery engine as the portable API. */
class OpenTelemetryClient {
  readonly delivery: DeliveryEngine
  readonly #cardinality: number
  #flush?: Promise<DeliveryReport>
  #flushRequested = false
  readonly #interval: number
  readonly #queueSize: number
  #runtime?: ReturnType<OpenTelemetryClient['createRuntime']>
  #shutdown?: Promise<DeliveryReport>
  readonly #timeout: number
  constructor(readonly options: OpenTelemetryClientOptions) {
    if (!options.serviceName.trim()) {
      throw new TypeError('serviceName must not be empty.')
    }
    this.#interval = positiveInteger(options.exportInterval ?? 10_000, 'exportInterval', 2_147_483_647)
    this.#timeout = positiveInteger(options.exportTimeout ?? Math.min(2000, this.#interval), 'exportTimeout', 2_147_483_647)
    if (this.#timeout > this.#interval) {
      throw new RangeError('exportTimeout must be ≤ exportInterval.')
    }
    this.#queueSize = positiveInteger(options.sdkQueueSize ?? 1024, 'sdkQueueSize')
    this.#cardinality = positiveInteger(options.cardinalityLimit ?? 256, 'cardinalityLimit')
    if (options.handoff !== undefined && !['batch', 'immediate'].includes(options.handoff)) {
      throw new TypeError('Unknown SDK handoff policy.')
    }
    const endpointOptions: EndpointOptions = {
      endpoint: options.endpoint,
      endpoints: Object.fromEntries(Object.entries(options.endpoints ?? {}).map(([signal, endpoint]) => [signal, typeof endpoint === 'object' ? {
        ...endpoint,
        format: 'otlp-json',
      } : endpoint])),
    }
    const jsonTargets = createTargets(endpointOptions)
    const targets = Object.fromEntries(Object.entries(jsonTargets).map(([signal, target]) => [signal, {
      ...target,
      codec: new ProtobufCodec(signal as 'logs' | 'metrics' | 'traces', target.codec instanceof OtlpJsonCodec ? target.codec.acknowledgment : 'otlp'),
    }]))
    this.delivery = new DeliveryEngine({
      compression: 'gzip',
      ...options,
      targets,
    })
  }
  get logger() {
    return this.getRuntime().logger
  }
  get meter() {
    return this.getRuntime().meter
  }
  get tracer() {
    return this.getRuntime().tracer
  }
  assertHealth(options?: HealthOptions): Promise<void> {
    return this.delivery.assertHealth(options)
  }
  flush(options: FlushOptions = {}): Promise<DeliveryReport> {
    if (this.#shutdown) {
      return this.#shutdown
    }
    this.#flushRequested = true
    this.#flush ??= this.drain(options).finally(() => {
      this.#flush = undefined
    })
    return this.#flush
  }
  resume(signal?: 'logs' | 'metrics' | 'traces') {
    this.delivery.resume(signal)
  }
  setInterval(interval: false | number | null) {
    this.delivery.setInterval(interval)
    return this
  }
  shutdown(options: FlushOptions = {}): Promise<DeliveryReport> {
    if (this.#shutdown) {
      return this.#shutdown
    }
    const timeout = positiveInteger(options.timeout ?? 10_000, 'shutdown timeout', 2_147_483_647)
    this.#shutdown = this.finish(options, timeout)
    return this.#shutdown
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
  async sync(options: SyncOptions = {}): Promise<DeliveryReport | boolean> {
    positiveInteger(options.timeout ?? 10_000, 'sync timeout', 2_147_483_647)
    if (options.required === false) {
      try {
        await this.sync({
          ...options,
          required: true,
        })
        return true
      } catch {
        return false
      }
    }
    const timeout = positiveInteger(options.timeout ?? 10_000, 'sync timeout', 2_147_483_647)
    const deadline = performance.now() + timeout
    const previous = this.status()
    const report = await abortable(this.flush({timeout}), AbortSignal.timeout(timeout))
    const rejected = Object.values(report.signals).reduce((sum, state) => sum + state.rejected, 0) - Object.values(previous.signals).reduce((sum, state) => sum + state.rejected, 0)
    if (rejected) {
      throw new Error(`Telemetry sync rejected ${rejected} records during SDK handoff.`)
    }
    return this.delivery.sync({timeout: Math.max(1, Math.floor(deadline - performance.now()))})
  }
  private createRuntime() {
    const resource = resourceFromAttributes({
      ...this.options.resource,
      'service.name': this.options.serviceName,
      'service.instance.id': this.options.resource?.['service.instance.id'] ?? composeId(),
    })
    const batch = {
      maxQueueSize: this.#queueSize,
      maxExportBatchSize: Math.min(256, this.#queueSize),
      scheduledDelayMillis: this.#interval,
      exportTimeoutMillis: this.#timeout,
    }
    const logExporter = new QueuedLogExporter(this.delivery)
    const spanExporter = new QueuedSpanExporter(this.delivery)
    const logs = new LoggerProvider({
      resource,
      logRecordLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: 1024,
      },
      processors: [this.options.handoff === 'immediate' ? new SimpleLogRecordProcessor({exporter: logExporter}) : new BatchLogRecordProcessor({
        ...batch,
        exporter: logExporter,
      })],
    })
    const traces = new TracerProvider({
      resource,
      spanLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: 1024,
        eventCountLimit: 32,
      },
      spanProcessors: [this.options.handoff === 'immediate' ? new SimpleSpanProcessor({exporter: spanExporter}) : new BatchSpanProcessor({
        ...batch,
        exporter: spanExporter,
      })],
    })
    const metrics = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({
        exporter: new QueuedMetricExporter(this.delivery),
        exportIntervalMillis: this.#interval,
        exportTimeoutMillis: this.#timeout,
        cardinalityLimits: {default: this.#cardinality},
      })],
    })
    return {
      logs,
      traces,
      metrics,
      logger: logs.getLogger('victoria-client', '0.1.0'),
      tracer: traces.getTracer('victoria-client', '0.1.0'),
      meter: metrics.getMeter('victoria-client', '0.1.0'),
    }
  }
  private async drain(options: FlushOptions) {
    const timeout = positiveInteger(options.timeout ?? 10_000, 'flush timeout', 2_147_483_647)
    const deadline = performance.now() + timeout
    const abort = AbortSignal.timeout(timeout)
    do {
      this.#flushRequested = false
      if (this.#runtime) {
        await abortable(Promise.all([this.#runtime.logs.forceFlush({timeoutMillis: this.#timeout}), this.#runtime.traces.forceFlush({timeoutMillis: this.#timeout}), this.#runtime.metrics.forceFlush({timeoutMillis: this.#timeout})]), abort)
      }
      await this.delivery.flush({
        ...options,
        timeout: Math.max(1, Math.floor(deadline - performance.now())),
      })
    // eslint-disable-next-line typescript/no-unnecessary-condition -- A concurrent caller can request another handoff during an await.
    } while (this.#flushRequested && !isAborted(abort))
    return this.delivery.status()
  }
  private async finish(options: FlushOptions, timeout: number) {
    const deadline = performance.now() + timeout
    let sdkFailure: unknown
    try {
      if (this.#flush) {
        await abortable(this.#flush, AbortSignal.timeout(timeout))
      }
      if (this.#runtime) {
        const results = await abortable(Promise.allSettled([this.#runtime.logs.shutdown(), this.#runtime.traces.shutdown(), this.#runtime.metrics.shutdown()]), AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))))
        sdkFailure = results.find(result => result.status === 'rejected')
      }
    } catch (error) {
      sdkFailure = error
    }
    const report = await this.delivery.shutdown({
      ...options,
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
    })
    if (sdkFailure) {
      throw new Error('The OpenTelemetry SDK could not finish handing off all data before shutdown.', {cause: sdkFailure})
    }
    return report
  }
  private getRuntime() {
    if (this.#shutdown) {
      throw new Error('The OpenTelemetry client is shutting down or closed.')
    }
    return this.#runtime ??= this.createRuntime()
  }
}
export default OpenTelemetryClient
