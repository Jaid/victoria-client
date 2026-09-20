import {canonical, decoder, encoder} from '../util.ts'
import Codec from './base/Codec.ts'

export type VictoriaSeries = {
  metric: Record<string, string>
  timestamps: Array<number>
  values: Array<number>
}
export default class VictoriaMetricsCodec extends Codec {
  readonly contentType = 'application/stream+json'
  readonly id = 'victoria-metrics-json:1'
  override readonly retryableStatuses = [408, 429, 500, 502, 503, 504]
  override readonly splitOn413 = true
  readonly successStatus = 204
  accept() {
    return {rejected: 0}
  }
  combine(parts: ReadonlyArray<Uint8Array>) {
    const series = new Map<string, {
      metric: Record<string, string>
      points: Map<number, number>
    }>
    for (const part of parts) {
      for (const line of decoder.decode(part).trim().split('\n')) {
        const row = JSON.parse(line) as VictoriaSeries
        const key = canonical(row.metric)
        let group = series.get(key)
        if (!group) {
          group = {
            metric: row.metric,
            points: new Map,
          }
          series.set(key, group)
        }
        for (let i = 0; i < row.timestamps.length; i++) {
          group.points.set(Math.trunc(row.timestamps[i]), row.values[i])
        }
      }
    }
    const rows = series.values().map(({metric, points}) => {
      const ordered = [...points].toSorted(([a], [b]) => a - b)
      return JSON.stringify({
        metric,
        timestamps: ordered.map(([time]) => time),
        values: ordered.map(([, value]) => value),
      })
    })
    return encoder.encode(`${[...rows].join('\n')}\n`)
  }
}
