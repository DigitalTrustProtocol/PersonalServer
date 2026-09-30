/**
 * Repository port over SQLite (architecture.md § Storage). One winner per
 * slot; replacing a winner deletes the superseded row and its observations
 * in the same transaction. Rehydrate reads graph columns only — no signature
 * checks and no tag parsing.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { TrustEdgeRecord } from '@dtp/trust-graph'
import type { EventRecord, SignedNostrEvent } from '@dtp/trust-protocol'

export type EventSource = 'relay' | 'local'

export interface StoredEvent extends EventRecord {
  source: EventSource
  claimTwitterId?: string
}

export interface StoredClaim {
  pubkey: string
  twitterId: string
  eventId: string
}

export interface MemberRow {
  pubkey: string
  roles: string[]
  banned: boolean
}

export interface RootRow {
  pubkey: string
  configured: boolean
  lastActiveDay: number | null
}

interface EventRow {
  address_key: string
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags_json: string
  content: string
  sig: string
  first_seen_at: number
  source: EventSource
  subject: string | null
  subject_type: 'p' | 'e' | 'i' | null
  c_tag: string | null
  n_value: number | null
  d_tag: string | null
  activate: number | null
  expire: number | null
  labels_json: string | null
  label_hints_json: string | null
  scope_rank: number | null
  hint_pubkey: string | null
  claim_twitter_id: string | null
}

const HEAP_KINDS = [32009, 32014]

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

function rowToStored(row: EventRow): StoredEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags_json) as string[][],
    content: row.content,
    sig: row.sig,
    firstSeenAt: row.first_seen_at,
    addressKey: row.address_key,
    source: row.source,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.subject_type !== null ? { subjectType: row.subject_type } : {}),
    ...(row.c_tag !== null ? { c_tag: row.c_tag } : {}),
    ...(row.n_value !== null ? { nValue: row.n_value } : {}),
    ...(row.d_tag !== null ? { addressableId: row.d_tag } : {}),
    ...(row.activate !== null ? { activate: row.activate } : {}),
    ...(row.expire !== null ? { expire: row.expire } : {}),
    ...(row.labels_json !== null ? { labels: JSON.parse(row.labels_json) as string[] } : {}),
    ...(row.label_hints_json !== null
      ? { labelHints: JSON.parse(row.label_hints_json) as Record<string, string> }
      : {}),
    ...(row.scope_rank !== null ? { scopeRank: row.scope_rank } : {}),
    ...(row.hint_pubkey !== null ? { hintPubkey: row.hint_pubkey } : {}),
    ...(row.claim_twitter_id !== null ? { claimTwitterId: row.claim_twitter_id } : {}),
  }
}

/** Heap record from graph columns: the signed tags and signature stay on disk. */
function rowToHeap(row: EventRow): TrustEdgeRecord {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    content: row.content,
    addressKey: row.address_key,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.subject_type !== null ? { subjectType: row.subject_type } : {}),
    c_tag: row.c_tag ?? '',
    ...(row.n_value !== null ? { nValue: row.n_value } : {}),
    ...(row.activate !== null ? { activate: row.activate } : {}),
    ...(row.expire !== null ? { expire: row.expire } : {}),
    ...(row.labels_json !== null ? { labels: JSON.parse(row.labels_json) as string[] } : {}),
    ...(row.label_hints_json !== null
      ? { labelHints: JSON.parse(row.label_hints_json) as Record<string, string> }
      : {}),
    ...(row.scope_rank !== null ? { scopeRank: row.scope_rank } : {}),
    ...(row.hint_pubkey !== null ? { hintPubkey: row.hint_pubkey } : {}),
  }
}

export function signedEvent(event: SignedNostrEvent): SignedNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  }
}

export class Repository {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get db(): DatabaseSync {
    return this.#db
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- events ----------------------------------------------------------

  getWinner(addressKey: string): StoredEvent | undefined {
    const row = this.#db.prepare('SELECT * FROM events WHERE address_key = ?').get(addressKey) as
      | EventRow
      | undefined
    return row ? rowToStored(row) : undefined
  }

  getById(id: string): StoredEvent | undefined {
    const row = this.#db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined
    return row ? rowToStored(row) : undefined
  }

  getByIds(ids: readonly string[]): SignedNostrEvent[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.#db
      .prepare(`SELECT * FROM events WHERE id IN (${placeholders}) ORDER BY created_at DESC, id ASC`)
      .all(...ids) as unknown as EventRow[]
    return rows.map((row) => signedEvent(rowToStored(row)))
  }

  byAuthorsKinds(
    authors: readonly string[],
    kinds: readonly number[],
    options: { since?: number; until?: number; limit: number },
  ): SignedNostrEvent[] {
    if (authors.length === 0 || kinds.length === 0) return []
    const params: SQLInputValue[] = [...authors, ...kinds]
    let sql = `SELECT * FROM events WHERE pubkey IN (${authors.map(() => '?').join(',')}) AND kind IN (${kinds
      .map(() => '?')
      .join(',')})`
    if (options.since !== undefined) {
      sql += ' AND created_at >= ?'
      params.push(options.since)
    }
    if (options.until !== undefined) {
      sql += ' AND created_at <= ?'
      params.push(options.until)
    }
    sql += ' ORDER BY created_at DESC, id ASC LIMIT ?'
    params.push(options.limit)
    const rows = this.#db.prepare(sql).all(...params) as unknown as EventRow[]
    return rows.map((row) => signedEvent(rowToStored(row)))
  }

  /** Insert or replace a slot winner; drops the superseded row's observations. */
  putWinner(record: EventRecord, source: EventSource, claimTwitterId?: string): void {
    const previous = this.#db
      .prepare('SELECT id FROM events WHERE address_key = ?')
      .get(record.addressKey) as { id: string } | undefined
    if (previous && previous.id !== record.id) {
      this.#db.prepare('DELETE FROM relay_observations WHERE event_id = ?').run(previous.id)
    }
    this.#db
      .prepare(
        `INSERT INTO events (address_key, id, pubkey, created_at, kind, tags_json, content, sig, first_seen_at, source,
           subject, subject_type, c_tag, n_value, d_tag, activate, expire, labels_json, label_hints_json, scope_rank,
           hint_pubkey, claim_twitter_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address_key) DO UPDATE SET
           id = excluded.id, pubkey = excluded.pubkey, created_at = excluded.created_at, kind = excluded.kind,
           tags_json = excluded.tags_json, content = excluded.content, sig = excluded.sig,
           first_seen_at = excluded.first_seen_at, source = excluded.source, subject = excluded.subject,
           subject_type = excluded.subject_type, c_tag = excluded.c_tag, n_value = excluded.n_value,
           d_tag = excluded.d_tag, activate = excluded.activate, expire = excluded.expire,
           labels_json = excluded.labels_json, label_hints_json = excluded.label_hints_json,
           scope_rank = excluded.scope_rank, hint_pubkey = excluded.hint_pubkey,
           claim_twitter_id = excluded.claim_twitter_id`,
      )
      .run(
        record.addressKey,
        record.id,
        record.pubkey,
        record.created_at,
        record.kind,
        JSON.stringify(record.tags),
        record.content,
        record.sig,
        record.firstSeenAt,
        source,
        orNull(record.subject),
        orNull(record.subjectType),
        orNull(record.c_tag),
        orNull(record.nValue),
        orNull(record.addressableId),
        orNull(record.activate),
        orNull(record.expire),
        record.labels !== undefined ? JSON.stringify(record.labels) : null,
        record.labelHints !== undefined ? JSON.stringify(record.labelHints) : null,
        orNull(record.scopeRank),
        orNull(record.hintPubkey),
        orNull(claimTwitterId),
      )
  }

  deleteWinner(addressKey: string): void {
    const previous = this.#db.prepare('SELECT id FROM events WHERE address_key = ?').get(addressKey) as
      | { id: string }
      | undefined
    if (!previous) return
    this.#db.prepare('DELETE FROM relay_observations WHERE event_id = ?').run(previous.id)
    this.#db.prepare('DELETE FROM events WHERE address_key = ?').run(addressKey)
  }

  iterateHeapRecords(visit: (record: TrustEdgeRecord) => void): number {
    let count = 0
    const statement = this.#db.prepare(
      `SELECT * FROM events WHERE kind IN (${HEAP_KINDS.join(',')}) ORDER BY rowid`,
    )
    for (const row of statement.iterate() as IterableIterator<EventRow>) {
      visit(rowToHeap(row))
      count += 1
    }
    return count
  }

  claims(): StoredClaim[] {
    const rows = this.#db
      .prepare('SELECT pubkey, claim_twitter_id, id FROM events WHERE kind = 10011 AND claim_twitter_id IS NOT NULL')
      .all() as Array<{ pubkey: string; claim_twitter_id: string; id: string }>
    return rows.map((row) => ({ pubkey: row.pubkey, twitterId: row.claim_twitter_id, eventId: row.id }))
  }

  *iterateAll(): IterableIterator<SignedNostrEvent> {
    const statement = this.#db.prepare('SELECT * FROM events ORDER BY created_at ASC, id ASC')
    for (const row of statement.iterate() as IterableIterator<EventRow>) {
      yield signedEvent(rowToStored(row))
    }
  }

  countsByKind(): Record<string, number> {
    const rows = this.#db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all() as Array<{
      kind: number
      n: number
    }>
    return Object.fromEntries(rows.map((row) => [String(row.kind), Number(row.n)]))
  }

  // ---- slot floors -----------------------------------------------------

  floors(): Array<[string, number]> {
    const rows = this.#db.prepare('SELECT address_key, floor FROM slot_floors').all() as Array<{
      address_key: string
      floor: number
    }>
    return rows.map((row) => [row.address_key, Number(row.floor)])
  }

  raiseFloor(addressKey: string, floor: number): void {
    this.#db
      .prepare(
        'INSERT INTO slot_floors (address_key, floor) VALUES (?, ?) ON CONFLICT(address_key) DO UPDATE SET floor = MAX(floor, excluded.floor)',
      )
      .run(addressKey, floor)
  }

  // ---- roots -----------------------------------------------------------

  roots(): RootRow[] {
    const rows = this.#db.prepare('SELECT pubkey, configured, last_active_day FROM roots ORDER BY pubkey').all() as Array<{
      pubkey: string
      configured: number
      last_active_day: number | null
    }>
    return rows.map((row) => ({
      pubkey: row.pubkey,
      configured: row.configured === 1,
      lastActiveDay: row.last_active_day === null ? null : Number(row.last_active_day),
    }))
  }

  addConfiguredRoot(pubkey: string): void {
    this.#db
      .prepare(
        'INSERT INTO roots (pubkey, configured) VALUES (?, 1) ON CONFLICT(pubkey) DO UPDATE SET configured = 1',
      )
      .run(pubkey)
  }

  removeRoot(pubkey: string): boolean {
    return Number(this.#db.prepare('DELETE FROM roots WHERE pubkey = ?').run(pubkey).changes) > 0
  }

  /** A root set by `session.update` becomes active for 30 days (architecture.md § Roots). */
  touchActiveRoot(pubkey: string, day: number): void {
    this.#db
      .prepare(
        'INSERT INTO roots (pubkey, configured, last_active_day) VALUES (?, 0, ?) ON CONFLICT(pubkey) DO UPDATE SET last_active_day = excluded.last_active_day',
      )
      .run(pubkey, day)
  }

  pruneInactiveRoots(minDay: number): number {
    return Number(
      this.#db.prepare('DELETE FROM roots WHERE configured = 0 AND (last_active_day IS NULL OR last_active_day < ?)').run(minDay)
        .changes,
    )
  }

  // ---- members ---------------------------------------------------------

  members(): MemberRow[] {
    const rows = this.#db.prepare('SELECT pubkey, roles_json, banned FROM members ORDER BY pubkey').all() as Array<{
      pubkey: string
      roles_json: string
      banned: number
    }>
    return rows.map((row) => ({ pubkey: row.pubkey, roles: JSON.parse(row.roles_json) as string[], banned: row.banned === 1 }))
  }

  putMember(pubkey: string, roles: readonly string[], banned = false): void {
    this.#db
      .prepare(
        `INSERT INTO members (pubkey, roles_json, banned, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET roles_json = excluded.roles_json, banned = excluded.banned, updated_at = excluded.updated_at`,
      )
      .run(pubkey, JSON.stringify([...new Set(roles)].sort()), banned ? 1 : 0, Math.floor(Date.now() / 1000))
  }

  removeMember(pubkey: string): boolean {
    return Number(this.#db.prepare('DELETE FROM members WHERE pubkey = ?').run(pubkey).changes) > 0
  }

  // ---- settings --------------------------------------------------------

  setting<T>(key: string, fallback: T): T {
    const row = this.#db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row ? (JSON.parse(row.value_json) as T) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.#db
      .prepare(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      )
      .run(key, JSON.stringify(value))
  }
}
