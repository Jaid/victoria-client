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
