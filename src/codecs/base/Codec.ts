export type Acceptance = {
  rejected: number
  warning?: string
}
/** Combines complete export requests without altering record identities or timestamps. */
export default abstract class Codec {
  abstract readonly contentType: string
  abstract readonly id: string
  readonly retryableStatuses: ReadonlyArray<number> = [429, 502, 503, 504]
  readonly splitOn413: boolean = false
  abstract readonly successStatus: number
  abstract accept(body: Uint8Array, contentType: string | null, records: number): Acceptance
  abstract combine(parts: ReadonlyArray<Uint8Array>): Uint8Array
}
