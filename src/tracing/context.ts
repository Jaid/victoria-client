import type {TraceContext} from '../types.ts'

export const randomHex = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)).toHex()
export const validateContext = (context: TraceContext): TraceContext => {
  if (!/^[\da-f]{32}$/u.test(context.traceId) || !/^[\da-f]{16}$/u.test(context.spanId) || /^0+$/u.test(context.traceId) || /^0+$/u.test(context.spanId)) {
    throw new TypeError('Trace context requires nonzero lowercase hexadecimal IDs.')
  }
  const flags = context.traceFlags ?? 1
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) {
    throw new TypeError('traceFlags must be a byte.')
  }
  return Object.freeze({
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: flags,
  })
}
export const parseTraceparent = (value: string | null | undefined): TraceContext | undefined => {
  const match = value && /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/u.exec(value.trim())
  if (!match) {
    return
  }
  try {
    return validateContext({
      traceId: match[1],
      spanId: match[2],
      traceFlags: Number.parseInt(match[3], 16),
    })
  } catch {}
}
export const traceparent = (context: TraceContext) => {
  const valid = validateContext(context)
  return `00-${valid.traceId}-${valid.spanId}-${valid.traceFlags!.toString(16).padStart(2, '0')}`
}
