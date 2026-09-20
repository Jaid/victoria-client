import VictoriaClient from 'victoria-client'

const host = Bun.env.VICTORIA_HOST
if (!host) {
  throw new Error('Set VICTORIA_HOST to an explicitly chosen ingestion host.')
}
const telemetry = new VictoriaClient('example', {host})
try {
  telemetry.info('Started.')
  telemetry.pushMetric({
    workers_active: 3,
    tasks_waiting: 12,
  })
  telemetry.pushTrace('weather-sensor.update', {
    sampleDuration: 89,
    degrees: {celsius: 20},
  })
  await telemetry.sync({timeout: 5000})
} finally {
  await telemetry.shutdown({timeout: 5000})
}
