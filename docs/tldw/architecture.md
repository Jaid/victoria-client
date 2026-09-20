## one shared delivery engine

The structural base is a new implementation of Slop Gallery’s `telemethree` delivery ideas, not a copy of its application instrumentation. The portable API and official-SDK adapter share an encoded-payload outbox and HTTP sender.

```text
Portable VictoriaClient ─────────────┐
                                    ├─ Outbox ─ DeliveryEngine ─ codec/HTTP ─ Victoria or collector
Official SDK ─ protobuf handoff ──────┘
                 MemoryOutbox or SqliteOutbox
```

Separating collection, encoding, persistence and transport prevents retry loops with conflicting ownership. The SDK owns collection and local handoff. The delivery engine owns remote acknowledgment, retry and deletion. HTTP work never runs inside a SQLite transaction.

## what came from each candidate

| Candidate | Incorporated | Reworked or omitted |
| --- | --- | --- |
| Slop Gallery / telemethree | Independent bounded signals, safe concurrent appends, byte limits, explicit status, partial-success handling, backoff and native metrics | Interchangeable encoded outbox; ready-snapshot draining instead of one batch; gauge cardinality bounds |
| Mage | Private lazy official SDK providers, batch processors, cumulative metrics, cardinality limits and protobuf | Official serializers feed the common queue instead of a second network exporter/retry loop |
| Quotas | SQLite WAL/full synchronous commits and atomic state plus telemetry | Count/byte quotas, persistent retry state, ownership lease and route/schema guards |
| Inspec | Async-local operation context and spans covering streamed response lifetime | Bun subclass; no fixed retry loop or permissive acknowledgments |
| PowerShell telemetry | Unicode-aware bounds and observable drops | No shell hooks or raw terminal capture; no retries of partial rejection |
| Windows metrics pusher | Preserve historical timestamps through outages | SQLite replaces repeated whole-file JSONL reads and rewrites |
| make-logger | Convenient leveled logging | No per-log network request, discarded provider lifecycle or transport guessing by port |

## additional changes

Memory storage uses constant-time accounting rather than rescanning a growing queue for every event. Native metrics group a series into timestamp/value arrays and resolve millisecond collisions after final label normalization. OTLP JSON batches share resource/scope envelopes and metric descriptors.

Requests are bounded before and after encoding. Gzip is optional and used only when smaller. Response reading has byte and time bounds, including servers that send headers and then stall. Batch checkpoints prevent newly admitted observations from joining an earlier retry.

Authentication errors pause rather than discard data or retry continuously. Headers can rotate independently per signal. Native oversized requests split adaptively; OTLP requests obey OTLP’s non-retry policy. Server-controlled warning text is excluded from diagnostics.

Shutdown interrupts longer requests and owns a bounded drain budget. It reports remaining data rather than equating a fulfilled promise with successful delivery. Durable admission is synchronous; no unbounded promise chain holds pending records outside the database.

## source organization

`VictoriaClient.ts` owns portable collection. `tracing/` owns spans and trace headers. `delivery/` owns policy and transport. `codecs/` owns wire formats. `storage/` supplies the common contract and memory/SQLite implementations. `bun/` adds async context and streamed HTTP observation. `otel/` contains the official-SDK bridge.

The low-level contracts are exported for adapters. Applications still own instrumentation, public relay authentication, authoritative business persistence and lifecycle integration. This package does not modify any existing producer or NAS configuration.

## distribution pipeline

One source tree produces three independent ESM packages. `scripts/flavors.ts` declares each flavor’s entry points, and `vite.config.ts` turns each flavor into a complete build_lib-compatible intermediate project with bundled runtime files, reachable declarations and package metadata. `scripts/build.ts` then runs build_lib on those intermediates. Core and browser graphs reject runtime built-ins and external SDK imports during bundling. The Bun root imports async context only; SQLite and the official SDK remain separate entry points. Each package flavor exposes its primary client as the default export. Supporting classes remain named only on aggregate entry points where multiple peer values are intentionally exposed.

Vite owns code splitting so shared classes are not duplicated across entry points. In precompiled mode, build_lib preserves the intermediate export map, applies the production Terser pass to the root entry, secondary entries and shared JavaScript chunks, normalizes package metadata and copies the generated declarations and common package files. No Victoria-specific post-processing mutates the finished package. The readme is generated by tldw before packaging, not edited or assembled by this build pipeline.
