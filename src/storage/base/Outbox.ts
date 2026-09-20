import type {Signal} from '../../types.ts'

import {positiveInteger} from '../../util.ts'

export type PendingItem = {
  body: Uint8Array
  createdAt: number
  records: number
  signal: Signal
}
export type OutboxItem = PendingItem & {
  id: number
}
export type Lane = {
  attempts: number
  blocked: boolean
  lastError?: string
  retryAt: number
  through?: number
}
export const emptyLane = (): Lane => ({
  attempts: 0,
  retryAt: 0,
  blocked: false,
})
export type QueueStats = {
  bytes: number
  items: number
  oldestAt?: number
  records: number
}
export type DeadLetter = {
  bytes: number
  reason: string
  records: number
  signal: Signal
  time: number
}
export type OutboxOptions = {
  maxBytes?: number
  maxDeadLetters?: number
  maxItems?: number
}
/** Limits apply independently to each signal. Storage errors must never masquerade as successful admission. */
export default abstract class Outbox {
  readonly maxBytes: number
  readonly maxDeadLetters: number
  readonly maxItems: number
  constructor(options: OutboxOptions = {}) {
    this.maxItems = positiveInteger(options.maxItems ?? 2048, 'maxItems')
    this.maxBytes = positiveInteger(options.maxBytes ?? 16_000_000, 'maxBytes')
    this.maxDeadLetters = positiveInteger(options.maxDeadLetters ?? 100, 'maxDeadLetters')
  }
  abstract append(items: ReadonlyArray<PendingItem>): boolean
  abstract bind(fingerprint: string): void
  abstract close(): void
  abstract deadLetters(): Array<DeadLetter>
  abstract defer(signal: Signal, state: Lane): void
  abstract highWater(): number
  abstract lane(signal: Signal): Lane
  abstract peek(signal: Signal, through: number, limit: number): Array<OutboxItem>
  abstract settle(signal: Signal, items: ReadonlyArray<OutboxItem>, failure?: DeadLetter): void
  abstract stats(signal: Signal): QueueStats
}
