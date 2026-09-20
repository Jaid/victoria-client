/* eslint-disable typescript/no-use-before-define -- The public build command is listed before its private pipeline stages. */
import type {PackageFlavor} from './flavors.ts'

import {resolve} from 'node:path'

import fs from 'fs-extra'
import {build} from 'vite'

import {createViteConfig} from '../vite.config.ts'
import flavors from './flavors.ts'

const root = resolve(import.meta.dirname, '..')
const destination = resolve(root, 'dist/package')
const intermediateRoot = resolve(root, 'out/intermediate')
async function buildPackages() {
  await Promise.all([fs.emptyDir(destination), fs.emptyDir(intermediateRoot)])
  await run(['bun', 'tldw'])
  for (const flavor of flavors) {
    await buildFlavor(flavor)
  }
}
async function run(command: Array<string>, cwd = root) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (await child.exited !== 0) {
    throw new Error(`Build command failed: ${command.join(' ')}`)
  }
}
async function buildFlavor(flavor: PackageFlavor) {
  const stage = resolve(root, 'out/intermediate', flavor.name)
  await build(createViteConfig(flavor))
  await run([
    process.env.BUILD_LIB_BIN ?? (process.platform === 'win32' ? 'build_lib.exe' : 'build_lib'),
    stage,
    '--runtimeEntryFile',
    'src/main.js',
    '--precompiled',
    '--no-emitDts',
    '--copyFiles',
    'src',
    '--copyFiles',
    'assets',
    '--copyFiles',
    'types',
    '--optimizeCopiedScripts',
    '--terser-strength',
    'aggressive',
    '--mode',
    'production',
    '--outputFolder',
    destination,
  ])
}
if (import.meta.main) {
  await buildPackages()
}
