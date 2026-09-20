import assert from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import fs from 'fs-extra'

import packageJson from '../package.json'
import flavors from './flavors.ts'

const root = resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(join(tmpdir(), 'victoria-packages-'))
async function run(command: Array<string>, cwd = temporary) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = new Response(child.stdout)
  const errors = new Response(child.stderr)
  const [stdout, stderr, code] = await Promise.all([output.text(), errors.text(), child.exited])
  if (code !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${stdout}\n${stderr}`)
  }
  return stdout
}
try {
  const dependencies: Record<string, string> = {}
  for (const flavor of flavors) {
    const directory = join(root, 'dist/package', flavor.name, 'production')
    const manifest = await fs.readJson(join(directory, 'package.json')) as {
      dependencies?: Record<string, string>
      exports: Record<string, {
        default: string
        types: string
      }>
      name: string
      version: string
    }
    assert.equal(manifest.name, flavor.name)
    assert.equal(manifest.version, packageJson.version)
    if (!flavor.bun) {
      assert.equal(manifest.dependencies, undefined)
    }
    for (const entry of Object.values(manifest.exports)) {
      assert(await fs.pathExists(join(directory, entry.default)), `Missing runtime: ${entry.default}`)
      assert(await fs.pathExists(join(directory, entry.types)), `Missing declarations: ${entry.types}`)
    }
    await run(['bun', 'pm', 'pack', '--destination', temporary], directory)
    dependencies[flavor.name] = `file:${join(temporary, `${flavor.name}-${manifest.version}.tgz`).replaceAll('\\', '/')}`
  }
  await fs.writeJson(join(temporary, 'package.json'), {
    name: 'victoria-package-consumer',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: {'@types/bun': packageJson.devDependencies['@types/bun']},
  }, {spaces: 2})
  await run(['bun', 'install', '--ignore-scripts'])
  const portableSource = `import Core from 'victoria-client'
import Browser from 'victoria-browser-client'
import DeliveryEngine from 'victoria-client/delivery'
const minimalCore = new Core
const minimalBrowser = new Browser
const core = new Core({serviceName: 'consumer', endpoint: 'https://collector.test'})
const browser = new Browser({serviceName: 'consumer', baseUrl: 'https://app.test', endpoint: '/telemetry'})
const delivery: DeliveryEngine = core.delivery
const health: Promise<void> = browser.assertHealth({timeout: 100})
const result: Promise<boolean> = core.sync({required: false})
void minimalCore; void minimalBrowser; void delivery; void health; void result
`
  await fs.writeFile(join(temporary, 'portable.ts'), portableSource)
  const compiler = join(root, 'node_modules/typescript/bin/tsc')
  const compilerOptions = {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    lib: ['esnext', 'dom', 'dom.iterable'],
    types: [],
    skipLibCheck: false,
  }
  await fs.writeJson(join(temporary, 'tsconfig.json'), {
    compilerOptions,
    files: ['portable.ts'],
  })
  await run(['bun', compiler, '--project', 'tsconfig.json'])
  await fs.writeFile(join(temporary, 'bun.ts'), `import BunClient from 'victoria-bun-client'
import Sdk from 'victoria-bun-client/otel'
import SqliteOutbox from 'victoria-bun-client/sqlite'
const client = new BunClient({serviceName: 'consumer', endpoint: 'https://collector.test', outbox: new SqliteOutbox({path: ':memory:'})})
const sdk = new Sdk({serviceName: 'consumer', endpoint: 'https://collector.test'})
void client.assertHealth(); void sdk.meter.createHistogram('duration')
`)
  await fs.writeJson(join(temporary, 'tsconfig.json'), {
    compilerOptions: {
      ...compilerOptions,
      types: ['bun'],
    },
    files: ['bun.ts'],
  })
  await run(['bun', compiler, '--project', 'tsconfig.json'])
  await fs.writeFile(join(temporary, 'runtime.ts'), `import assert from 'node:assert/strict'
import Core, {Outbox} from 'victoria-client'
import Browser from 'victoria-browser-client'
import BunClient, {Outbox as BunOutbox} from 'victoria-bun-client'
import DeliveryEngine from 'victoria-client/delivery'
import SqliteOutbox from 'victoria-bun-client/sqlite'
import Sdk from 'victoria-bun-client/otel'
const fetch = async () => Response.json({})
const minimal = new Core
assert.equal(minimal.resource['service.name'], 'runtime.ts')
assert.equal(minimal.delivery.targets.logs?.url, 'http://localhost:4318/v1/logs')
await minimal.shutdown()
const client = new Core({serviceName: 'packed', endpoint: 'https://collector.test', fetch})
assert(client.delivery instanceof DeliveryEngine)
assert(client.delivery.outbox instanceof Outbox)
client.info('packed')
await client.assertHealth()
assert.equal(await client.sync({required: false}), true)
await client.shutdown()
const browser = new Browser({serviceName: 'packed', baseUrl: 'https://app.test', endpoint: '/telemetry', fetch})
await browser.assertHealth()
await browser.shutdown()
const store = new SqliteOutbox({path: ':memory:'})
assert(store instanceof BunOutbox)
const bunClient = new BunClient({serviceName: 'packed', endpoint: 'https://collector.test', fetch, outbox: store})
await bunClient.wrap('parent', async parent => {
  await Bun.sleep(0)
  assert.equal(bunClient.currentSpan(), parent)
  bunClient.info('correlated')
})
await bunClient.assertHealth()
assert.equal(await bunClient.sync({required: false}), true)
await bunClient.shutdown()
const sdk = new Sdk({serviceName: 'packed', endpoint: 'https://collector.test', fetch: async () => new Response(new Uint8Array(), {headers: {'content-type': 'application/x-protobuf'}})})
await sdk.assertHealth()
sdk.logger.emit({body: 'packed SDK'})
assert.equal(await sdk.sync({required: false}), true)
await sdk.shutdown()
console.log('Packed runtimes, async context and shared class identity passed.')
`)
  console.log(await run(['bun', 'runtime.ts']))
  const browser = await Bun.build({
    entrypoints: [join(temporary, 'portable.ts')],
    target: 'browser',
    minify: true,
  })
  assert(browser.success, 'Packed portable/browser entry points failed to bundle.')
  console.log('Packed consumer declarations passed without Node/Bun types for portable and browser flavors.')
  console.log('All three tarballs passed isolated installation, export and runtime checks.')
} finally {
  await fs.remove(temporary)
}
