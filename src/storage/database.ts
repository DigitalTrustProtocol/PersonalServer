/**
 * SQLite (node:sqlite, WAL) — decision PS-D2. Schema per architecture.md
 * § Storage. Migrations are numbered; the version lives in `settings`.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS events (
      address_key TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      tags_json TEXT NOT NULL,
      content TEXT NOT NULL,
      sig TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('relay', 'local')),
      subject TEXT,
      subject_type TEXT,
      c_tag TEXT,
      n_value REAL,
      d_tag TEXT,
      activate INTEGER,
      expire INTEGER,
      labels_json TEXT,
      label_hints_json TEXT,
      scope_rank INTEGER,
      hint_pubkey TEXT,
      claim_twitter_id TEXT
    );
    CREATE INDEX IF NOT EXISTS events_pubkey ON events (pubkey);
    CREATE INDEX IF NOT EXISTS events_kind ON events (kind);
    CREATE INDEX IF NOT EXISTS events_hint_pubkey ON events (hint_pubkey) WHERE hint_pubkey IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sync_cursors (
      key TEXT PRIMARY KEY,
      relay_url TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      last_seen_created_at INTEGER NOT NULL,
      last_eose_at INTEGER,
      retry_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_observations (
      event_id TEXT NOT NULL,
      relay_url TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, relay_url)
    );

    CREATE TABLE IF NOT EXISTS slot_floors (
      address_key TEXT PRIMARY KEY,
      floor INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roots (
      pubkey TEXT PRIMARY KEY,
      configured INTEGER NOT NULL DEFAULT 0,
      last_active_day INTEGER
    );

    CREATE TABLE IF NOT EXISTS members (
      pubkey TEXT PRIMARY KEY,
      roles_json TEXT NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `,
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

function currentVersion(db: DatabaseSync): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get()
  if (!exists) return 0
  const row = db.prepare("SELECT value_json FROM settings WHERE key = 'schemaVersion'").get() as
    | { value_json: string }
    | undefined
  return row ? Number(JSON.parse(row.value_json)) : 0
}

export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db)
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than this server (${SCHEMA_VERSION})`)
  }
  while (version < SCHEMA_VERSION) {
    const next = version + 1
    const sql = MIGRATIONS[next]
    if (!sql) throw new Error(`missing migration ${next}`)
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare(
        "INSERT INTO settings (key, value_json) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      ).run(JSON.stringify(next))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    version = next
  }
  return version
}
