/* eslint-disable promise/prefer-await-to-then -- Preserve shared flush/shutdown promise identity and synchronous timer callbacks. */
import type {SyncOptions} from '../facade.ts'
import type Outbox from '../storage/base/Outbox.ts'
import type {OutboxItem, PendingItem} from '../storage/base/Outbox.ts'
import type {Signal} from '../types.ts'
import type {HeadersSource, HttpTransportOptions, Target} from './HttpTransport.ts'

import {emptyLane} from '../storage/base/Outbox.ts'
import MemoryOutbox from '../storage/MemoryOutbox.ts'
import {signals} from '../types.ts'
import {abortable, isAborted, normalizeUrl, positiveInteger, routeFingerprint} from '../util.ts'
import DeliveryError from './DeliveryError.ts'
import HttpTransport from './HttpTransport.ts'

export type DeliveryEvent = {
  message?: string
  records?: number
  signal?: Signal
  type: 'blocked' | 'error' | 'expired' | 'overflow' | 'rejected' | 'retry' | 'sent'
}
export type DeliveryOptions = Partial<HttpTransportOptions> & {
  initialRetry?: number
  interval?: false | number | null
  maxAge?: number
  maxAttempts?: number
  maxBatchBytes?: number
  maxBatchItems?: number
  maxItemBytes?: number
  maxRetry?: number
  now?: () => number
  onEvent?: (event: DeliveryEvent) => void
  outbox?: Outbox
  random?: () => number
  signalHeaders?: Partial<Record<Signal, HeadersSource>>
  targets: Partial<Record<Signal, Target>>
}
export type HealthOptions = {
  signal?: AbortSignal
  /** Overall deadline across all configured signals, in milliseconds. */
  timeout?: number
}
export type FlushOptions = {
  throwOnPending?: boolean
  timeout?: number
}
export type SignalStatus = {
  admitted: number
  attempts: number
  blocked: boolean
  bytes: number
  dropped: number
  items: number
  lastError?: string
  oldestAt?: number
  records: number
  rejected: number
  requests: number
  retryAt: number
  sent: number
  sentBytes: number
  through?: number
}
export type DeliveryReport = {
  complete: boolean
  pendingRecords: number
  signals: Record<Signal, SignalStatus>
}
type Totals = Pick<SignalStatus, 'admitted' | 'dropped' | 'rejected' | 'requests' | 'sent' | 'sentBytes'>
const activeOutboxes = new WeakSet<Outbox>
const emptyTotals = (): Totals => ({
  admitted: 0,
  sent: 0,
  rejected: 0,
  dropped: 0,
  requests: 0,
  sentBytes: 0,
})
export default class DeliveryEngine {
  readonly maxItemBytes: number
  readonly outbox: Outbox
  readonly targets: Partial<Record<Signal, Target>>
  #accepting = true
  readonly #batchBytes: number
  readonly #batchItems: number
  #closed = false
  #controller?: AbortController
  #finalReport?: DeliveryReport
  #interval: false | number
  readonly #maxAge: number
  readonly #maxAttempts: number
  readonly #now: () => number
  readonly #random: () => number
  #requestedThrough = 0
  readonly #retryInitial: number
  readonly #retryMax: number
  #running?: Promise<DeliveryReport>
  #shutdown?: Promise<DeliveryReport>
  #timer?: ReturnType<typeof setTimeout>
  readonly #totals: Record<Signal, Totals> = {
    logs: emptyTotals(),
    metrics: emptyTotals(),
    traces: emptyTotals(),
  }
  readonly #transport: HttpTransport
  constructor(readonly options: DeliveryOptions) {
    this.targets = Object.freeze(Object.fromEntries(Object.entries(options.targets).map(([signal, target]) => [signal, {
      ...target,
      headers: target.headers ?? options.signalHeaders?.[signal as Signal],
      url: normalizeUrl(target.url),
    }])))
    if (!Object.keys(this.targets).length) {
      throw new TypeError('At least one telemetry endpoint must be configured.')
    }
    this.#now = options.now ?? Date.now
    this.#random = options.random ?? Math.random
    const interval = options.interval === undefined ? 1000 : options.interval
    this.#interval = this.#normalizeInterval(interval)
    this.#batchItems = positiveInteger(options.maxBatchItems ?? 256, 'maxBatchItems')
    this.#batchBytes = positiveInteger(options.maxBatchBytes ?? 256_000, 'maxBatchBytes')
    this.maxItemBytes = positiveInteger(options.maxItemBytes ?? Math.min(64_000, this.#batchBytes), 'maxItemBytes')
    if (this.maxItemBytes > this.#batchBytes) {
      throw new RangeError('maxItemBytes must be ≤ maxBatchBytes.')
    }
    this.#maxAge = positiveInteger(options.maxAge ?? 7 * 24 * 60 * 60 * 1000, 'maxAge')
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? Number.MAX_SAFE_INTEGER, 'maxAttempts')
    this.#retryInitial = positiveInteger(options.initialRetry ?? 1000, 'initialRetry', 2_147_483_647)
    this.#retryMax = positiveInteger(options.maxRetry ?? 60_000, 'maxRetry', 2_147_483_647)
    if (this.#retryMax < this.#retryInitial) {
      throw new RangeError('maxRetry must be ≥ initialRetry.')
    }
    this.#transport = new HttpTransport({
      ...options,
      timeout: positiveInteger(options.timeout ?? 5000, 'timeout', 2_147_483_647),
      maxResponseBytes: positiveInteger(options.maxResponseBytes ?? 64_000, 'maxResponseBytes'),
      compressionThreshold: positiveInteger(options.compressionThreshold ?? 1024, 'compressionThreshold'),
    })
    if (options.compression !== undefined && !([false, 'gzip'] as ReadonlyArray<unknown>).includes(options.compression)) {
      throw new TypeError('Unsupported compression format.')
    }
    this.outbox = options.outbox ?? new MemoryOutbox
    if (activeOutboxes.has(this.outbox)) {
      throw new Error('The outbox is already owned by another delivery engine.')
    }
    const fingerprint = routeFingerprint(JSON.stringify(signals.map(signal => {
      const target = this.targets[signal]
      return [signal, target?.url, target?.codec.id]
    })))
    this.outbox.bind(fingerprint)
    activeOutboxes.add(this.outbox)
    this.#schedule()
  }
  /** Probe ingestion without enqueuing observations or changing retry state. */
  async assertHealth(options: HealthOptions = {}): Promise<void> {
    if (!this.#accepting || this.#closed) {
      throw new Error('The client is shutting down or closed.')
    }
    const timeout = positiveInteger(options.timeout ?? this.#transport.options.timeout, 'health timeout', 2_147_483_647)
    const deadline = AbortSignal.timeout(timeout)
    const abort = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    abort.throwIfAborted()
    const failures: Array<Error> = []
    await Promise.all(signals.map(async signal => {
      const target = this.targets[signal]
      if (!target) {
        return
      }
      try {
        const result = await this.#transport.send(target, target.codec.combine([]), 0, abort)
        if (result.rejected || result.warning) {
          throw new Error('The endpoint did not fully accept the health probe.')
        }
      } catch (error) {
        // Do not expose arbitrary fetch/header-factory errors, URLs or credentials.
        const detail = error instanceof DeliveryError ? error.message : 'The endpoint health probe failed.'
        failures.push(new Error(`Telemetry ${signal} is unhealthy: ${detail}`))
      }
    }))
    if (failures.length) {
      throw new AggregateError(failures, 'Victoria health check failed.')
    }
  }
  enqueue(signal: Signal, body: Uint8Array, records = 1) {
    return this.enqueueMany([{
      signal,
      body,
      records,
      createdAt: this.#now(),
    }])
  }
  enqueueMany(items: ReadonlyArray<PendingItem>) {
    if (!this.#accepting || this.#closed) {
      return false
    }
    if (!items.length) {
      return true
    }
    for (const item of items) {
      if (!this.targets[item.signal]) {
        throw new TypeError(`No endpoint is configured for ${item.signal}.`)
      }
      positiveInteger(item.records, 'records')
      if (!Number.isFinite(item.createdAt)) {
        throw new TypeError('createdAt must be finite.')
      }
      if (!item.body.byteLength || item.body.byteLength > this.maxItemBytes) {
        this.#dropIncoming(items, 'A payload exceeded maxItemBytes.')
        return false
      }
    }
    if (!this.outbox.append(items)) {
      this.#dropIncoming(items, 'The telemetry outbox is full.')
      return false
    }
    for (const item of items) {
      this.#totals[item.signal].admitted += item.records
    }
    return true
  }
  /** A bounded barrier over admitted work. Drains every ready batch without ignoring backoff. */
  flush(options: FlushOptions = {}): Promise<DeliveryReport> {
    if (this.#closed) {
      return Promise.resolve(this.status())
    }
    const timeout = positiveInteger(options.timeout ?? 10_000, 'flush timeout', 2_147_483_647)
    this.#requestedThrough = Math.max(this.#requestedThrough, this.outbox.highWater())
    if (!this.#running) {
      const controller = new AbortController
      this.#controller = controller
      const timer = setTimeout(() => controller.abort(), timeout)
      this.#running = this.#drain(controller.signal).finally(() => {
        clearTimeout(timer)
        this.#running = undefined
        this.#controller = undefined
      })
    }
    if (!options.throwOnPending) {
      return this.#running
    }
    return this.#running.then(report => {
      if (!report.complete) {
        throw new Error(`Telemetry delivery is incomplete: ${report.pendingRecords} records remain queued.`)
      }
      return report
    })
  }
    /** Use after correcting credentials. Dynamic headers are resolved again for the next request. */
  resume(signal?: Signal) {
    if (this.#closed) {
      throw new Error('The client is closed.')
    }
    for (const name of signal ? [signal] : signals) {
      const lane = this.outbox.lane(name)
      this.outbox.defer(name, {
        ...lane,
        blocked: false,
        attempts: 0,
        retryAt: 0,
        lastError: undefined,
      })
    }
  }
  setInterval(interval: false | number | null) {
    if (this.#closed || !this.#accepting) {
      throw new Error('The client is shutting down or closed.')
    }
    this.#interval = this.#normalizeInterval(interval)
    this.#stopScheduler()
    this.#schedule()
    return this
  }
  shutdown(options: FlushOptions = {}): Promise<DeliveryReport> {
    if (this.#shutdown) {
      return this.#shutdown
    }
    const timeout = positiveInteger(options.timeout ?? 10_000, 'shutdown timeout', 2_147_483_647)
    this.#accepting = false
    this.#stopScheduler()
    this.#shutdown = this.#finish(timeout)
    if (options.throwOnPending) {
      this.#shutdown = this.#shutdown.then(report => {
        if (!report.complete) {
          throw new Error(`Shutdown left ${report.pendingRecords} undelivered records.`)
        }
        return report
      })
    }
    return this.#shutdown
  }
  status(): DeliveryReport {
    if (this.#closed) {
      if (!this.#finalReport) {
        throw new Error('Final telemetry status is unavailable because outbox storage failed.')
      }
      return structuredClone(this.#finalReport)
    }
    const state = Object.fromEntries(signals.map(signal => [signal, {
      ...this.outbox.stats(signal),
      ...this.outbox.lane(signal),
      ...this.#totals[signal],
    }])) as Record<Signal, SignalStatus>
    const pendingRecords = signals.reduce((n, signal) => n + state[signal].records, 0)
    return {
      complete: pendingRecords === 0,
      pendingRecords,
      signals: state,
    }
  }
  async [Symbol.asyncDispose]() {
    await this.shutdown()
  }
  /** Admission is synchronous. A successful durable admission is committed before this method returns. */
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
    const before = this.status()
    const rejectedBefore = signals.reduce((sum, signal) => sum + before.signals[signal].rejected, 0)
    do {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()))
      const report = await abortable(this.flush({timeout: remaining}), AbortSignal.timeout(remaining))
      const rejected = signals.reduce((sum, signal) => sum + report.signals[signal].rejected, 0) - rejectedBefore
      if (rejected) {
        throw new Error(`Telemetry sync rejected ${rejected} records. Inspect status and dead-letter diagnostics.`)
      }
      if (report.complete) {
        return report
      }
      if (this.#closed) {
        throw new Error('Telemetry sync cannot drain a closed client.')
      }
      const eligible = signals.filter(signal => report.signals[signal].records && !report.signals[signal].blocked)
      if (!eligible.length) {
        throw new Error('Telemetry sync is paused for authentication. Correct credentials and resume first.')
      }
      const wait = Math.max(1, Math.min(...eligible.map(signal => Math.max(0, report.signals[signal].retryAt - this.#now())), deadline - performance.now()))
      await new Promise(resolve => setTimeout(resolve, wait))
    } while (performance.now() < deadline)
    throw new Error(`Telemetry sync timed out with ${this.status().pendingRecords} records pending.`)
  }
  async #drain(abort: AbortSignal) {
    let through: number
    do {
      through = this.#requestedThrough
      const results = await Promise.allSettled(signals.map(signal => this.#drainSignal(signal, through, abort)))
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) {
        throw new AggregateError(failures.map(failure => failure.reason as unknown), 'Telemetry delivery failed in local storage or encoding.')
      }
    } while (this.#requestedThrough > through && !isAborted(abort))
    return this.status()
  }
  async #drainSignal(signal: Signal, through: number, abort: AbortSignal) {
    const target = this.targets[signal]
    if (!target) {
      return
    }
    while (!isAborted(abort)) {
      let lane = this.outbox.lane(signal)
      if (lane.blocked || lane.retryAt > this.#now()) {
        return
      }
      let items = this.outbox.peek(signal, Math.min(lane.through ?? through, through), this.#batchItems)
      if (!items.length) {
        if (lane.through !== undefined) {
          this.outbox.defer(signal, emptyLane())
          continue
        }
        return
      }
      const expired = items.filter(item => this.#now() - item.createdAt >= this.#maxAge)
      if (expired.length) {
        this.#reject(signal, expired, 'Queued telemetry exceeded maxAge.', 'expired')
        continue
      }
      // Bound pre-encoding work too; codecs may otherwise assemble many large records before splitting.
      let rawBytes = 0
      const bounded: Array<OutboxItem> = []
      for (const item of items) {
        if (bounded.length && rawBytes + item.body.byteLength > this.#batchBytes) {
          break
        }
        bounded.push(item)
        rawBytes += item.body.byteLength
      }
      items = bounded
      let body = target.codec.combine(items.map(item => item.body))
      while (body.byteLength > this.#batchBytes && items.length > 1) {
        items = items.slice(0, Math.ceil(items.length / 2))
        body = target.codec.combine(items.map(item => item.body))
      }
      if (body.byteLength > this.#batchBytes) {
        this.#reject(signal, items, 'Encoded telemetry exceeded maxBatchBytes.')
        continue
      }
      lane = {
        ...lane,
        through: items.at(-1)!.id,
      }
      this.outbox.defer(signal, lane)
      const records = items.reduce((n, item) => n + item.records, 0)
      this.#totals[signal].requests++
      let result: Awaited<ReturnType<HttpTransport['send']>>
      try {
        result = await this.#transport.send(target, body, records, abort)
      } catch (error) {
        // Deadline cancellation leaves the queued batch unchanged.
        if (isAborted(abort)) {
          return
        }
        const failure = error instanceof DeliveryError ? error : new DeliveryError('Telemetry export failed.', 'retry')
        if (failure.kind === 'authentication') {
          this.outbox.defer(signal, {
            ...lane,
            blocked: true,
            lastError: failure.message,
          })
          this.#emit({
            type: 'blocked',
            signal,
            records,
            message: failure.message,
          })
          return
        }
        if (failure.kind === 'too-large' && target.codec.splitOn413 && items.length > 1) {
          this.outbox.defer(signal, {
            ...lane,
            through: items[Math.ceil(items.length / 2) - 1].id,
            lastError: failure.message,
          })
          continue
        }
        if (failure.kind !== 'retry') {
          this.#reject(signal, items, failure.message)
          continue
        }
        const attempts = lane.attempts + 1
        if (attempts >= this.#maxAttempts) {
          this.#reject(signal, items, 'Telemetry exhausted maxAttempts.')
          continue
        }
        const base = Math.min(this.#retryMax, this.#retryInitial * 2 ** Math.min(attempts - 1, 30))
        const jitter = Math.max(0, Math.min(1, this.#random())) * 0.2 * base
        const delay = Math.max(failure.retryAfter, base + jitter)
        this.outbox.defer(signal, {
          ...lane,
          attempts,
          retryAt: this.#now() + delay,
          lastError: failure.message,
        })
        this.#emit({
          type: 'retry',
          signal,
          records,
          message: failure.message,
        })
        return
      }
      this.outbox.settle(signal, items, result.rejected || result.warning ? {
        signal,
        reason: result.warning ?? 'The collector partially rejected telemetry.',
        records: result.rejected,
        bytes: 0,
        time: this.#now(),
      } : undefined)
      this.#totals[signal].sent += records - result.rejected
      this.#totals[signal].rejected += result.rejected
      this.#totals[signal].sentBytes += result.bytes
      this.#emit({
        type: 'sent',
        signal,
        records: records - result.rejected,
        message: result.warning,
      })
    }
  }
  #dropIncoming(items: ReadonlyArray<PendingItem>, message: string) {
    for (const item of items) {
      this.#totals[item.signal].dropped += item.records
    }
    this.#emit({
      type: 'overflow',
      records: items.reduce((n, item) => n + item.records, 0),
      message,
    })
  }
  #emit(event: DeliveryEvent) {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Observation callbacks cannot interrupt delivery.
    }
  }
  async #finish(timeout: number) {
    const deadline = performance.now() + timeout
    try {
            // Interrupt a longer existing flush so shutdown owns the remaining time budget.
      this.#controller?.abort()
      if (this.#running) {
        await this.#running
      }
      let report = this.status()
      while (report.pendingRecords && performance.now() < deadline) {
        report = await this.flush({timeout: Math.max(1, Math.floor(deadline - performance.now()))})
        if (!report.pendingRecords) {
          break
        }
        const ready = signals.filter(signal => report.signals[signal].records && !report.signals[signal].blocked)
        if (!ready.length) {
          break
        }
        const wait = Math.max(1, Math.min(...ready.map(signal => Math.max(0, report.signals[signal].retryAt - this.#now())), deadline - performance.now()))
        await new Promise(resolve => setTimeout(resolve, wait))
      }
      return report
    } finally {
      try {
        this.#finalReport = this.status()
      } finally {
        this.#closed = true
        activeOutboxes.delete(this.outbox)
        this.outbox.close()
      }
    }
  }
  #normalizeInterval(interval: false | number | null) {
    if (!interval) {
      return false
    }
    return positiveInteger(interval, 'interval', 2_147_483_647)
  }
  #reject(signal: Signal, items: ReadonlyArray<OutboxItem>, reason: string, type: 'expired' | 'rejected' = 'rejected') {
    const records = items.reduce((n, item) => n + item.records, 0)
    this.outbox.settle(signal, items, {
      signal,
      reason,
      records,
      bytes: items.reduce((n, item) => n + item.body.byteLength, 0),
      time: this.#now(),
    })
    this.#totals[signal].rejected += records
    this.#emit({
      type,
      signal,
      records,
      message: reason,
    })
  }
  #schedule() {
    if (this.#interval === false || this.#closed || !this.#accepting || this.#timer) {
      return
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush().catch(() => this.#emit({
        type: 'error',
        message: 'Telemetry flushing failed. Check outbox ownership and storage availability.',
      })).finally(() => this.#schedule())
    }, this.#interval);
    (this.#timer as unknown as {
      unref?: () => void
    }).unref?.()
  }
  #stopScheduler() {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
