import {expect, test} from 'bun:test'

import composeId from 'compose-id'

import VictoriaClient, {nativeEndpoints} from '../src/main.ts'
import OpenTelemetryClient from '../src/otel/main.ts'

// Opt-in only. Point these variables at disposable instances, never an authoritative telemetry store.
const logs = Bun.env.VICTORIA_TEST_LOGS_URL
const metrics = Bun.env.VICTORIA_TEST_METRICS_URL
const traces = Bun.env.VICTORIA_TEST_TRACES_URL
const enabled = Boolean(logs && metrics && traces)
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await check()) {
      return
    }
    await Bun.sleep(100)
  }
  throw new Error('The disposable backend did not expose the ingested observation.')
}
async function queryLogs(base: string, query: string) {
  const response = await fetch(`${base}/select/logsql/query`, {
    method: 'POST',
    body: new URLSearchParams({query}),
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) {
    throw new Error(`Query returned ${response.status}.`)
  }
  return response.text()
}
async function hasMetric(base: string, name: string) {
  const url = new URL('/api/v1/export', base)
  url.searchParams.set('match[]', `{__name__="${name}"}`)
  const response = await fetch(url, {signal: AbortSignal.timeout(2000)})
  if (!response.ok) {
    throw new Error(`Metric export returned ${response.status}.`)
  }
  return (await response.text()).includes(name)
}
test.skipIf(!enabled)('disposable Victoria backends ingest and expose portable native data', async () => {
  const id = composeId()
  const serviceName = `victoria-client-native-${id}`
  const metric = `victoria_client_native_${id}`
  const client = new VictoriaClient({
    serviceName,
    endpoints: nativeEndpoints({
      logs: logs!,
      metrics: metrics!,
      traces: traces!,
    }),
    compression: 'gzip',
    compressionThreshold: 1,
  })
  try {
    await client.assertHealth()
    expect(client.status().pendingRecords).toBe(0)
    client.info('native-log')
    client.metric(metric, 42)
    client.pushTrace('native-trace', {probe: {nested: true}})
    const report = await client.sync({timeout: 5000})
    expect(Object.values(report.signals).every(signal => signal.sent === 1 && signal.rejected === 0)).toBe(true)
    await waitFor(async () => (await queryLogs(logs!, `_time:5m "service.name":="${serviceName}"`)).includes('native-log'))
    await waitFor(async () => (await queryLogs(traces!, `_time:5m "resource_attr:service.name":="${serviceName}"`)).includes('native-trace'))
    await waitFor(() => hasMetric(metrics!, metric))
  } finally {
    await client.shutdown({timeout: 1000})
  }
}, 20_000)
test.skipIf(!enabled)('disposable Victoria backends ingest official protobuf logs, spans and histograms', async () => {
  const id = composeId()
  const serviceName = `victoria-client-sdk-${id}`
  const metric = `victoria_client_sdk_${id}`
  const client = new OpenTelemetryClient({serviceName, endpoints: {
    logs: `${logs}/insert/opentelemetry/v1/logs`,
    metrics: `${metrics}/opentelemetry/v1/metrics`,
    traces: `${traces}/insert/opentelemetry/v1/traces`,
  }, compressionThreshold: 1})
  try {
    await client.assertHealth()
    expect(client.status().pendingRecords).toBe(0)
    client.logger.emit({body: 'protobuf-log'})
    client.tracer.startSpan('protobuf-trace').end()
    client.meter.createHistogram(metric).record(42)
    const report = await client.sync({timeout: 5000})
    expect(Object.values(report.signals).every(signal => signal.sent >= 1 && signal.rejected === 0)).toBe(true)
    await waitFor(async () => (await queryLogs(logs!, `_time:5m "service.name":="${serviceName}"`)).includes('protobuf-log'))
    await waitFor(async () => (await queryLogs(traces!, `_time:5m "resource_attr:service.name":="${serviceName}"`)).includes('protobuf-trace'))
    await waitFor(() => hasMetric(metrics!, `${metric}_count`))
  } finally {
    await client.shutdown({timeout: 1000})
  }
}, 20_000)
