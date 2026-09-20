<center><a href="https://npmjs.com/package/victoria-client"><img src="https://shieldcn.dev/npm/v/victoria-client.svg?variant=secondary&logo=npm&label=latest+version" alt="Latest version on npm"/></a> <a href="https://github.com/Jaid/victoria-client/raw/HEAD/license.txt"><img src="https://shieldcn.dev/github/license/Jaid/victoria-client.svg?variant=secondary" alt="License"/></a></center>

# VictoriaClient

powerful abstractions for collecting and pushing data to VictoriaLogs, VictoriaTraces and VictoriaMetrics

## intro

Shared collection and delivery for VictoriaLogs, VictoriaMetrics and VictoriaTraces. Modern TypeScript and ESM, with separate portable, browser and Bun packages.

All flavors share the same retry policy, codecs and bounded outbox. No NAS addresses or credentials are embedded.

| Package | Runtime and features |
| --- | --- |
| `victoria-client` | Environment-agnostic core, explicit tracing and memory storage; no runtime dependencies |
| `victoria-browser-client` | Core plus page lifecycle handling, relative endpoint resolution and bounded keepalive requests; no runtime dependencies |
| `victoria-bun-client` | Async-local tracing; optional `/sqlite` for Bun persistence and `/otel` for official SDK/protobuf collection |

## features

- unified engine for all client environments and server setups
- logs, metrics and traces combined into a streamlined, pleasant-to-use interface
- easy starting point with minimal boilerplate, but extensive configurability for advanced usage
- specialized engine flavors for distinct environments like browsers and Bun
- insane robustness and perseverance, preventing data loss in the most suboptimal conditions
- native Victoria formats and OTLP JSON/Protobuf

## installation

<a href="https://npmjs.com/package/victoria-client"><img src="https://shieldcn.dev/badge/npm-victoria--client-C23039.svg?variant=secondary&logo=npm" alt="victoria-client on npm"/></a>

```sh
npm install --save victoria-client
```

<a href="https://www.jsdelivr.com/package/npm/victoria-client"><img src="https://shieldcn.dev/badge/jsDelivr-victoria--client-orange.svg?variant=secondary&logo=html5&logoColor=white" alt="victoria-client on jsDelivr"/></a> <a href="https://unpkg.com/browse/victoria-client/"><img src="https://shieldcn.dev/badge/UNPKG-victoria--client-orange.svg?variant=secondary&logo=html5&logoColor=white" alt="victoria-client on UNPKG"/></a>

```html
<script src="https://cdn.jsdelivr.net/npm/victoria-client@0.1.0/index.js"></script>
```

## minimal example

```ts
import VictoriaClient from 'victoria-client'

const client = new VictoriaClient

client.log('running')
client.metric('fps', 60)
client.pushTrace('click', {target: 'button'})
```

## usage

```ts
import * as os from 'node:os'

import VictoriaClient from 'victoria-client'

const victoria = new VictoriaClient('my-app', {
  protocol: 'https',
  host: 'victoria.example.com',
  port: 443,
  path: 'api',
  logs: {
    path: 'logs', // https://victoria.example.com:443/api/logs
  },
  metrics: {
    path: 'metrics', // https://victoria.example.com:443/api/metrics
  },
  traces: {
    path: 'traces', // https://victoria.example.com:443/api/traces
  },
})

// VictoriaLogs

victoria.log('Started')

victoria.trace('noise')
victoria.debug(`NODE_ENV=${process.env.NODE_ENV}`)
victoria.info('Reloaded configuration')
victoria.warn('deprecated runtime')
victoria.error('Backup failed')
victoria.fatal('Disk full – shutting down immediately')

// VictoriaMetrics

victoria.pushMetric({
  ram_total: os.totalmem(),
  ram_free: os.freemem(),
})

// VictoriaTraces

victoria.pushTrace('weather-sensor.update', {
  sampleDuration: 89,
  degrees: {
    celsius: 20,
  },
})

await victoria.wrap('compile', async () => {
  victoria.info('about to compile')
  const span = victoria.startSpan('compilation')
  const result = await compile()
  span.end()
  victoria.info('finished compiling')
})

// misc

// Changes the interval at which the client automatically flushes pending data. Will also activate the scheduler in case it’s currently disabled.
victoria.setInterval(3000)

// Disables the scheduler. Then `sync()` or `flush()` must be called manually.
victoria.setInterval(false)

// It will then handle everything automatically. If it is important to have it all pushed before continuing, `sync()` can be called with an optional timeout.
await victoria.sync({
  timeout: 60_000,
  required: true, // If true and the timeout is reached, throws. If false, returns a boolean indicating whether the sync was successful or not.
})

// Checks if all configured endpoints are reachable and healthy. If so, does nothing, otherwise throws. Optionally a timeout can be specified. The difference to `sync()` is that this method does minimal effort to check the health of the endpoints, while `sync()` will wait for all pending data to be sent and acknowledged.
await victoria.assertHealth()
```

## advanced usage

### explicit collection API

```ts
import VictoriaClient from 'victoria-client'

const telemetry = new VictoriaClient({
  serviceName: 'my-service',
  endpoint: 'http://localhost:4318',
})

try {
  telemetry.info('Started.', {version: '1.0.0'})
  telemetry.metric('workers.active', 3)
  telemetry.count('jobs.completed')
  await telemetry.wrap('job.run', async span => {
    telemetry.log('Processing.', {context: span})
    span.addEvent('job.validated')
    // Perform the operation here.
  })
} finally {
  const report = await telemetry.shutdown({timeout: 5000})
  console.log(report)
}
```

Construction performs no immediate network requests. Periodic delivery is scheduled automatically every 1000 ms by default; set `interval: false` or `0` to disable the scheduler and use `flush()` or `sync()` explicitly. Call `setInterval(value)` later to enable, disable or change the cadence. End open spans before shutdown. The portable client installs neither process signal handlers nor browser lifecycle handlers; the browser flavor supplies page lifecycle integration independently of periodic scheduling.

There are no default NAS addresses and no implicit environment-variable discovery. A collector base URL appends `/v1/logs`, `/v1/metrics` and `/v1/traces`. A signal-specific URL is used exactly as supplied. Set a signal to `false` to disable it.

### direct Victoria endpoints

VictoriaMetrics’ OTLP metrics endpoint expects protobuf. Use native JSON import with the portable client or use the OpenTelemetry entry for protobuf.

```ts
import VictoriaClient, {nativeEndpoints} from 'victoria-client'

const telemetry = new VictoriaClient({
  serviceName: 'collector',
  endpoints: nativeEndpoints({
    logs: 'http://localhost:9428',
    metrics: 'http://localhost:8428',
    traces: 'http://localhost:10428',
  }),
})
```

The helper selects `/insert/jsonline`, `/api/v1/import` and `/insert/opentelemetry/v1/traces`. Native logs use `service.name` as their stream field. Use explicit endpoint objects to customize tenant paths or query parameters:

```ts
const telemetry = new VictoriaClient({
  serviceName: 'mixed',
  endpoints: {
    logs: 'http://localhost:4318/v1/logs',
    metrics: {url: 'http://localhost:8428/api/v1/import', format: 'victoria-json'},
    traces: 'http://localhost:4318/v1/traces',
  },
})
```

### durable collection on Bun

```ts
import VictoriaClient from 'victoria-bun-client'
import SqliteOutbox from 'victoria-bun-client/sqlite'

const outbox = new SqliteOutbox({path: './data/telemetry.sqlite'})
const telemetry = new VictoriaClient({
  serviceName: 'collector',
  endpoint: 'http://localhost:4318',
  outbox,
})

if (!telemetry.info('Observation recorded.')) {
  throw new Error('The observation could not enter the outbox.')
}
```

For the portable/Bun collection methods, a successful admission into a SQLite outbox is synchronously committed before the method returns, unless the caller has deliberately opened an enclosing transaction. SQLite uses WAL and `synchronous=FULL`. Pending payloads, original timestamps, resource identity, retry timing and authentication pauses survive restarts.

Use one outbox per application/sender. The store has an exclusive, renewable lease and rejects changed endpoint/codec bindings. An abandoned lease expires after 60 seconds by default. Do not delete a live owner’s lease to start another sender.

Shutdown attempts bounded delivery and closes the store. An incomplete durable queue remains available to the next client using the same database and destinations. An incomplete memory queue is **not** durable.

### OpenTelemetry SDK

```ts
import OpenTelemetryClient from 'victoria-bun-client/otel'
import SqliteOutbox from 'victoria-bun-client/sqlite'

const telemetry = new OpenTelemetryClient({
  serviceName: 'worker',
  endpoints: {
    logs: 'http://localhost:4318/v1/logs',
    traces: 'http://localhost:4318/v1/traces',
    metrics: 'http://localhost:8428/opentelemetry/v1/metrics',
  },
  outbox: new SqliteOutbox({path: './data/worker.sqlite'}),
})

const duration = telemetry.meter.createHistogram('job.duration', {unit: 's'})
const span = telemetry.tracer.startSpan('job')
duration.record(0.25, {kind: 'thumbnail'})
telemetry.logger.emit({body: 'Finished.', severityNumber: 9})
span.end()
await telemetry.shutdown()
```

Providers initialize lazily and stay private. Nothing registers a global tracer, logger, meter or context manager. Supply explicit OpenTelemetry contexts for SDK correlation. The separate Bun convenience API automatically correlates its own spans and logs through `AsyncLocalStorage`.

SDK batches first enter an in-memory SDK buffer, then serialize into the shared outbox. `handoff: 'immediate'` removes the SDK log/span batching delay, but the delivery engine still batches network requests. SDK `emit()` and `span.end()` are **not synchronous durability acknowledgments**. Call `flush()`/`shutdown()` to hand off SDK data. Metrics remain subject to their collection/export interval in either mode.

### delivery semantics

Admission, HTTP acknowledgment and durable backend storage are different events. `log()` returning `true` means admitted locally, not delivered remotely. `flush()` returns a report, not a blanket delivery guarantee.

An empty queue can result from successful delivery **or explicit rejection**. Inspect `sent`, `rejected` and `dropped`, not only `complete`. `throwOnPending` rejects when queued records remain; it does not reinterpret historical rejection counters as pending work.

Retries preserve record identities and timestamps. There is no exactly-once guarantee: an acknowledged request followed by a crash before local acknowledgment, or a lost response, can produce duplicates. Native Victoria ingestion can process data asynchronously; HTTP acknowledgment does not prove every input was parsed and retained. Keep authoritative business records outside this telemetry queue.

### entry points

| Entry | Purpose |
| --- | --- |
| `victoria-client` | Portable collection, memory storage, explicit tracing and native endpoint helpers |
| `victoria-client/bun` | Async-local tracing and streamed HTTP response instrumentation; SQLite is available separately at `/sqlite` |
| `victoria-client/sqlite` | Bun SQLite outbox only |
| `victoria-client/otel` | Official SDK providers and protobuf serialization |
| `victoria-client/delivery` | Low-level delivery engine, codecs and storage contracts for adapters |

Importing the portable entry does not load the SDK, SQLite or Node-specific modules. Only the Bun package declares SDK dependencies. The core and browser production packages have no runtime dependencies.

## options

Constructor options below cover the zero-config, service-name-only, named-host and explicit object forms. The named-host facade takes `serviceName` as its first argument; the object form accepts it optionally and otherwise derives it from the environment. Configure `host` for the facade or `endpoint`/`endpoints` for the object form. Store-specific fields belong to the `outbox` constructor, not directly to the client.

option | type | default | info
--- | --- | --- | ---
`baseUrl` | `string` | `location.href` | browser object form only; base for relative endpoints
`collectors` | `Array<Collector> \| Record<string, Collector>` |  | callbacks invoked immediately before scheduled flushes; record keys become names accepted by removeCollector
`collectorTimeout` | `number` | `100` | maximum milliseconds a scheduled flush waits for asynchronous collector work; cannot preempt blocking JavaScript
`compression` | `false \| 'gzip'` | `false` | gzip only when smaller; SDK flavor defaults to gzip
`compressionThreshold` | `number` | `1024` | minimum payload size before trying gzip
`endpoint` | `string` | `'http://localhost:4318'` for zero-argument and service-name-only constructors | OTLP collector base URL in the object form; appends /v1/{signal}
`endpoints` | `Partial<Record<Signal, Endpoint>>` |  | exact per-signal URLs and formats; false disables a signal
`fetch` | `(url: string, init: RequestInit) => Promise<Response>` | `fetch` | injectable transport; must honor the abort signal
`headers` | `HeadersSource` |  | static headers or synchronous credential factory; never persisted
`host` | `string` |  | base URL or hostname for the named-host form
`initialRetry` | `number` | `1000` | initial exponential retry delay
`interval` | `number \| false` | `1000` | delay between scheduled delivery passes; false or 0 disables the scheduler
`keepalive` | `boolean` | `false` | only applied to requests at most 16000 bytes; enabled by default in the browser flavor
`logs` | `HostSignalOptions` | `{"path":"v1/logs","format":"otlp-json"}` | named-host log route; false disables logs
`maxAge` | `number` | `604800000` | age limit checked when a batch becomes eligible for delivery
`maxAttempts` | `number` | `Number.MAX_SAFE_INTEGER` | attempt limit per failed batch
`maxAttributeBytes` | `number` | `1024` | UTF-8 byte limit for individual attribute strings and names
`maxAttributes` | `number` | `64` | maximum entries per attribute map
`maxBatchBytes` | `number` | `256000` | encoded request limit before gzip; browser flavor defaults to 16000
`maxBatchItems` | `number` | `256` | maximum outbox items selected per request
`maxItemBytes` | `number` | `Math.min(64000, maxBatchBytes)` | encoded outbox item limit; browser flavor defaults to 12000
`maxResponseBytes` | `number` | `64000` | maximum decoded acknowledgment body size
`maxRetry` | `number` | `60000` | exponential delay cap before jitter; a longer Retry-After wins
`maxSeries` | `number` | `1024` | distinct portable gauge and counter series
`maxSpanEvents` | `number` | `32` | maximum events per span
`metrics` | `HostSignalOptions` | `{"path":"api/v1/import","format":"victoria-json"}` | named-host metrics route; false disables metrics
`minLogLevel` | `LogLevel` | `info` | minimum emitted log severity
`now` | `() => number` | Unix milliseconds | injectable clock for deterministic tests
`onEvent` | `(event: DeliveryEvent) => void` |  | delivery diagnostics callback; exceptions cannot interrupt delivery
`outbox` | `Outbox` | `new MemoryOutbox` | memory or optional SQLite storage owned by one delivery engine
`outbox.lease` | `number` | `60000` | SQLite ownership lease; minimum 3000
`outbox.maxBytes` | `number` | `16000000` | per-signal logical payload-byte limit
`outbox.maxDeadLetters` | `number` | `100` | maximum retained rejection diagnostics; payloads are not retained
`outbox.maxItems` | `number` | `2048` | per-signal queued-item limit; configure on the outbox constructor
`outbox.path` | `string` |  | required SQLite filename or :memory: when constructing SqliteOutbox
`path` | `string` |  | shared path prefix in the named-host form
`port` | `number` |  | optional port override
`protocol` | `'http' \| 'https'` | `'https'` for bare hosts, otherwise the URL protocol | overrides the host URL protocol
`random` | `() => number` | `Math.random` | injectable retry-jitter source
`resource` | `Attributes` | `{}` | scalar resource attributes; service.name is enforced and service.instance.id defaults to a new compose-id value
`sanitizeAttributes` | `(values: Attributes, signal: Signal) => Attributes` |  | runs before collection attribute limits and persistence; does not sanitize messages or resources
`serviceName` | `string` | OS: basename of `argv[1]`, then `argv[0]`, then `'unknown'`; browser: current hostname, then `'unknown'` | optional in object form; first constructor argument in the named-host form
`signalHeaders` | `Partial<Record<Signal, HeadersSource>>` |  | case-insensitive per-signal overrides for shared headers
`timeout` | `number` | `5000` | request deadline including compression and response-body reads; also the default assertHealth deadline
`traces` | `HostSignalOptions` | `{"path":"v1/traces","format":"otlp-json"}` | named-host trace route; false disables traces

## api

### constructors

`new VictoriaClient` sends OTLP JSON to `http://localhost:4318`. On OS runtimes, `service.name` defaults to the basename of `argv[1]`, then `argv[0]`, then `unknown`. `new VictoriaClient(serviceName)` keeps the same local OTLP endpoint with an explicit service name.

`new VictoriaClient(serviceName, {host, protocol?, port?, path?, logs?, metrics?, traces?, interval?})` supports the compact named-host API shown in `docs/tldw/usage.ts`. Each signal can be disabled or configured with `{path, format?, acknowledgment?}` (or a full/relative `endpoint` instead of `path`). A full URL or bare hostname is accepted. Bare hosts default to HTTPS; an explicit protocol/port overrides corresponding URL components. Relative signal endpoints resolve below the configured path. Periodic delivery is scheduled automatically with `interval: 1000`; set `interval` to `false` or `0` to disable it.

`pushMetric(values, options?)` records a map of gauge names to numeric values and returns whether every observation was admitted; partial admission is possible. `pushTrace(name, data?, {time?, duration?, status?})` flattens nested objects into dotted attributes, rejects flattening collisions and limits nesting to eight levels. It emits an instantaneous completed span by default. A numeric field in `data` is metadata, not an inferred duration.

`sync({timeout = 10000})` is the strict, retry-aware barrier: it waits through backoff until empty, then returns a report. It rejects on timeout, an authentication pause or newly observed permanent/partial rejection. It does not hide prior admission failures; inspect collection return values and status. A closed client cannot drain remaining records. The SDK entry hands off SDK buffers before this barrier.

### portable collection

`VictoriaClient` is the default export of `victoria-client`. In the explicit object form, `serviceName` is optional and uses the same environment-derived default; at least one endpoint is still required. URLs must be absolute HTTP(S) URLs without embedded credentials or fragments. In a browser, resolve a same-origin relay explicitly, for example `new URL('/api/telemetry', location.href).href`.

| Method | Behavior |
| --- | --- |
| `log(message, options?)` | Structured log; options are `level`, `attributes`, `context` and Unix-millisecond `time` |
| `debug/info/warn/error/fatal(message, attributes?)` | Convenience log methods |
| `metric(name, value, options?)` | Gauge observation |
| `count(name, amount = 1, options?)` | Nonnegative increment to a cumulative counter |
| `startSpan(name, options?)` | Explicit span; options are `parent`, `attributes`, `kind` and `startTime` |
| `trace(message, attributes?)` | TRACE-level structured log |
| `wrap(name, operation, options?)` | Span wrapper; synchronous operations return synchronously, promise-like operations stay asynchronous, and original exceptions/rejections are preserved |

Log and metric collection return `true` when admitted or `false` when disabled, filtered, closed or rejected by a capacity limit. Storage failures throw instead of claiming durable admission. Invalid numbers and incompatible metric descriptors throw. Log bodies are strings; attributes are finite numbers, booleans or strings.

Metric options are `attributes`, `unit` and `time`. A metric name cannot change kind or unit within a client. The series budget applies to gauges and counters. Counter totals keep advancing when the outbox is full, so a later admitted cumulative point can include intervening increments. Counter state is in memory; a new client gets a new default `service.instance.id` to distinguish its lifetime. Reusing a stable instance ID across restarts requires understanding counter resets.

A span exposes `traceId`, `spanId`, `traceFlags`, `startTime`, `setAttributes()`, `addEvent()`, `end()` and `traceparent()`. `end(status = 'ok', attributes = {}, time = now())` accepts `ok`, `error` or `unset`. End time cannot precede start time. Ending twice returns `false`. Event overflow increments `droppedEventsCount`. Unsampled parent flags propagate and prevent exporting a completed child; logs remain independently available.

`parseTraceparent()` supports the version-00 W3C form and rejects malformed or all-zero IDs. `traceparent()` validates and formats the header. The portable API does not install an implicit async context.

### resource and privacy options

`resource` supplies scalar resource attributes. `service.name` comes from `serviceName`; `service.instance.id` defaults to a new `compose-id` value. Resource data is captured at construction and included in persisted requests, so replay does not relabel observations as a new process. Native metrics flatten resource and measurement attributes into labels; measurement attributes take precedence for duplicate keys.

`minLogLevel` defaults to `info`. Use `log(..., {level: 'trace'})` for the lowest severity.

`sanitizeAttributes(values, signal)` runs before collection attributes are limited or persisted. It covers later span setters, events and `end()` too. It does not sanitize log messages, span/event names, resource attributes or low-level encoded submissions. Avoid secrets there. The SDK entry exposes the SDK APIs directly and does not apply the portable sanitizer.

Convenience trace wrappers export exception types, not text or stacks. HTTP diagnostics do not echo request/response bodies or authentication headers. Partial-success warning text is replaced with a generic message because servers can echo sensitive payloads.

### bounds

See the generated [options table](#options) for collection and delivery limits.

String truncation respects UTF-8 boundaries. An oversized log body or complete span is rejected by `maxItemBytes`; log messages are not silently cut in half. Attribute count limits are independent of complete-record admission. `maxItemBytes` must not exceed `maxBatchBytes`.

Configure store capacity on the outbox: `maxItems` defaults to 2048, `maxBytes` to 16 000 000 and `maxDeadLetters` to 100. Count and byte limits apply separately to each signal. Full stores reject incoming admissions, never evict in-flight data. These are logical queued-payload limits, not bounds on total process memory or physical SQLite file size.

### Victoria acknowledgment compatibility

The tested VictoriaLogs, VictoriaMetrics and VictoriaTraces versions return empty HTTP 200 acknowledgments without a content type on their native OTLP routes. Those exact route suffixes automatically select `acknowledgment: 'victoria'`; the named-host facade uses the same mode by default. It accepts an empty acknowledgment, but not an HTML response or invalid nonempty OTLP payload.

Generic collector endpoints retain strict OTLP content-type/body validation. Set `acknowledgment: 'otlp'` explicitly to enforce that behavior even on a native-looking URL, or `'victoria'` for a proxy that rewrites a native route. SDK signal endpoints accept `{url, acknowledgment?}` too. The policy is part of the outbox’s codec binding.

### transport

`fetch` is injectable and must honor `RequestInit.signal`. Native fetch refuses redirects and omits browser credentials. `headers` accepts a static record or synchronous factory for credential rotation. `signalHeaders` supplies per-signal sources, overriding shared values. Headers are not persisted.

`timeout` defaults to 5000 and covers compression, the HTTP request and response-body reading. `compression` is `false` or `gzip`; off for the portable client, on for the SDK entry. `compressionThreshold` defaults to 1024. Gzip is used only when smaller.

`keepalive` is opt-in and set only for transmitted bodies of at most 16 000 bytes. This conservative per-request bound cannot guarantee availability of the browser’s aggregate keepalive budget. Unload delivery remains best-effort.

`initialRetry` defaults to 1000 and `maxRetry` to 60 000. Positive jitter adds up to 20% to the capped exponential delay. A longer `Retry-After` wins. `now` and `random` support deterministic tests; normal applications should keep their defaults.

### collectors

`addCollector(collector)` and `addCollector(name, collector)` register callbacks that run immediately before every scheduled flush. The callback receives the client instance as its first argument and may be synchronous or asynchronous. Constructor options accept `collectors: Array<Collector> | Record<string, Collector>`.

```ts
victoria.addCollector(() => {
  victoria.metric('ram_free', os.freemem())
})

victoria.addCollector('my-pc-collector', client => {
  client.metric('ram_total', os.totalmem())
})
```

A scheduled flush waits up to `collectorTimeout` (100 milliseconds by default) for the collector pass. Observations admitted before that deadline are inside that flush’s barrier. Slow asynchronous collectors continue running; observations they produce later stay in the normal outbox and are delivered by a later flush. The deadline cannot preempt synchronous JavaScript, so collectors should not perform blocking work. Collector failures do not block delivery and are reported through `onEvent` as generic errors.

`removeCollector(nameOrReference)` removes a named collector or every registration using the given callback reference and returns whether anything was removed. `clearCollectors()` removes all registrations. Manual `flush()`, `sync()` and `shutdown()` do not invoke collectors; collectors are tied specifically to scheduled collection.

### lifecycle and reports

`interval` controls the unreferenced delivery timer and defaults to 1000 ms. Set it to `false` or `0` to disable periodic delivery. `setInterval(value)` can later enable, disable or reschedule the timer with the same value semantics. There is no manual `start()`; use `flush()`, `sync()` and `shutdown()` for explicit lifecycle barriers.

`flush({timeout = 10000, throwOnPending = false})` drains all ready batches at its admission barrier, not just one batch. Concurrent default callers share one promise. Later calls advance the barrier to include intervening admissions. Backoff and authentication pauses are honored. Concurrent calls share the original deadline rather than extending it indefinitely.

`shutdown()` stops admissions/scheduling, gives pending data a bounded chance to drain and closes storage. It interrupts a longer outstanding request so its own budget controls network work. Repeated calls return one promise. A deadline cannot interrupt synchronous encoding, SQLite operations or a blocked JavaScript event loop. End open spans before shutdown.

`status()` returns `complete`, `pendingRecords` and separate signal reports. `complete` means empty, not lossless: inspect `sent`, `rejected` and `dropped`. Reports include queue count/bytes/oldest time, retry attempts/time, authentication pause, last error and runtime totals for admitted, sent, rejected, dropped, requests and transmitted bytes. Queue/retry state survives durable restarts. Diagnostic totals restart with the client and are not rolled back by enclosing application transactions. Native metric `sent` counts consumed observations before millisecond coalescing.

`collectionStatus()` separately exposes portable series usage and cardinality drops. `onEvent` observes overflow, retry, rejection, expiration, pauses and successes; callback exceptions cannot interrupt delivery. `resume(signal?)` clears an authentication pause and retry delay after credentials are corrected. It never changes destinations.

### Bun context API

`BunVictoriaClient`, the default export of `victoria-bun-client`, extends the portable class. `wrap()` preserves its span across awaited work; children inherit it and logs correlate automatically. Explicit contexts take precedence. Concurrent calls remain isolated through per-client `AsyncLocalStorage`.

`currentSpan()` returns the active span. `traceHeaders()` returns an outgoing `traceparent`; callers choose which requests receive it.

`traceRequest(request, handler, name = 'http.server')` honors an incoming version-00 traceparent. The span ends when the response stream finishes, is canceled or errors, not when headers become ready. Automatic metadata contains method, server and URL path, not query strings. Applications must still avoid sensitive path components.

### OpenTelemetry entry

`OpenTelemetryClient` exposes `logger`, `tracer` and `meter` from private official providers. Every configured signal uses OTLP/protobuf. Endpoint and lifecycle conventions match the portable client.

Extra options: `exportInterval` (10 000), `exportTimeout` (2000, at most the interval), `sdkQueueSize` (1024), `cardinalityLimit` (256 per instrument) and `handoff` (`batch` by default). SDK attributes are limited to 64 entries and 1024 characters; span events to 32. Shared encoded-item byte limits still apply.

`handoff: 'immediate'` uses simple SDK processors only for local outbox handoff. The network sender still batches. SDK metrics stay cumulative and use a periodic reader. There is no competing SDK network retry loop.

`QueuedLogExporter`, `QueuedSpanExporter` and `QueuedMetricExporter` can be attached to existing SDK providers. Their callback success and `forceFlush()` mean local handoff, not remote delivery. Flush/shutdown the owning engine after its producers.

### explicit health checks

`await client.assertHealth({timeout?, signal?})` sends one empty ingestion request to each configured signal endpoint in parallel. It uses the same authentication, wire format, timeout and acknowledgment checks as delivery. Success resolves without a value. Failure throws an `AggregateError` with signal-specific, sanitized errors. Disabled signals are omitted. The default overall deadline is the transport `timeout` (5000 milliseconds).

No observations are created, no queued records are flushed and no retry/authentication state is changed. There are no retries. Ordinary collection and background delivery remain tolerant of connection failures. Call this before work that requires a configured Victoria connection; it is a point-in-time ingestion check, not a guarantee about future connectivity, downstream collector delivery or storage durability.

### browser flavor

`BrowserVictoriaClient` is the default export of `victoria-browser-client`. Its zero-argument form uses the current `location.hostname` as `service.name`, falling back to `unknown`, and sends OTLP JSON to `http://localhost:4318`. The service-name-only form keeps that local endpoint. It also supports the explicit object and named-host constructors. Object options also accept `baseUrl` for resolving relative endpoints; the current page URL is used by default. Construction in a browser attaches page lifecycle listeners, and `shutdown()` removes them before draining. `pagehide` and visibility loss attempt delivery even when periodic scheduling is disabled. `bindPage(page?)` replaces the current attachment and returns an idempotent cleanup. Importing the module installs no global listeners.

Browser defaults are `keepalive: true`, `maxBatchBytes: 16000` and `maxItemBytes: 12000`. Payloads remain bounded and the shared transport never enables keepalive above its 16000-byte limit. There is no IndexedDB or service-worker persistence. Use a same-origin relay and never publish ingestion credentials.

#### optional synchronization

`sync({required: false, timeout?})` returns `true` on complete delivery or `false` when synchronization fails. `required: true` (the default) keeps the strict report-returning behavior and throws on delivery failure or timeout. Local storage/encoding failures encountered during optional synchronization also produce `false`; invalid timeout arguments still throw. Queued data is retained according to the normal delivery policy.

## notes

### reliability and storage

#### failure policy

| Outcome | Policy |
| --- | --- |
| Network failure or timeout | Retain the frozen batch and back off |
| OTLP 429, 502, 503 or 504 | Retry with backoff, jitter and `Retry-After` |
| Other OTLP errors, including 400, 413 and 500 | Permanent rejection; no automatic retry |
| Native Victoria 408, 429, 500, 502, 503 or 504 | Retry |
| Native Victoria 413 | Split the batch; reject an indivisible item that still fails |
| 401 or 403 | Pause the signal, preserve data and require explicit operator `resume()` |
| OTLP partial acceptance | Consume once, count rejections and retain metadata diagnostics; never retry |
| HTML, malformed OTLP or oversized acknowledgment | Permanent rejection |
| Local storage or ownership failure | Surface an error; never claim successful admission or acknowledgment |

Authentication pause is an operational retention policy, not automatic retry of an authentication error. Correct credentials before resuming. Paused lanes are neither delivered nor age-pruned until resumed. Eligible batches exceeding `maxAge` are explicitly rejected.

#### crash boundaries

The portable client serializes before admission. SQLite commits encoded payloads, not mutable objects or instructions to regenerate data. Resource identity, timestamps and IDs survive restart. Authentication headers and raw endpoint values do not enter the outbox.

Before sending, the engine persists a batch’s final queue ID. Concurrent admissions cannot enlarge an earlier retry. On acknowledgment, deleting selected IDs and clearing retry state is atomic. Newer records remain queued.

A lost response or crash between remote acceptance and local acknowledgment can duplicate observations. This is bounded, retrying delivery, not exactly-once storage. Backend import acknowledgments may also precede parsing or persistence; consult backend ingestion-error metrics for authoritative diagnostics.

An empty queue does not prove lossless delivery. Permanent and partial rejection intentionally consume records. Dead-letter diagnostics hold counts and reasons, not recoverable raw payloads. Keep an authoritative archive outside the telemetry queue when loss is unacceptable.

#### SQLite ownership

`SqliteOutbox` uses WAL, full synchronous commits and a renewable lease. Use local storage, one active sender and one database per logical destination set. A second live owner is refused. After a crashed owner’s lease expires, a replacement can acquire the database. The stale owner then fails its next guarded operation instead of deleting the replacement’s rows.

`lease` defaults to 60 000, with a minimum of 3000. The unreferenced heartbeat runs every third of that interval. A lease is recovery coordination, not distributed exactly-once fencing of an HTTP request already in flight. Do not use a shared network filesystem or treat this as a multi-writer distributed queue.

A versioned, noncryptographic endpoint/codec fingerprint prevents accidental replay into different destinations. Reopening a database with changed destinations or encoding is refused, even if empty. Use a new database for a new destination set. Header rotation does not change the binding. The fingerprint is not encryption; protect the database directory with operating-system access controls.

Unsupported schema versions fail closed. Queue quotas bound logical payload data; SQLite may retain reusable pages or a WAL larger than the current queue. Filesystem limits and maintenance remain deployment concerns. The library does not automatically vacuum or delete old databases.

#### application transactions

An application can atomically commit state and raw outbox rows:

```ts
import SqliteOutbox from 'victoria-bun-client/sqlite'

const outbox = new SqliteOutbox({path: './data/state-and-telemetry.sqlite'})
outbox.database.run('CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, value REAL)')

const payload = new TextEncoder().encode(JSON.stringify({
  metric: {__name__: 'observation.value', job: 'collector'},
  timestamps: [Date.now()],
  values: [42],
}) + '\n')

outbox.transaction(() => {
  outbox.database.query('INSERT INTO observations(value) VALUES (?)').run(42)
  const admitted = outbox.append([{signal: 'metrics', body: payload, records: 1, createdAt: Date.now()}])
  if (!admitted) throw new Error('Outbox full; rolling back the observation.')
})
```

Configure the owning delivery engine with the matching native metrics codec and endpoint. `append()` is low-level: supply well-formed payloads and accurate record counts. Exceptions roll back state and queued observations together. Do not run async callbacks or network I/O inside these transactions or modify the internal `victoria_*` tables.

Synchronous durability trades event-loop latency for a clear admission boundary. Group related observations in a transaction for high-rate producers, or choose memory storage and an external persistent collector when blocking disk writes are undesirable. SDK batch mode amortizes handoff transactions, but pre-handoff SDK data remains only in memory.

#### browser delivery

The portable entry has no Bun/Node/SDK runtime imports and uses a memory outbox. A same-origin relay is the embedding application’s responsibility. Never embed a private ingestion credential in a public browser bundle.

Lifecycle-triggered flush and keepalive remain best-effort. There is no IndexedDB persistence, service-worker scheduler or public relay in this package. The browser flavor binds pagehide, pageshow and visibilitychange while started. These are bounded best-effort attempts, not an unload delivery guarantee. The portable flavor installs no page listeners.

#### verification references

Protocol choices were checked against the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [VictoriaMetrics OTLP integration](https://docs.victoriametrics.com/victoriametrics/integrations/opentelemetry/), [VictoriaLogs ingestion documentation](https://docs.victoriametrics.com/victorialogs/data-ingestion/) and [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite). Protobuf requests use the official OpenTelemetry serializers, not a hand-written encoder.

#### backend validation

On 2026-09-20, opt-in integration tests ingested data into disposable VictoriaLogs v1.52.0, VictoriaMetrics v1.151.0 and VictoriaTraces v0.10.0 instances and queried it back. Native JSON/JSONL and official SDK protobuf paths were both verified, including a histogram. Those instances returned empty HTTP 200 acknowledgments without content types on native OTLP routes; endpoint-scoped compatibility handles that without weakening generic collector validation.

Run `test/backend.integration.test.ts` only with `VICTORIA_TEST_LOGS_URL`, `VICTORIA_TEST_METRICS_URL` and `VICTORIA_TEST_TRACES_URL` pointing to disposable backends. It is skipped otherwise. The default test suite uses local receivers and temporary files.

## architecture

### one shared delivery engine

The structural base is a new implementation of Slop Gallery’s `telemethree` delivery ideas, not a copy of its application instrumentation. The portable API and official-SDK adapter share an encoded-payload outbox and HTTP sender.

```text
Portable VictoriaClient ─────────────┐
                                    ├─ Outbox ─ DeliveryEngine ─ codec/HTTP ─ Victoria or collector
Official SDK ─ protobuf handoff ──────┘
                 MemoryOutbox or SqliteOutbox
```

Separating collection, encoding, persistence and transport prevents retry loops with conflicting ownership. The SDK owns collection and local handoff. The delivery engine owns remote acknowledgment, retry and deletion. HTTP work never runs inside a SQLite transaction.

### what came from each candidate

| Candidate | Incorporated | Reworked or omitted |
| --- | --- | --- |
| Slop Gallery / telemethree | Independent bounded signals, safe concurrent appends, byte limits, explicit status, partial-success handling, backoff and native metrics | Interchangeable encoded outbox; ready-snapshot draining instead of one batch; gauge cardinality bounds |
| Mage | Private lazy official SDK providers, batch processors, cumulative metrics, cardinality limits and protobuf | Official serializers feed the common queue instead of a second network exporter/retry loop |
| Quotas | SQLite WAL/full synchronous commits and atomic state plus telemetry | Count/byte quotas, persistent retry state, ownership lease and route/schema guards |
| Inspec | Async-local operation context and spans covering streamed response lifetime | Bun subclass; no fixed retry loop or permissive acknowledgments |
| PowerShell telemetry | Unicode-aware bounds and observable drops | No shell hooks or raw terminal capture; no retries of partial rejection |
| Windows metrics pusher | Preserve historical timestamps through outages | SQLite replaces repeated whole-file JSONL reads and rewrites |
| make-logger | Convenient leveled logging | No per-log network request, discarded provider lifecycle or transport guessing by port |

### additional changes

Memory storage uses constant-time accounting rather than rescanning a growing queue for every event. Native metrics group a series into timestamp/value arrays and resolve millisecond collisions after final label normalization. OTLP JSON batches share resource/scope envelopes and metric descriptors.

Requests are bounded before and after encoding. Gzip is optional and used only when smaller. Response reading has byte and time bounds, including servers that send headers and then stall. Batch checkpoints prevent newly admitted observations from joining an earlier retry.

Authentication errors pause rather than discard data or retry continuously. Headers can rotate independently per signal. Native oversized requests split adaptively; OTLP requests obey OTLP’s non-retry policy. Server-controlled warning text is excluded from diagnostics.

Shutdown interrupts longer requests and owns a bounded drain budget. It reports remaining data rather than equating a fulfilled promise with successful delivery. Durable admission is synchronous; no unbounded promise chain holds pending records outside the database.

### source organization

`VictoriaClient.ts` owns portable collection. `tracing/` owns spans and trace headers. `delivery/` owns policy and transport. `codecs/` owns wire formats. `storage/` supplies the common contract and memory/SQLite implementations. `bun/` adds async context and streamed HTTP observation. `otel/` contains the official-SDK bridge.

The low-level contracts are exported for adapters. Applications still own instrumentation, public relay authentication, authoritative business persistence and lifecycle integration. This package does not modify any existing producer or NAS configuration.

### distribution pipeline

One source tree produces three independent ESM packages. `scripts/flavors.ts` declares each flavor’s entry points, and `vite.config.ts` turns each flavor into a complete build_lib-compatible intermediate project with bundled runtime files, reachable declarations and package metadata. `scripts/build.ts` then runs build_lib on those intermediates. Core and browser graphs reject runtime built-ins and external SDK imports during bundling. The Bun root imports async context only; SQLite and the official SDK remain separate entry points. Each package flavor exposes its primary client as the default export. Supporting classes remain named only on aggregate entry points where multiple peer values are intentionally exposed.

Vite owns code splitting so shared classes are not duplicated across entry points. In precompiled mode, build_lib preserves the intermediate export map, applies the production Terser pass to the root entry, secondary entries and shared JavaScript chunks, normalizes package metadata and copies the generated declarations and common package files. No Victoria-specific post-processing mutates the finished package. The readme is generated by tldw before packaging, not edited or assembled by this build pipeline.

## development

Maintain readme content in `docs/tldw` and the automatically included `docs/api.md`, `docs/architecture.md` and `docs/notes.md`. Do not edit `readme.md` directly.

`bun tldw` regenerates it.

### validation

`bun run test`, `bun run typecheck` and `bun run lint` check the source. Backend integration tests require explicit disposable backend URLs.

### package builds

Run `bun run build`. The pipeline regenerates the readme, uses Vite/Rolldown to emit complete per-flavor intermediate projects and declarations with the pinned TypeScript compiler, then invokes `build_lib.exe` in precompiled production mode.

| Package | Production directory |
| --- | --- |
| Core | `dist/package/victoria-client/production` |
| Browser | `dist/package/victoria-browser-client/production` |
| Bun | `dist/package/victoria-bun-client/production` |

Intermediates live in `out/intermediate/{package}`. Shared runtime chunks preserve class identity across exported entry points. Their package manifests already contain the complete export map and declaration paths; build_lib preserves those subpath exports while applying its final production optimization and metadata normalization. Nothing is published by the build.

The build requires your `build_lib.exe` command on Windows (`build_lib` elsewhere). `BUILD_LIB_BIN` may name an alternate installed executable. There is no silently different fallback.

Run `bun run test:packages` to build all flavors, pack them, install the tarballs into an isolated temporary consumer and verify public imports, declarations and runtime behavior. Portable/browser declarations are checked without Node or Bun ambient types. The temporary consumer is removed afterward.

### setting up

```sh
git clone git@github.com:Jaid/victoria-client.git
cd victoria-client
bun install
```

### linting

```sh
bun run lint
```

### type checking

```sh
bun run typecheck
```

### testing

```sh
bun run test
```

## license

[MIT License](https://github.com/Jaid/victoria-client/raw/HEAD/license.txt)<br>
Copyright © 2026, Jaid \<jaid.jsx@gmail.com> (https://github.com/jaid)

<!--
readme generated with tldw v9.5.0 from ./docs/tldw
github.com/Jaid/tldw
-->
