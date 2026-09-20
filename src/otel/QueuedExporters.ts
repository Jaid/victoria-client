/* eslint-disable promise/prefer-await-to-callbacks -- OpenTelemetry exporter interfaces require a completion callback. */
import type DeliveryEngine from '../delivery/DeliveryEngine.ts'
import type {Signal} from '../types.ts'
import type {ExportResult} from '@opentelemetry/core'
import type {LogRecordExporter, ReadableLogRecord} from '@opentelemetry/sdk-logs'
import type {MetricData, PushMetricExporter, ResourceMetrics} from '@opentelemetry/sdk-metrics'
import type {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace'

import {ExportResultCode} from '@opentelemetry/core'
import {ProtobufLogsSerializer, ProtobufMetricsSerializer, ProtobufTraceSerializer} from '@opentelemetry/otlp-transformer'
import {AggregationTemporality} from '@opentelemetry/sdk-metrics'

abstract class QueuedExporter<Input> {
  #closed = false
  constructor(readonly delivery: DeliveryEngine, readonly signal: Signal) { }
  export(input: Input, callback: (result: ExportResult) => void) {
    let result: ExportResult
    try {
      if (this.#closed) {
        throw new Error('The SDK exporter is closed.')
      }
      if (this.delivery.targets[this.signal]) {
        const createdAt = Date.now()
        const items = this.serialize(input).map(body => ({
          signal: this.signal,
          body,
          records: 1,
          createdAt,
        }))
        if (!this.delivery.enqueueMany(items)) {
          throw new Error('The telemetry outbox rejected SDK data.')
        }
      }
      result = {code: ExportResultCode.SUCCESS}
    } catch (error) {
      result = {
        code: ExportResultCode.FAILED,
        error: Error.isError(error) ? error : new Error('SDK export failed.'),
      }
    }
    callback(result)
  }
  async forceFlush() { }
  abstract serialize(input: Input): Array<Uint8Array>
  async shutdown() {
    this.#closed = true
  }
}
const encoded = (value: Uint8Array | undefined) => {
  if (!value) {
    throw new Error('The official OTLP serializer produced no payload.')
  }
  return value
}
export class QueuedLogExporter extends QueuedExporter<Array<ReadableLogRecord>> implements LogRecordExporter {
  constructor(delivery: DeliveryEngine) {
    super(delivery, 'logs')
  }
  serialize(records: Array<ReadableLogRecord>) {
    return records.map(record => encoded(ProtobufLogsSerializer.serializeRequest([record])))
  }
}
export class QueuedSpanExporter extends QueuedExporter<Array<ReadableSpan>> implements SpanExporter {
  constructor(delivery: DeliveryEngine) {
    super(delivery, 'traces')
  }
  serialize(records: Array<ReadableSpan>) {
    return records.map(record => encoded(ProtobufTraceSerializer.serializeRequest([record])))
  }
}
export class QueuedMetricExporter extends QueuedExporter<ResourceMetrics> implements PushMetricExporter {
  constructor(delivery: DeliveryEngine) {
    super(delivery, 'metrics')
  }
  selectAggregationTemporality() {
    return AggregationTemporality.CUMULATIVE
  }
  serialize(input: ResourceMetrics) {
    const result: Array<Uint8Array> = []
    for (const scope of input.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
                    // Keep each point separable for byte limits and HTTP 413 recovery; preserve its SDK discriminant.
          const single = {
            ...metric,
            dataPoints: [point],
          } as MetricData
          result.push(encoded(ProtobufMetricsSerializer.serializeRequest({
            ...input,
            scopeMetrics: [{
              ...scope,
              metrics: [single],
            }],
          })))
        }
      }
    }
    return result
  }
}
