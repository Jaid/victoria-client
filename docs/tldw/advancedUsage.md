# explicit collection API

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

# direct Victoria endpoints

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

# durable collection on Bun

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

# OpenTelemetry SDK

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

# delivery semantics

Admission, HTTP acknowledgment and durable backend storage are different events. `log()` returning `true` means admitted locally, not delivered remotely. `flush()` returns a report, not a blanket delivery guarantee.

An empty queue can result from successful delivery **or explicit rejection**. Inspect `sent`, `rejected` and `dropped`, not only `complete`. `throwOnPending` rejects when queued records remain; it does not reinterpret historical rejection counters as pending work.

Retries preserve record identities and timestamps. There is no exactly-once guarantee: an acknowledged request followed by a crash before local acknowledgment, or a lost response, can produce duplicates. Native Victoria ingestion can process data asynchronously; HTTP acknowledgment does not prove every input was parsed and retained. Keep authoritative business records outside this telemetry queue.

# entry points

| entry | purpose |
| --- | --- |
| `victoria-client` | Portable collection, memory storage, explicit tracing and native endpoint helpers |
| `victoria-client/bun` | Async-local tracing and streamed HTTP response instrumentation; SQLite is available separately at `/sqlite` |
| `victoria-client/sqlite` | Bun SQLite outbox only |
| `victoria-client/otel` | Official SDK providers and protobuf serialization |
| `victoria-client/delivery` | Low-level delivery engine, codecs and storage contracts for adapters |

Importing the portable entry does not load the SDK, SQLite or Node-specific modules. Only the Bun package declares SDK dependencies. The core and browser production packages have no runtime dependencies.
