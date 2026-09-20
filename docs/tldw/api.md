## named-host facade

`new VictoriaClient(serviceName, {host, protocol?, port?, path?, logs?, metrics?, traces?, interval?})` supports the compact API shown in `docs/tldw/usage.ts`. Each signal can be disabled or configured with `{path, format?, acknowledgment?}` (or a full/relative `endpoint` instead of `path`). A full URL or bare hostname is accepted. Bare hosts default to HTTPS; an explicit protocol/port overrides corresponding URL components. Relative signal endpoints resolve below the configured path. Periodic delivery is scheduled automatically with `interval: 1000`; set `interval` to `false` or `0` to disable it.

`pushMetric(values, options?)` records a map of gauge names to numeric values and returns whether every observation was admitted; partial admission is possible. `pushTrace(name, data?, {time?, duration?, status?})` flattens nested objects into dotted attributes, rejects flattening collisions and limits nesting to eight levels. It emits an instantaneous completed span by default. A numeric field in `data` is metadata, not an inferred duration.

`sync({timeout = 10000})` is the strict, retry-aware barrier: it waits through backoff until empty, then returns a report. It rejects on timeout, an authentication pause or newly observed permanent/partial rejection. It does not hide prior admission failures; inspect collection return values and status. A closed client cannot drain remaining records. The SDK entry hands off SDK buffers before this barrier.

## portable collection

`VictoriaClient` is the default export of `victoria-client`. Supply a nonempty `serviceName` and at least one endpoint. URLs must be absolute HTTP(S) URLs without embedded credentials or fragments. In a browser, resolve a same-origin relay explicitly, for example `new URL('/api/telemetry', location.href).href`.

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

## resource and privacy options

`resource` supplies scalar resource attributes. `service.name` comes from `serviceName`; `service.instance.id` defaults to a new `compose-id` value. Resource data is captured at construction and included in persisted requests, so replay does not relabel observations as a new process. Native metrics flatten resource and measurement attributes into labels; measurement attributes take precedence for duplicate keys.

`minLogLevel` defaults to `info`. Use `log(..., {level: 'trace'})` for the lowest severity.

`sanitizeAttributes(values, signal)` runs before collection attributes are limited or persisted. It covers later span setters, events and `end()` too. It does not sanitize log messages, span/event names, resource attributes or low-level encoded submissions. Avoid secrets there. The SDK entry exposes the SDK APIs directly and does not apply the portable sanitizer.

Convenience trace wrappers export exception types, not text or stacks. HTTP diagnostics do not echo request/response bodies or authentication headers. Partial-success warning text is replaced with a generic message because servers can echo sensitive payloads.

## bounds

See the generated [options table](#options) for collection and delivery limits.

String truncation respects UTF-8 boundaries. An oversized log body or complete span is rejected by `maxItemBytes`; log messages are not silently cut in half. Attribute count limits are independent of complete-record admission. `maxItemBytes` must not exceed `maxBatchBytes`.

Configure store capacity on the outbox: `maxItems` defaults to 2048, `maxBytes` to 16 000 000 and `maxDeadLetters` to 100. Count and byte limits apply separately to each signal. Full stores reject incoming admissions, never evict in-flight data. These are logical queued-payload limits, not bounds on total process memory or physical SQLite file size.

## Victoria acknowledgment compatibility

The tested VictoriaLogs, VictoriaMetrics and VictoriaTraces versions return empty HTTP 200 acknowledgments without a content type on their native OTLP routes. Those exact route suffixes automatically select `acknowledgment: 'victoria'`; the named-host facade uses the same mode by default. It accepts an empty acknowledgment, but not an HTML response or invalid nonempty OTLP payload.

Generic collector endpoints retain strict OTLP content-type/body validation. Set `acknowledgment: 'otlp'` explicitly to enforce that behavior even on a native-looking URL, or `'victoria'` for a proxy that rewrites a native route. SDK signal endpoints accept `{url, acknowledgment?}` too. The policy is part of the outbox’s codec binding.

## transport

`fetch` is injectable and must honor `RequestInit.signal`. Native fetch refuses redirects and omits browser credentials. `headers` accepts a static record or synchronous factory for credential rotation. `signalHeaders` supplies per-signal sources, overriding shared values. Headers are not persisted.

`timeout` defaults to 5000 and covers compression, the HTTP request and response-body reading. `compression` is `false` or `gzip`; off for the portable client, on for the SDK entry. `compressionThreshold` defaults to 1024. Gzip is used only when smaller.

`keepalive` is opt-in and set only for transmitted bodies of at most 16 000 bytes. This conservative per-request bound cannot guarantee availability of the browser’s aggregate keepalive budget. Unload delivery remains best-effort.

`initialRetry` defaults to 1000 and `maxRetry` to 60 000. Positive jitter adds up to 20% to the capped exponential delay. A longer `Retry-After` wins. `now` and `random` support deterministic tests; normal applications should keep their defaults.

## lifecycle and reports

`interval` controls the unreferenced delivery timer and defaults to 1000 ms. Set it to `false` or `0` to disable periodic delivery. `setInterval(value)` can later enable, disable or reschedule the timer with the same value semantics. There is no manual `start()`; use `flush()`, `sync()` and `shutdown()` for explicit lifecycle barriers.

`flush({timeout = 10000, throwOnPending = false})` drains all ready batches at its admission barrier, not just one batch. Concurrent default callers share one promise. Later calls advance the barrier to include intervening admissions. Backoff and authentication pauses are honored. Concurrent calls share the original deadline rather than extending it indefinitely.

`shutdown()` stops admissions/scheduling, gives pending data a bounded chance to drain and closes storage. It interrupts a longer outstanding request so its own budget controls network work. Repeated calls return one promise. A deadline cannot interrupt synchronous encoding, SQLite operations or a blocked JavaScript event loop. End open spans before shutdown.

`status()` returns `complete`, `pendingRecords` and separate signal reports. `complete` means empty, not lossless: inspect `sent`, `rejected` and `dropped`. Reports include queue count/bytes/oldest time, retry attempts/time, authentication pause, last error and runtime totals for admitted, sent, rejected, dropped, requests and transmitted bytes. Queue/retry state survives durable restarts. Diagnostic totals restart with the client and are not rolled back by enclosing application transactions. Native metric `sent` counts consumed observations before millisecond coalescing.

`collectionStatus()` separately exposes portable series usage and cardinality drops. `onEvent` observes overflow, retry, rejection, expiration, pauses and successes; callback exceptions cannot interrupt delivery. `resume(signal?)` clears an authentication pause and retry delay after credentials are corrected. It never changes destinations.

## Bun context API

`BunVictoriaClient`, the default export of `victoria-bun-client`, extends the portable class. `wrap()` preserves its span across awaited work; children inherit it and logs correlate automatically. Explicit contexts take precedence. Concurrent calls remain isolated through per-client `AsyncLocalStorage`.

`currentSpan()` returns the active span. `traceHeaders()` returns an outgoing `traceparent`; callers choose which requests receive it.

`traceRequest(request, handler, name = 'http.server')` honors an incoming version-00 traceparent. The span ends when the response stream finishes, is canceled or errors, not when headers become ready. Automatic metadata contains method, server and URL path, not query strings. Applications must still avoid sensitive path components.

## OpenTelemetry entry

`OpenTelemetryClient` exposes `logger`, `tracer` and `meter` from private official providers. Every configured signal uses OTLP/protobuf. Endpoint and lifecycle conventions match the portable client.

Extra options: `exportInterval` (10 000), `exportTimeout` (2000, at most the interval), `sdkQueueSize` (1024), `cardinalityLimit` (256 per instrument) and `handoff` (`batch` by default). SDK attributes are limited to 64 entries and 1024 characters; span events to 32. Shared encoded-item byte limits still apply.

`handoff: 'immediate'` uses simple SDK processors only for local outbox handoff. The network sender still batches. SDK metrics stay cumulative and use a periodic reader. There is no competing SDK network retry loop.

`QueuedLogExporter`, `QueuedSpanExporter` and `QueuedMetricExporter` can be attached to existing SDK providers. Their callback success and `forceFlush()` mean local handoff, not remote delivery. Flush/shutdown the owning engine after its producers.

## explicit health checks

`await client.assertHealth({timeout?, signal?})` sends one empty ingestion request to each configured signal endpoint in parallel. It uses the same authentication, wire format, timeout and acknowledgment checks as delivery. Success resolves without a value. Failure throws an `AggregateError` with signal-specific, sanitized errors. Disabled signals are omitted. The default overall deadline is the transport `timeout` (5000 milliseconds).

No observations are created, no queued records are flushed and no retry/authentication state is changed. There are no retries. Ordinary collection and background delivery remain tolerant of connection failures. Call this before work that requires a configured Victoria connection; it is a point-in-time ingestion check, not a guarantee about future connectivity, downstream collector delivery or storage durability.

## browser flavor

`BrowserVictoriaClient` is the default export of `victoria-browser-client`. It supports both constructors. Object options also accept `baseUrl` for resolving relative endpoints; the current page URL is used by default. Construction in a browser attaches page lifecycle listeners, and `shutdown()` removes them before draining. `pagehide` and visibility loss attempt delivery even when periodic scheduling is disabled. `bindPage(page?)` replaces the current attachment and returns an idempotent cleanup. Importing the module installs no global listeners.

Browser defaults are `keepalive: true`, `maxBatchBytes: 16000` and `maxItemBytes: 12000`. Payloads remain bounded and the shared transport never enables keepalive above its 16000-byte limit. There is no IndexedDB or service-worker persistence. Use a same-origin relay and never publish ingestion credentials.

### optional synchronization

`sync({required: false, timeout?})` returns `true` on complete delivery or `false` when synchronization fails. `required: true` (the default) keeps the strict report-returning behavior and throws on delivery failure or timeout. Local storage/encoding failures encountered during optional synchronization also produce `false`; invalid timeout arguments still throw. Queued data is retained according to the normal delivery policy.
