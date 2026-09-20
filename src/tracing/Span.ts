import type {Attributes, Limits, SpanOptions, SpanRecord, SpanStatus, TraceContext} from '../types.ts'

import {attributes, clock, otlpAttributes, positiveInteger, timestamp, truncate, unixNano} from '../util.ts'
import {randomHex, traceparent, validateContext} from './context.ts'

const kinds = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
}
const statuses = {
  unset: 0,
  ok: 1,
  error: 2,
}
export default class Span implements TraceContext {
  readonly spanId: string
  readonly startTime: number
  readonly traceFlags: number
  readonly traceId: string
  #droppedEvents = 0
  #ended = false
  #events: SpanRecord['events'] = []
  readonly #kind: number
  readonly #maxAttributes: number
  readonly #maxBytes: number
  readonly #maxEvents: number
  readonly #parentSpanId?: string
  #values: Attributes
  constructor(readonly name: string, readonly send: (record: SpanRecord) => boolean, options: SpanOptions = {}, limits: Limits = {}, readonly now = clock, readonly sanitize?: (values: Attributes) => Attributes) {
    if (!name) {
      throw new TypeError('Span names must not be empty.')
    }
    const parent = options.parent ? validateContext(options.parent) : undefined
    this.traceId = parent?.traceId ?? randomHex(16)
    this.spanId = randomHex(8)
    this.traceFlags = parent?.traceFlags ?? 1
    this.#parentSpanId = parent?.spanId
    this.startTime = timestamp(options.startTime ?? now())
    this.#maxEvents = positiveInteger(limits.maxSpanEvents ?? 32, 'maxSpanEvents')
    this.#maxAttributes = positiveInteger(limits.maxAttributes ?? 64, 'maxAttributes')
    this.#maxBytes = positiveInteger(limits.maxAttributeBytes ?? 1024, 'maxAttributeBytes')
    this.#kind = kinds[options.kind ?? 'internal']
    if (!this.#kind) {
      throw new TypeError('Unknown span kind.')
    }
    this.#values = this.#sanitize(options.attributes ?? {})
  }
  addEvent(name: string, values: Attributes = {}, time = this.now()) {
    if (this.#ended) {
      return false
    }
    if (this.#events.length >= this.#maxEvents) {
      this.#droppedEvents++
      return false
    }
    this.#events.push({
      name: truncate(name, this.#maxBytes),
      timeUnixNano: unixNano(time),
      attributes: otlpAttributes(this.#sanitize(values)),
    })
    return true
  }
  end(status: SpanStatus = 'ok', values: Attributes = {}, time = this.now()) {
    if (this.#ended) {
      return false
    }
    if (!(status in statuses)) {
      throw new TypeError('Unknown span status.')
    }
    timestamp(time)
    if (time < this.startTime) {
      throw new RangeError('A span cannot end before it starts.')
    }
    this.setAttributes(values)
    this.#ended = true
    if (!(this.traceFlags & 1)) {
      return false
    }
    return this.send({
      traceId: this.traceId,
      spanId: this.spanId,
      traceFlags: this.traceFlags,
      parentSpanId: this.#parentSpanId,
      name: truncate(this.name, this.#maxBytes),
      kind: this.#kind,
      startTimeUnixNano: unixNano(this.startTime),
      endTimeUnixNano: unixNano(time),
      attributes: otlpAttributes(this.#values),
      status: {code: statuses[status]},
      events: this.#events,
      droppedEventsCount: this.#droppedEvents,
    })
  }
  setAttributes(values: Attributes) {
    if (!this.#ended) {
      this.#values = attributes({
        ...this.#values,
        ...this.#sanitize(values),
      }, this.#maxAttributes, this.#maxBytes)
    }
    return this
  }
  traceparent() {
    return traceparent(this)
  }
  #sanitize(values: Attributes) {
    return attributes(this.sanitize?.({...values}) ?? values, this.#maxAttributes, this.#maxBytes)
  }
}
