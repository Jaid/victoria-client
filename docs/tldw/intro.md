Shared collection and delivery for VictoriaLogs, VictoriaMetrics and VictoriaTraces. Modern TypeScript and ESM, with separate portable, browser and Bun packages.

All flavors share the same retry policy, codecs and bounded outbox. No NAS addresses or credentials are embedded.

| Package | Runtime and features |
| --- | --- |
| `victoria-client` | Environment-agnostic core, explicit tracing and memory storage; no runtime dependencies |
| `victoria-browser-client` | Core plus page lifecycle handling, relative endpoint resolution and bounded keepalive requests; no runtime dependencies |
| `victoria-bun-client` | Async-local tracing; optional `/sqlite` for Bun persistence and `/otel` for official SDK/protobuf collection |
