import {expect, test} from 'bun:test'

import VictoriaClient from '../src/main.ts'
import {clients, textBody, wireRecords} from './support.ts'

test('scheduled flush waits for collectors within their deadline', async () => {
  const requests: Array<{
    body: string
    collectorFinished: boolean
    url: string
  }> = []
  let collectorFinished = false
  const seenClients: Array<VictoriaClient> = []
  const client = new VictoriaClient({
    serviceName: 'collector-test',
    endpoint: 'http://collector.test',
    interval: 5,
    collectorTimeout: 100,
    fetch: async (url, init) => {
      requests.push({
        url,
        body: textBody(init),
        collectorFinished,
      })
      return Response.json({})
    },
  })
  clients.push(client)
  client.addCollector('system', async current => {
    seenClients.push(current)
    await Bun.sleep(10)
    current.metric('ram_free', 123)
    collectorFinished = true
  })
  await Bun.sleep(30)
  const request = requests.find(item => item.url.endsWith('/v1/metrics'))
  expect(request?.collectorFinished).toBe(true)
  expect(seenClients[0]).toBe(client)
  expect(wireRecords(request!.body, 'metrics').some(record => record.name === 'ram_free')).toBe(true)
})
test('slow collectors do not delay a scheduled flush past collectorTimeout', async () => {
  const requests: Array<{
    lateFinished: boolean
    url: string
  }> = []
  let lateFinished = false
  let runs = 0
  const client = new VictoriaClient({
    serviceName: 'collector-timeout',
    endpoint: 'http://collector.test',
    interval: 10,
    collectorTimeout: 20,
    fetch: async url => {
      requests.push({
        url,
        lateFinished,
      })
      return Response.json({})
    },
    collectors: [
      async current => {
        runs++
        if (runs !== 1) {
          return
        }
        await Bun.sleep(80)
        current.metric('late_metric', 1)
        lateFinished = true
      },
    ],
  })
  clients.push(client)
  client.log('ready')
  await Bun.sleep(45)
  expect(requests.some(request => request.url.endsWith('/v1/logs') && !request.lateFinished)).toBe(true)
  expect(requests.some(request => request.url.endsWith('/v1/metrics'))).toBe(false)
  await Bun.sleep(90)
  expect(requests.some(request => request.url.endsWith('/v1/metrics'))).toBe(true)
})
test('collector registry supports names, references and clearing', async () => {
  let removedRuns = 0
  let activeRuns = 0
  const removed = () => {
    removedRuns++
  }
  const active = () => {
    activeRuns++
  }
  const client = new VictoriaClient({
    serviceName: 'collector-registry',
    endpoint: 'http://collector.test',
    interval: 5,
    fetch: async () => Response.json({}),
    collectors: {
      removed,
    },
  })
  clients.push(client)
  expect(client.removeCollector('removed')).toBe(true)
  expect(client.removeCollector('removed')).toBe(false)
  client.addCollector(active)
  client.addCollector(active)
  await Bun.sleep(15)
  expect(removedRuns).toBe(0)
  expect(activeRuns).toBeGreaterThan(0)
  expect(client.removeCollector(active)).toBe(true)
  client.addCollector('active', active)
  client.clearCollectors()
  const before = activeRuns
  await Bun.sleep(15)
  expect(activeRuns).toBe(before)
})
