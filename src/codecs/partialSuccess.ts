import type {Signal} from '../types.ts'

import DeliveryError from '../delivery/DeliveryError.ts'
import {object} from '../util.ts'

const invalid = () => new DeliveryError('Invalid OTLP export response.', 'permanent')

export default function partialSuccess(value: unknown, signal: Signal, records: number) {
  if (!object(value)) {
    throw invalid()
  }
  const partial = value.partialSuccess
  if (partial === undefined) {
    return {rejected: 0}
  }
  if (!object(partial)) {
    throw invalid()
  }
  const field = {
    logs: 'rejectedLogRecords',
    metrics: 'rejectedDataPoints',
    traces: 'rejectedSpans',
  }[signal]
  const count = partial[field] === undefined ? 0 : partial[field]
  if (typeof count !== 'number' && typeof count !== 'string' || typeof count === 'string' && !/^\d+$/u.test(count)) {
    throw invalid()
  }
  const rejected = Number(count)
  if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > records || partial.errorMessage !== undefined && typeof partial.errorMessage !== 'string') {
    throw invalid()
  }
    // Do not expose server-controlled content, which can echo payloads or credentials.
  return {
    rejected,
    warning: partial.errorMessage ? 'The collector reported an OTLP partial-success warning.' : undefined,
  }
}
