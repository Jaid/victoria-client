import VictoriaClient from 'victoria-client/bun'
import SqliteOutbox from 'victoria-client/sqlite'

const endpoint = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT
if (!endpoint) {
  throw new Error('Set OTEL_EXPORTER_OTLP_ENDPOINT to a collector.')
}
const outbox = new SqliteOutbox({path: './data/example-outbox.sqlite'})
const telemetry = new VictoriaClient({
  serviceName: 'durable-example',
  endpoint,
  outbox,
})
try {
  await telemetry.wrap('operation', async () => {
    telemetry.info('Automatically correlated through async context.')
    await Promise.resolve()
    telemetry.info('Still correlated.')
  })
  await telemetry.sync({timeout: 5000})
} finally {
  const report = await telemetry.shutdown({timeout: 5000})
  if (!report.complete) {
    console.warn('Pending observations remain in SQLite.', report.pendingRecords)
  }
}
