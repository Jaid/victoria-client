import type {PackageFlavor} from './scripts/flavors.ts'
import type {InlineConfig, Plugin} from 'vite'

import {isBuiltin} from 'node:module'
import {join, relative, resolve} from 'node:path'

import fs from 'fs-extra'
import ts from 'typescript'
import {defineConfig} from 'vite'

import packageJson from './package.json'
import bundledDependencies from './scripts/bundledDependencies.ts'
import flavors from './scripts/flavors.ts'

const root = import.meta.dirname
const bundledDependencySet = new Set<string>(bundledDependencies)
const dependencies = Object.keys(packageJson.dependencies).filter(dependency => !bundledDependencySet.has(dependency))
async function declarations(flavor: PackageFlavor, stage: string) {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), file => ts.sys.readFile(file))
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(Object.values(flavor.entries).map(entry => resolve(root, entry)), {
    ...parsed.options,
    composite: false,
    incremental: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    inlineSourceMap: false,
    sourceMap: false,
    rootDir: join(root, 'src'),
    outDir: join(stage, 'types'),
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }))
  }
  if (program.emit().emitSkipped) {
    throw new Error(`Declaration emit failed for ${flavor.name}.`)
  }
  for (const file of await fs.readdir(join(stage, 'types'), {
    recursive: true,
    encoding: 'utf8',
  })) {
    if (!file.endsWith('.d.ts')) {
      continue
    }
    const path = join(stage, 'types', file)
    const source = await fs.readFile(path, 'utf8')
    await fs.writeFile(path, source.replaceAll(/(["'])(\.{1,2}\/[^"']+)\.ts\1/gu, '$1$2.js$1'))
  }
}
const intermediatePlugin = (flavor: PackageFlavor, stage: string): Plugin => {
  return {
    name: 'victoria-lib-intermediate',
    async closeBundle() {
      await declarations(flavor, stage)
      await fs.mkdir(join(stage, 'assets'), {recursive: true})
      const exports = Object.fromEntries(Object.entries(flavor.entries).map(([name, source]) => [name === 'main' ? '.' : `./${name}`, {
        types: `./types/${relative('src', source).replaceAll('\\', '/').replace(/\.ts$/u, '.d.ts')}`,
        import: `./src/${name}.js`,
        default: `./src/${name}.js`,
      }]))
      const manifest = {
        name: flavor.name,
        version: packageJson.version,
        type: 'module',
        description: flavor.description,
        license: packageJson.license,
        repository: packageJson.repository,
        funding: packageJson.funding,
        sideEffects: false,
        files: ['src', 'assets', 'types', 'README.md', 'LICENSE'],
        exports,
        ...flavor.bun ? {dependencies: Object.fromEntries(Object.entries(packageJson.dependencies).filter(([name]) => !bundledDependencySet.has(name)))} : {},
      }
      await Promise.all([
        fs.outputJson(join(stage, 'package.json'), manifest, {spaces: 2}),
        fs.copy(join(root, 'readme.md'), join(stage, 'readme.md')),
        fs.copy(join(root, 'license.txt'), join(stage, 'license.txt')),
      ])
    },
  }
}

export function createViteConfig(flavor: PackageFlavor): InlineConfig {
  const stage = resolve(root, 'out/intermediate', flavor.name)
  return {
    root,
    configFile: false,
    publicDir: false,
    plugins: [intermediatePlugin(flavor, stage)],
    build: {
      target: 'esnext',
      minify: true,
      sourcemap: false,
      emptyOutDir: true,
      copyPublicDir: false,
      outDir: stage,
      lib: {
        entry: flavor.entries,
        formats: ['es'],
      },
      rolldownOptions: {
        external(id) {
          if (isBuiltin(id) || id.startsWith('bun:')) {
            if (!flavor.bun) {
              throw new Error(`Unexpected runtime import in ${flavor.name}: ${id}`)
            }
            return true
          }
          if (dependencies.some(dependency => id === dependency || id.startsWith(`${dependency}/`))) {
            if (!flavor.bun) {
              throw new Error(`Unexpected dependency in ${flavor.name}: ${id}`)
            }
            return true
          }
          return false
        },
        output: {
          codeSplitting: true,
          entryFileNames: 'src/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
        },
      },
    },
  }
}

export default defineConfig(({mode}) => {
  const flavor = flavors.find(candidate => candidate.name === mode) ?? flavors[0]
  return createViteConfig(flavor)
})
