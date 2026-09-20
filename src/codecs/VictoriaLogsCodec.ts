import DeliveryError from '../delivery/DeliveryError.ts'
import {concat, decoder} from '../util.ts'
import Codec from './base/Codec.ts'

export default class VictoriaLogsCodec extends Codec {
  readonly contentType = 'application/stream+json'
  readonly id = 'victoria-logs-jsonline:1'
  override readonly retryableStatuses = [408, 429, 500, 502, 503, 504]
  override readonly splitOn413 = true
  readonly successStatus = 200
  accept(body: Uint8Array, contentType: string | null) {
    if (contentType?.includes('text/html') || decoder.decode(body).trim()) {
      throw new DeliveryError('Expected an empty VictoriaLogs ingestion response.', 'permanent')
    }
    return {rejected: 0}
  }
  combine(parts: ReadonlyArray<Uint8Array>) {
    return concat(parts)
  }
}
