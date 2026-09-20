import type Span from '../tracing/Span.ts'
import type {LogOptions, SpanOptions} from '../types.ts'

import {AsyncLocalStorage} from 'node:async_hooks'

import {parseTraceparent, traceparent} from '../tracing/context.ts'
import VictoriaClient from '../VictoriaClient.ts'

/** Per-client async context, without installing global tracing hooks. */
class BunVictoriaClient extends VictoriaClient {
  readonly #context = new AsyncLocalStorage<Span>
  currentSpan() {
    return this.#context.getStore()
  }
  override log(message: string, options: LogOptions = {}) {
    return super.log(message, {
      ...options,
      context: options.context ?? this.currentSpan(),
    })
  }
  override startSpan(name: string, options: SpanOptions = {}) {
    return super.startSpan(name, {
      ...options,
      parent: options.parent ?? this.currentSpan(),
    })
  }
  traceHeaders() {
    const span = this.currentSpan()
    return span ? {traceparent: traceparent(span)} : {}
  }
  /** Ends the server span when the response stream finishes or is canceled, not when headers become available. */
  async traceRequest(request: Request, handler: (span: Span) => Promise<Response> | Response, name = 'http.server') {
    const url = new URL(request.url)
    const span = this.startSpan(name, {
      kind: 'server',
      parent: parseTraceparent(request.headers.get('traceparent')),
      attributes: {
        'http.request.method': request.method,
        'server.address': url.host,
        'url.path': url.pathname,
      },
    })
    let response: Response
    try {
      response = await this.#context.run(span, () => handler(span))
    } catch (error) {
      try {
        span.end('error', {'error.type': Error.isError(error) ? error.name : typeof error})
      } finally {
        throw error
      }
    }
    span.setAttributes({'http.response.status_code': response.status})
    const finish = () => span.end(response.status >= 500 ? 'error' : 'ok')
    if (!response.body) {
      finish()
      return response
    }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const context = this.#context
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await context.run(span, () => reader.read())
          if (result.done) {
            finish()
            reader.releaseLock()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          try {
            span.end('error', {'error.type': Error.isError(error) ? error.name : typeof error})
          } finally {
            controller.error(error)
          }
        }
      },
      async cancel(reason) {
        span.end('unset', {'http.request.canceled': true})
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  override wrap<T>(name: string, operation: (span: Span) => T, options: SpanOptions = {}): T {
    return super.wrap(name, span => this.#context.run(span, () => operation(span)), options)
  }
}

export default BunVictoriaClient
