# reliability and storage

## failure policy

| outcome | policy |
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

## crash boundaries

The portable client serializes before admission. SQLite commits encoded payloads, not mutable objects or instructions to regenerate data. Resource identity, timestamps and IDs survive restart. Authentication headers and raw endpoint values do not enter the outbox.

Before sending, the engine persists a batch’s final queue ID. Concurrent admissions cannot enlarge an earlier retry. On acknowledgment, deleting selected IDs and clearing retry state is atomic. Newer records remain queued.

A lost response or crash between remote acceptance and local acknowledgment can duplicate observations. This is bounded, retrying delivery, not exactly-once storage. Backend import acknowledgments may also precede parsing or persistence; consult backend ingestion-error metrics for authoritative diagnostics.

An empty queue does not prove lossless delivery. Permanent and partial rejection intentionally consume records. Dead-letter diagnostics hold counts and reasons, not recoverable raw payloads. Keep an authoritative archive outside the telemetry queue when loss is unacceptable.

## SQLite ownership

`SqliteOutbox` uses WAL, full synchronous commits and a renewable lease. Use local storage, one active sender and one database per logical destination set. A second live owner is refused. After a crashed owner’s lease expires, a replacement can acquire the database. The stale owner then fails its next guarded operation instead of deleting the replacement’s rows.

`lease` defaults to 60 000, with a minimum of 3000. The unreferenced heartbeat runs every third of that interval. A lease is recovery coordination, not distributed exactly-once fencing of an HTTP request already in flight. Do not use a shared network filesystem or treat this as a multi-writer distributed queue.

A versioned, noncryptographic endpoint/codec fingerprint prevents accidental replay into different destinations. Reopening a database with changed destinations or encoding is refused, even if empty. Use a new database for a new destination set. Header rotation does not change the binding. The fingerprint is not encryption; protect the database directory with operating-system access controls.

Unsupported schema versions fail closed. Queue quotas bound logical payload data; SQLite may retain reusable pages or a WAL larger than the current queue. Filesystem limits and maintenance remain deployment concerns. The library does not automatically vacuum or delete old databases.

## application transactions

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

## browser delivery

The portable entry has no Bun/Node/SDK runtime imports and uses a memory outbox. A same-origin relay is the embedding application’s responsibility. Never embed a private ingestion credential in a public browser bundle.

Lifecycle-triggered flush and keepalive remain best-effort. There is no IndexedDB persistence, service-worker scheduler or public relay in this package. The browser flavor binds pagehide, pageshow and visibilitychange while started. These are bounded best-effort attempts, not an unload delivery guarantee. The portable flavor installs no page listeners.

## verification references

Protocol choices were checked against the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [VictoriaMetrics OTLP integration](https://docs.victoriametrics.com/victoriametrics/integrations/opentelemetry/), [VictoriaLogs ingestion documentation](https://docs.victoriametrics.com/victorialogs/data-ingestion/) and [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite). Protobuf requests use the official OpenTelemetry serializers, not a hand-written encoder.

## backend validation

On 2026-09-20, opt-in integration tests ingested data into disposable VictoriaLogs v1.52.0, VictoriaMetrics v1.151.0 and VictoriaTraces v0.10.0 instances and queried it back. Native JSON/JSONL and official SDK protobuf paths were both verified, including a histogram. Those instances returned empty HTTP 200 acknowledgments without content types on native OTLP routes; endpoint-scoped compatibility handles that without weakening generic collector validation.

Run `test/backend.integration.test.ts` only with `VICTORIA_TEST_LOGS_URL`, `VICTORIA_TEST_METRICS_URL` and `VICTORIA_TEST_TRACES_URL` pointing to disposable backends. It is skipped otherwise. The default test suite uses local receivers and temporary files.
