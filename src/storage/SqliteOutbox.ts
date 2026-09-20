import type {Signal} from '../types.ts'
import type {DeadLetter, Lane, OutboxItem, OutboxOptions, PendingItem, QueueStats} from './base/Outbox.ts'

import {Database} from 'bun:sqlite'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

import composeId from 'compose-id'

import {signals} from '../types.ts'
import {positiveInteger} from '../util.ts'
import Outbox, {emptyLane} from './base/Outbox.ts'

export type SqliteOutboxOptions = OutboxOptions & {
  lease?: number
  now?: () => number
  path: string
}
type StoredItem = {
  body: Uint8Array
  createdAt: number
  id: number
  records: number
  signal: Signal
}
/** Transactional, bounded, single-owner outbox. Credentials and raw dead-letter payloads are not persisted. */
export default class SqliteOutbox extends Outbox {
  readonly database: Database
  #closed = false
  readonly #immediateTransaction: <T>(operation: () => T) => T
  readonly #lease: number
  #leaseError?: Error
  readonly #now: () => number
  readonly #owner = composeId()
  #timer?: ReturnType<typeof setInterval>
  constructor(options: SqliteOutboxOptions) {
    super(options)
    this.#now = options.now ?? Date.now
    this.#lease = positiveInteger(options.lease ?? 60_000, 'lease', 2_147_483_647)
    if (this.#lease < 3000) {
      throw new RangeError('lease must be at least 3000.')
    }
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), {recursive: true})
    }
    this.database = new Database(options.path, {
      create: true,
      readwrite: true,
      safeIntegers: false,
      strict: true,
    })
    const immediateTransaction = this.database.transaction((operation: () => unknown) => operation())
    this.#immediateTransaction = immediateTransaction.immediate as <T>(operation: () => T) => T
    try {
      this.database.run('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      this.#immediateTransaction(() => {
        this.database.run(`
          CREATE TABLE IF NOT EXISTS victoria_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS victoria_owner (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS victoria_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, signal TEXT NOT NULL, body BLOB NOT NULL, records INTEGER NOT NULL, createdAt REAL NOT NULL);
          CREATE INDEX IF NOT EXISTS victoria_queue_signal ON victoria_queue(signal,id);
          CREATE TABLE IF NOT EXISTS victoria_lanes (signal TEXT PRIMARY KEY, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS victoria_dead (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL);
        `)
        const schema = this.database.query<{
          value: string
        }, [
        ]>("SELECT value FROM victoria_meta WHERE key='schema'").get()
        if (schema && schema.value !== '1') {
          throw new Error('Unsupported Victoria outbox schema.')
        }
        this.database.query("INSERT OR IGNORE INTO victoria_meta VALUES ('schema','1')").run()
        const owner = this.database.query<{
          expires: number
        }, [
        ]>('SELECT expires FROM victoria_owner WHERE id=1').get()
        if (owner && owner.expires > this.#now()) {
          throw new Error('The SQLite outbox already has an active sender. Close it or wait for its lease to expire.')
        }
        this.database.query('INSERT INTO victoria_owner VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token, expires=excluded.expires').run(this.#owner, this.#now() + this.#lease)
      })
      this.#timer = setInterval(() => {
        try {
          this.transaction(() => {})
        } catch (error) {
          this.#leaseError = Error.isError(error) ? error : new Error('The outbox lease was lost.')
          clearInterval(this.#timer)
        }
      }, Math.floor(this.#lease / 3))
      this.#timer.unref()
    } catch (error) {
      this.database.close(true)
      throw error
    }
  }
  append(items: ReadonlyArray<PendingItem>) {
    return this.transaction(() => {
      for (const signal of signals) {
        const incoming = items.filter(item => item.signal === signal)
        const stats = this.#stats(signal)
        if (stats.items + incoming.length > this.maxItems || stats.bytes + incoming.reduce((n, item) => n + item.body.byteLength, 0) > this.maxBytes) {
          return false
        }
      }
      const insert = this.database.query('INSERT INTO victoria_queue(signal,body,records,createdAt) VALUES (?,?,?,?)')
      for (const item of items) {
        insert.run(item.signal, item.body, item.records, item.createdAt)
      }
      return true
    })
  }
  bind(fingerprint: string) {
    this.transaction(() => {
      const existing = this.database.query<{
        value: string
      }, [
      ]>("SELECT value FROM victoria_meta WHERE key='route'").get()
      if (existing && existing.value !== fingerprint) {
        throw new Error('The outbox belongs to different endpoints or codecs. Use a different outbox.')
      }
      this.database.query("INSERT OR IGNORE INTO victoria_meta VALUES ('route',?)").run(fingerprint)
    })
  }
  close() {
    if (this.#closed) {
      return
    }
    clearInterval(this.#timer)
    try {
      this.database.query('DELETE FROM victoria_owner WHERE id=1 AND token=?').run(this.#owner)
    } finally {
      this.database.close(true)
      this.#closed = true
    }
  }
  deadLetters() {
    return this.transaction(() => this.database.query<{
      entry: string
    }, [
    ]>('SELECT entry FROM victoria_dead ORDER BY id').all().map(row => JSON.parse(row.entry) as DeadLetter))
  }
  defer(signal: Signal, state: Lane) {
    this.transaction(() => this.database.query('INSERT INTO victoria_lanes VALUES (?,?) ON CONFLICT(signal) DO UPDATE SET state=excluded.state').run(signal, JSON.stringify(state)))
  }
  highWater() {
    return this.transaction(() => this.database.query<{
      id: number
    }, [
    ]>('SELECT COALESCE(MAX(id),0) AS id FROM victoria_queue').get()!.id)
  }
  lane(signal: Signal): Lane {
    return this.transaction(() => {
      const row = this.database.query<{
        state: string
      }, [
        string,
      ]>('SELECT state FROM victoria_lanes WHERE signal=?').get(signal)
      return row ? JSON.parse(row.state) as Lane : emptyLane()
    })
  }
  peek(signal: Signal, through: number, limit: number): Array<OutboxItem> {
    return this.transaction(() => this.database.query<StoredItem, [
      string,
      number,
      number,
    ]>('SELECT id,signal,body,records,createdAt FROM victoria_queue WHERE signal=? AND id<=? ORDER BY id LIMIT ?').all(signal, through, limit).map(row => ({
      ...row,
      body: new Uint8Array(row.body),
    })))
  }
  settle(signal: Signal, items: ReadonlyArray<OutboxItem>, failure?: DeadLetter) {
    this.transaction(() => {
      const remove = this.database.query('DELETE FROM victoria_queue WHERE signal=? AND id=?')
      for (const item of items) {
        remove.run(signal, item.id)
      }
      this.database.query('DELETE FROM victoria_lanes WHERE signal=?').run(signal)
      if (failure) {
        this.database.query('INSERT INTO victoria_dead(entry) VALUES (?)').run(JSON.stringify(failure))
        this.database.query('DELETE FROM victoria_dead WHERE id NOT IN (SELECT id FROM victoria_dead ORDER BY id DESC LIMIT ?)').run(this.maxDeadLetters)
      }
    })
  }
  stats(signal: Signal) {
    return this.transaction(() => this.#stats(signal))
  }
  [Symbol.dispose]() {
    this.close()
  }
    /** Application state and enqueue operations can share this transaction. Throw on rejected admission to roll back both. */
  transaction<T>(operation: () => T): T {
    if (this.#closed) {
      throw new Error('The outbox is closed.')
    }
    if (this.#leaseError) {
      throw this.#leaseError
    }
    return this.#immediateTransaction(() => {
      const result = this.database.query('UPDATE victoria_owner SET expires=? WHERE id=1 AND token=?').run(this.#now() + this.#lease, this.#owner)
      if (result.changes !== 1) {
        throw new Error('The outbox lease was lost to another sender.')
      }
      const value = operation()
      if (value instanceof Promise) {
        throw new TypeError('Outbox transactions must be synchronous.')
      }
      return value
    })
  }
  #stats(signal: Signal): QueueStats {
    const row = this.database.query<{
      bytes: number
      items: number
      oldestAt: number | null
      records: number
    }, [
      string,
    ]>('SELECT COUNT(*) AS items, COALESCE(SUM(records),0) AS records, COALESCE(SUM(length(body)),0) AS bytes, MIN(createdAt) AS oldestAt FROM victoria_queue WHERE signal=?').get(signal)!
    return {
      ...row,
      oldestAt: row.oldestAt ?? undefined,
    }
  }
}
