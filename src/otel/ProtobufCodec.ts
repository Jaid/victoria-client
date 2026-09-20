import type {Signal} from '../types.ts'

import {ProtobufLogsSerializer, ProtobufMetricsSerializer, ProtobufTraceSerializer} from '@opentelemetry/otlp-transformer'

import Codec from '../codecs/base/Codec.ts'
import partialSuccess from '../codecs/partialSuccess.ts'
import DeliveryError from '../delivery/DeliveryError.ts'
import {concat} from '../util.ts'

/** OTLP export requests contain repeated resource fields, so protobuf concatenation preserves every resource. */
export default class ProtobufCodec extends Codec {
  readonly contentType = 'application/x-protobuf'
  readonly id: string
  readonly successStatus = 200
  constructor(readonly signal: Signal, readonly acknowledgment: 'otlp' | 'victoria' = 'otlp') {
    super()
    this.id = `otlp-protobuf:${signal}:${acknowledgment}:1`
  }
  accept(body: Uint8Array, contentType: string | null, records: number) {
    if (this.acknowledgment === 'victoria' && body.byteLength === 0 && (contentType === null || contentType.split(';')[0].trim().toLowerCase() === this.contentType)) {
      return {rejected: 0}
    }
    if (contentType?.split(';')[0].trim().toLowerCase() !== this.contentType) {
      throw new DeliveryError('Expected an OTLP protobuf response.', 'permanent')
    }
    const serializer = {
      logs: ProtobufLogsSerializer,
      metrics: ProtobufMetricsSerializer,
      traces: ProtobufTraceSerializer,
    }[this.signal]
    let value: unknown
    try {
      value = serializer.deserializeResponse(body)
    } catch {
      throw new DeliveryError('Invalid OTLP protobuf response.', 'permanent')
    }
    return partialSuccess(value, this.signal, records)
  }
  combine(parts: ReadonlyArray<Uint8Array>) {
    return concat(parts)
  }
}
