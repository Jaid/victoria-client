export type PackageFlavor = {
  bun: boolean
  description: string
  entries: Record<string, string>
  name: 'victoria-browser-client' | 'victoria-bun-client' | 'victoria-client'
}

const flavors: ReadonlyArray<PackageFlavor> = [
  {
    name: 'victoria-client',
    description: 'environment-agnostic collection and delivery for VictoriaLogs, VictoriaMetrics and VictoriaTraces',
    entries: {
      main: 'src/main.ts',
      delivery: 'src/delivery/main.ts',
    },
    bun: false,
  },
  {
    name: 'victoria-browser-client',
    description: 'Victoria telemetry with browser page lifecycle integration and bounded keepalive delivery',
    entries: {
      main: 'src/browser/main.ts',
      delivery: 'src/delivery/main.ts',
    },
    bun: false,
  },
  {
    name: 'victoria-bun-client',
    description: 'Victoria telemetry for Bun with async context, optional SQLite persistence and OpenTelemetry SDK integration',
    entries: {
      main: 'src/bun/main.ts',
      delivery: 'src/delivery/main.ts',
      sqlite: 'src/storage/SqliteOutbox.ts',
      otel: 'src/otel/main.ts',
    },
    bun: true,
  },
]

export default flavors
