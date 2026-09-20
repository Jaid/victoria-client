import {expect, test} from 'bun:test'

import {fixture} from './support.ts'

test('optional sync returns true after delivery and false on connection failures', async () => {
  const success = fixture()
  success.client.info('ready')
  expect(await success.client.sync({required: false})).toBe(true)
  const failure = fixture({fetch: async () => {
    throw new Error('offline')
  }})
  failure.client.info('queued')
  expect(await failure.client.sync({
    required: false,
    timeout: 10,
  })).toBe(false)
  expect(failure.client.status().pendingRecords).toBe(1)
  await expect(failure.client.sync({
    required: true,
    timeout: 10,
  })).rejects.toBeDefined()
})
