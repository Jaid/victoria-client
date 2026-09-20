/* eslint-disable promise/prefer-await-to-then -- Abort races must attach rejection handlers synchronously, including to already-aborted operations. */
import type {Attributes} from './types.ts'

export const encoder = new TextEncoder
export const decoder = new TextDecoder
export const encode = (value: unknown) => encoder.encode(JSON.stringify(value))
export const clock = () => performance.timeOrigin + performance.now()
export const isAborted = (signal: AbortSignal) => signal.aborted
export const positiveInteger = (value: number, name: string, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer ≤ ${maximum}.`)
  }
  return value
}
export const timestamp = (value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new RangeError('Time must be a nonnegative Unix-millisecond timestamp.')
  }
  return value
}
export const unixNano = (time: number) => {
  timestamp(time)
  return (BigInt(Math.trunc(time)) * 1_000_000n + BigInt(Math.round(time % 1 * 1_000_000))).toString()
}
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
export const truncate = (value: string, bytes: number) => {
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= bytes) {
    return value
  }
  const truncationDecoder = new TextDecoder
  return truncationDecoder.decode(encoded.subarray(0, bytes), {stream: true})
}
export const attributes = (input: Attributes = {}, maxCount = 64, maxBytes = 1024): Attributes => Object.fromEntries(Object.entries(input).slice(0, maxCount).map(([key, value]) => {
  if (!key || encoder.encode(key).byteLength > maxBytes) {
    throw new TypeError('Attribute keys must be nonempty and fit the attribute byte limit.')
  }
  if (!['boolean', 'number', 'string'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Invalid attribute: ${key}`)
  }
  return [key, typeof value === 'string' ? truncate(value, maxBytes) : value]
}))
const attributeValue = (value: boolean | number | string) => {
  if (typeof value === 'boolean') {
    return {boolValue: value}
  }
  if (typeof value === 'number') {
    return {doubleValue: value}
  }
  return {stringValue: value}
}
export const otlpAttributes = (input: Attributes) => Object.entries(input).map(([key, value]) => ({
  key,
  value: attributeValue(value),
}))
const compareEntries = ([a]: [string, unknown], [b]: [string, unknown]) => {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}
export const canonical = (input: Record<string, unknown>) => JSON.stringify(Object.entries(input).toSorted(compareEntries))
export const normalizeUrl = (value: string) => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Endpoints must be HTTP(S) URLs without embedded credentials or fragments.')
  }
  return url.href
}
/** An accidental-routing guard, not cryptographic authentication. No endpoint secrets are stored. */
export const routeFingerprint = (value: string) => {
  let a = 0x81_1C_9D_C5
  let b = 0x9E_37_79_B9
  for (const byte of encoder.encode(value)) {
    a = Math.imul(a ^ byte, 0x01_00_01_93)
    b = Math.imul(b ^ byte, 0x85_EB_CA_6B)
  }
  return `v1:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}
export const stringifyLabel = String
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, {once: true})
    void promise.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- Both settlement branches must remove the abort listener synchronously.
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    }).catch(reject)
    if (signal.aborted) {
      abort()
    }
  })
}
