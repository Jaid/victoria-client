import {ROOT_CONTEXT, trace} from '@opentelemetry/api'
import OpenTelemetryClient from 'victoria-client/otel'

const endpoint = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT
if (!endpoint) {
  throw new Error('Set OTEL_EXPORTER_OTLP_ENDPOINT to a collector with all three pipelines.')
}
const telemetry = new OpenTelemetryClient({
  serviceName: 'sdk-example',
  endpoint,
})
try {
  const duration = telemetry.meter.createHistogram('job.duration', {unit: 's'})
  const span = telemetry.tracer.startSpan('job.run')
  telemetry.logger.emit({
    body: 'Observed a job.',
    context: trace.setSpan(ROOT_CONTEXT, span),
  })
  duration.record(0.25, {kind: 'example'})
  span.end()
  await telemetry.sync({timeout: 5000})
} finally {
  await telemetry.shutdown({timeout: 5000})
}
