import type {Signal} from '../types.ts'

import DeliveryError from '../delivery/DeliveryError.ts'
import {decoder, encode} from '../util.ts'
import Codec from './base/Codec.ts'
import partialSuccess from './partialSuccess.ts'

type Metric = {
  [key: string]: unknown
  description?: string
  name: string
  unit?: string
}
type Aggregation = {
  [key: string]: unknown
  dataPoints: Array<unknown>
}
type Scope = {
  [key: string]: unknown
  schemaUrl?: string
  scope: unknown
}
type Resource = {
  [key: string]: unknown
  resource: unknown
  schemaUrl?: string
}
type GroupedScope = {
  records: Array<unknown>
  schemaUrl?: string
  scope: unknown
}
const mergeMetrics = (records: ReadonlyArray<unknown>) => {
  const merged = new Map<string, Metric>
  for (const value of records) {
    const metric = value as Metric
    const kind = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'].find(key => metric[key] !== undefined)
    if (!kind) {
      throw new TypeError('An OTLP metric needs an aggregation.')
    }
    const {dataPoints, ...aggregation} = metric[kind] as Aggregation
    const {[kind]: _points, ...descriptor} = metric
    const key = JSON.stringify([descriptor, kind, aggregation])
    const previous = merged.get(key)
    if (previous) {
      (previous[kind] as Aggregation).dataPoints.push(...dataPoints)
    } else {
      merged.set(key, {
        ...metric,
        [kind]: {
          ...aggregation,
          dataPoints: [...dataPoints],
        },
      })
    }
  }
  return merged.values().toArray()
}
/** The payload boundary accepts complete requests produced by this package or an OTLP serializer. */
export default class OtlpJsonCodec extends Codec {
  readonly contentType = 'application/json'
  readonly id: string
  readonly root: string
  readonly successStatus = 200
  constructor(readonly signal: Signal, readonly acknowledgment: 'otlp' | 'victoria' = 'otlp') {
    super()
    this.id = `otlp-json:${signal}:${acknowledgment}:1`
    this.root = {
      logs: 'resourceLogs',
      metrics: 'resourceMetrics',
      traces: 'resourceSpans',
    }[signal]
  }
  accept(body: Uint8Array, contentType: string | null, records: number) {
    if (this.acknowledgment === 'victoria' && body.byteLength === 0 && (contentType === null || contentType.split(';')[0].trim().toLowerCase() === this.contentType)) {
      return {rejected: 0}
    }
    if (contentType?.split(';')[0].trim().toLowerCase() !== this.contentType) {
      throw new DeliveryError('Expected an OTLP JSON response.', 'permanent')
    }
    let value: unknown
    try {
      value = JSON.parse(decoder.decode(body))
    } catch {
      throw new DeliveryError('Invalid OTLP JSON response.', 'permanent')
    }
    return partialSuccess(value, this.signal, records)
  }
  combine(parts: ReadonlyArray<Uint8Array>) {
    const scopeKey = {
      logs: 'scopeLogs',
      metrics: 'scopeMetrics',
      traces: 'scopeSpans',
    }[this.signal]
    const recordsKey = {
      logs: 'logRecords',
      metrics: 'metrics',
      traces: 'spans',
    }[this.signal]
    const resources = new Map<string, {
      resource: unknown
      schemaUrl?: string
      scopes: Map<string, GroupedScope>
    }>
    for (const part of parts) {
      const request = JSON.parse(decoder.decode(part)) as Record<string, Array<Resource>>
      for (const resource of request[this.root]) {
        const resourceId = JSON.stringify([resource.resource, resource.schemaUrl])
        let resourceGroup = resources.get(resourceId)
        if (!resourceGroup) {
          resourceGroup = {
            resource: resource.resource,
            schemaUrl: resource.schemaUrl,
            scopes: new Map,
          }
          resources.set(resourceId, resourceGroup)
        }
        for (const scope of resource[scopeKey] as Array<Scope>) {
          const scopeId = JSON.stringify([scope.scope, scope.schemaUrl])
          let scopeGroup = resourceGroup.scopes.get(scopeId)
          if (!scopeGroup) {
            scopeGroup = {
              scope: scope.scope,
              schemaUrl: scope.schemaUrl,
              records: [],
            }
            resourceGroup.scopes.set(scopeId, scopeGroup)
          }
          scopeGroup.records.push(...scope[recordsKey] as Array<unknown>)
        }
      }
    }
    return encode({ [this.root]: Array.from(resources.values(), resource => ({
      resource: resource.resource,
      schemaUrl: resource.schemaUrl,
      [scopeKey]: Array.from(resource.scopes.values(), scope => ({
        scope: scope.scope,
        schemaUrl: scope.schemaUrl,
        [recordsKey]: this.signal === 'metrics' ? mergeMetrics(scope.records) : scope.records,
      })),
    })) })
  }
}
