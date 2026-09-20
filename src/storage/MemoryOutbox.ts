import type {Signal} from '../types.ts'
import type {DeadLetter, Lane, OutboxItem, PendingItem, QueueStats} from './base/Outbox.ts'

import {signals} from '../types.ts'
import Outbox, {emptyLane} from './base/Outbox.ts'

/** O(1) queue accounting and insertion; no growing-array scan on each collected event. */
export default class MemoryOutbox extends Outbox {
  #closed = false
  #dead: Array<DeadLetter> = []
  #fingerprint?: string
  #id = 0
  readonly #lanes = new Map<Signal, Lane>
  readonly #rows = new Map<Signal, Map<number, OutboxItem>>(signals.map(signal => [signal, new Map]))
  readonly #totals = new Map<Signal, {
    bytes: number
    records: number
  }>(signals.map(signal => [signal, {
    bytes: 0,
    records: 0,
  }]))
  append(items: ReadonlyArray<PendingItem>) {
    this.#assertOpen()
    const added = new Map<Signal, {
      bytes: number
      items: number
      records: number
    }>(signals.map(signal => [signal, {
      bytes: 0,
      records: 0,
      items: 0,
    }]))
    for (const item of items) {
      const total = added.get(item.signal)!
      total.bytes += item.body.byteLength
      total.records += item.records
      total.items++
    }
    for (const signal of signals) {
      const incoming = added.get(signal)!
      if (this.#rows.get(signal)!.size + incoming.items > this.maxItems || this.#totals.get(signal)!.bytes + incoming.bytes > this.maxBytes) {
        return false
      }
    }
    for (const item of items) {
      const id = ++this.#id
      this.#rows.get(item.signal)!.set(id, {
        ...item,
        id,
        body: new Uint8Array(item.body),
      })
    }
    for (const signal of signals) {
      const total = this.#totals.get(signal)!
      total.bytes += added.get(signal)!.bytes
      total.records += added.get(signal)!.records
    }
    return true
  }
  bind(fingerprint: string) {
    this.#assertOpen()
    if (this.#fingerprint && this.#fingerprint !== fingerprint) {
      throw new Error('The outbox belongs to different endpoints or codecs. Use a different outbox.')
    }
    this.#fingerprint = fingerprint
  }
  close() {
    this.#closed = true
  }
  deadLetters() {
    this.#assertOpen()
    return this.#dead.map(row => ({...row}))
  }
  defer(signal: Signal, lane: Lane) {
    this.#assertOpen()
    this.#lanes.set(signal, {...lane})
  }
  highWater() {
    this.#assertOpen()
    return this.#id
  }
  lane(signal: Signal) {
    this.#assertOpen()
    return {...this.#lanes.get(signal) ?? emptyLane()}
  }
  peek(signal: Signal, through: number, limit: number) {
    this.#assertOpen()
    const result: Array<OutboxItem> = []
    for (const row of this.#rows.get(signal)!.values()) {
      if (row.id > through || result.length >= limit) {
        break
      }
      result.push({
        ...row,
        body: new Uint8Array(row.body),
      })
    }
    return result
  }
  settle(signal: Signal, items: ReadonlyArray<OutboxItem>, failure?: DeadLetter) {
    this.#assertOpen()
    const rows = this.#rows.get(signal)!
    const total = this.#totals.get(signal)!
    for (const item of items) {
      const existing = rows.get(item.id)
      if (!existing) {
        continue
      }
      total.bytes -= existing.body.byteLength
      total.records -= existing.records
      rows.delete(item.id)
    }
    this.#lanes.delete(signal)
    if (failure) {
      this.#dead.push({...failure})
      this.#dead = this.#dead.slice(-this.maxDeadLetters)
    }
  }
  stats(signal: Signal): QueueStats {
    this.#assertOpen()
    const rows = this.#rows.get(signal)!
    return {
      items: rows.size,
      ...this.#totals.get(signal)!,
      oldestAt: rows.values().next().value?.createdAt,
    }
  }
  #assertOpen() {
    if (this.#closed) {
      throw new Error('The outbox is closed.')
    }
  }
}
