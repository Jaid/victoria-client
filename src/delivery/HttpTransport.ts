/* eslint-disable promise/prefer-await-to-then -- Late-response cleanup and stream cancellation must not delay the bounded request. */
import type Codec from '../codecs/base/Codec.ts'

import {abortable, concat} from '../util.ts'
import DeliveryError from './DeliveryError.ts'

export type HeadersSource = (() => Readonly<Record<string, string>>) | Readonly<Record<string, string>>
export type Target = {
  codec: Codec
  headers?: HeadersSource
  url: string
}
export type HttpTransportOptions = {
  compression?: 'gzip' | false
  compressionThreshold?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  headers?: HeadersSource
  keepalive?: boolean
  maxResponseBytes: number
  timeout: number
}
const headersFrom = (source?: HeadersSource) => {
  return typeof source === 'function' ? source() : source ?? {}
}
export const retryAfter = (value: string | null, now = Date.now()) => {
  if (!value) {
    return 0
  }
  const delay = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}
const cancel = (body: ReadableStream<Uint8Array> | null) => {
  const cancellation = body?.cancel()
  if (cancellation) {
    void cancellation.catch(() => {})
  }
}
async function gzip(body: Uint8Array, signal: AbortSignal) {
  if (typeof Bun !== 'undefined') {
    signal.throwIfAborted()
    const compressed = Bun.gzipSync(new Uint8Array(body))
    signal.throwIfAborted()
    return compressed
  }
  const blob = new Blob([new Uint8Array(body)])
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'))
  const compressionResponse = new Response(stream)
  return new Uint8Array(await abortable(compressionResponse.arrayBuffer(), signal))
}
async function readBounded(response: Response, limit: number, signal: AbortSignal) {
  if (!response.body) {
    return new Uint8Array
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const parts: Array<Uint8Array> = []
  let bytes = 0
  try {
    while (true) {
      const result = await abortable(reader.read(), signal)
      if (result.done) {
        return concat(parts)
      }
      bytes += result.value.byteLength
      if (bytes > limit) {
        throw new DeliveryError('The collector response exceeded the configured byte limit.', 'permanent')
      }
      parts.push(result.value)
    }
  } finally {
    void reader.cancel().catch(() => { })
    reader.releaseLock()
  }
}
export default class HttpTransport {
  constructor(readonly options: HttpTransportOptions) { }
  async send(target: Target, body: Uint8Array, records: number, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.options.timeout)])
    const headers = new Headers(headersFrom(this.options.headers))
    for (const [name, value] of Object.entries(headersFrom(target.headers))) {
      headers.set(name, value)
    }
    headers.set('Content-Type', target.codec.contentType)
    headers.delete('Content-Encoding')
    let payload = body
    if (this.options.compression === 'gzip' && body.byteLength >= (this.options.compressionThreshold ?? 1024)) {
      const compressed = await gzip(body, signal)
      if (compressed.byteLength < body.byteLength) {
        payload = compressed
        headers.set('Content-Encoding', 'gzip')
      }
    }
    let response: Response
    try {
      const request = (this.options.fetch ?? globalThis.fetch)(target.url, {
        method: 'POST',
        body: new Uint8Array(payload),
        headers,
        signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        keepalive: this.options.keepalive === true && payload.byteLength <= 16_000,
      })
            // A caller-supplied fetch must honor cancellation. Dispose late responses defensively.
      void request.then(result => {
        if (signal.aborted) {
          cancel(result.body)
        }
      }, () => {})
      response = await abortable(request, signal)
    } catch {
      throw new DeliveryError('Telemetry request failed or timed out.', 'retry')
    }
    if (response.status !== target.codec.successStatus) {
      const delay = retryAfter(response.headers.get('Retry-After'))
      cancel(response.body)
      const status = response.status
      let kind: import('./DeliveryError.ts').FailureKind = 'permanent'
      if (status === 401 || status === 403) {
        kind = 'authentication'
      } else if (status === 413) {
        kind = 'too-large'
      } else if (target.codec.retryableStatuses.includes(status)) {
        kind = 'retry'
      }
      throw new DeliveryError(`Telemetry endpoint returned HTTP ${status}; expected ${target.codec.successStatus}.`, kind, delay, status)
    }
    let bytes: Uint8Array
    try {
      bytes = await readBounded(response, this.options.maxResponseBytes, signal)
    } catch (error) {
      if (error instanceof DeliveryError) {
        throw error
      }
      throw new DeliveryError('Telemetry response failed or timed out.', 'retry')
    }
    return {
      ...target.codec.accept(bytes, response.headers.get('Content-Type'), records),
      bytes: payload.byteLength,
    }
  }
}
