import {expect, test} from 'bun:test'

const {default: victoriaClient} = await import('#src/main.ts')
test('should run', () => {
  const result = victoriaClient()
  expect(result).toBe('victoria-client') // TODO Test actual functionality
})
