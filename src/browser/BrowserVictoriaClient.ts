import type {FlushOptions} from '../delivery/DeliveryEngine.ts'
import type {Endpoint} from '../endpoints.ts'
import type {VictoriaHostOptions} from '../facade.ts'
import type {VictoriaClientOptions} from '../VictoriaClient.ts'

import {defaultBrowserServiceName, defaultEndpoint} from '../defaults.ts'
import VictoriaClient from '../VictoriaClient.ts'

export type BrowserVictoriaClientOptions = VictoriaClientOptions & {
  /** Base URL for relative endpoints; defaults to the current page URL. */
  baseUrl?: string
}
export type BrowserPage = Pick<Window, 'addEventListener' | 'document'>

const browserOptions = (options: BrowserVictoriaClientOptions): VictoriaClientOptions => {
  const {baseUrl = typeof location === 'undefined' ? undefined : location.href, ...rest} = options
  const serviceName = options.serviceName ?? defaultBrowserServiceName()
  const resolve = (url: string) => {
    const resolved = new URL(url, baseUrl)
    return resolved.href
  }
  const endpoint = (value: Endpoint): Endpoint => {
    if (value === false) {
      return false
    }
    return typeof value === 'string' ? resolve(value) : {
      ...value,
      url: resolve(value.url),
    }
  }
  return {
    keepalive: true,
    maxBatchBytes: 16_000,
    maxItemBytes: 12_000,
    ...rest,
    serviceName,
    endpoint: options.endpoint === undefined ? undefined : resolve(options.endpoint),
    endpoints: Object.fromEntries(Object.entries(options.endpoints ?? {}).map(([signal, value]) => [signal, endpoint(value)])),
  }
}
/** Browser lifecycle integration without global listeners at module import time. */
class BrowserVictoriaClient extends VictoriaClient {
  #page?: AbortController

  constructor()
  constructor(serviceName: string)
  constructor(options: BrowserVictoriaClientOptions)
  constructor(serviceName: string, options: VictoriaHostOptions)
  constructor(nameOrOptions?: BrowserVictoriaClientOptions | string, options?: VictoriaHostOptions) {
    if (typeof nameOrOptions === 'string' && options) {
      super(nameOrOptions, {
        keepalive: true,
        maxBatchBytes: 16_000,
        maxItemBytes: 12_000,
        ...options,
      })
    } else {
      const objectOptions = typeof nameOrOptions === 'string' ? {
        serviceName: nameOrOptions,
        endpoint: defaultEndpoint,
      } : nameOrOptions ?? {
        serviceName: defaultBrowserServiceName(),
        endpoint: defaultEndpoint,
      }
      super(browserOptions(objectOptions))
    }
    if (typeof window !== 'undefined') {
      this.bindPage(globalThis)
    }
  }

  /** Rebinding replaces the previous attachment. The returned cleanup is idempotent. */
  bindPage(page: BrowserPage = globalThis) {
    this.#page?.abort()
    const controller = new AbortController
    this.#page = controller
    const options = {signal: controller.signal}
    page.document.addEventListener('visibilitychange', () => {
      if (page.document.visibilityState === 'hidden') {
        this.flushPage()
      }
    }, options)
    page.addEventListener('pagehide', () => this.flushPage(), options)
    return () => {
      controller.abort()
      if (this.#page === controller) {
        this.#page = undefined
      }
    }
  }

  override shutdown(options?: FlushOptions) {
    this.#page?.abort()
    this.#page = undefined
    return super.shutdown(options)
  }

  private flushPage() {
    // eslint-disable-next-line promise/prefer-await-to-then -- Page lifecycle callbacks cannot await asynchronous delivery.
    this.flush().catch(() => {})
  }
}

export default BrowserVictoriaClient
