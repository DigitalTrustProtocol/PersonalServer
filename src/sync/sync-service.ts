/**
 * Relay sync (specs/sync.md): the extension's synchronizer and live
 * supervisor from `@dtp/relay-sync`, with SQLite-backed ports. Everything
 * it fetches goes through the same ingest pipeline as `EVENT`.
 *
 * Strategies: `frontier-continuous` (default: a frontier pass, then live
 * frontier subscriptions; the frontier is re-synced after 32009 changes,
 * debounced, and every 15 min), `frontier-interval` (a pass every N
 * minutes), `global-continuous` (author-unfiltered live 32009 / 32014).
 */

import type { Event } from 'nostr-tools'
import {
  LiveSyncSupervisor,
  RelaySynchronizer,
  type EventIngestResult,
  type GraphFrontierReader,
  type GraphSyncLimits,
  type RelayEventRepository,
  type SyncCursor,
  type SyncCursorRepository,
} from '@dtp/relay-sync'
import { positiveAuthorFrontier, positiveChildren } from '@dtp/trust-query'
import type { GraphManager } from '../graph/graph-manager.js'
import type { IngestPipeline } from '../ingest/pipeline.js'
import type { Logger } from '../log.js'
import type { Repository } from '../storage/repository.js'
import type { Telemetry } from '../telemetry/telemetry.js'
import { RelayPool } from './relay-pool.js'

export type SyncStrategy = 'frontier-continuous' | 'frontier-interval' | 'global-continuous'

/** Personal Server bounds (sync.md § Frontier). */
export const PERSONAL_SYNC_LIMITS: GraphSyncLimits = {
  maxDepth: 3,
  maxAuthorsPerLevel: 500,
  maxTotalAuthors: 5_000,
  maxEvents: 200_000,
  maxRatingEvents: 200_000,
  maxDiscoveryEvents: 20_000,
}

export const SYNC_SCOPE = 'dtp-personal'
const OVERLAP_SECONDS = 600
const RESYNC_EVERY_MS = 15 * 60_000
const FRONTIER_DEBOUNCE_MS = 1_000
const IDLE_POLL_MS = 5_000
const CLAIM_BATCH = 20

export class SqliteCursorRepository implements SyncCursorRepository {
  constructor(private readonly repo: Repository) {}

  async getCursor(relayUrl: string, scope: string): Promise<SyncCursor | undefined> {
    const row = this.repo.db
      .prepare('SELECT * FROM sync_cursors WHERE key = ?')
      .get(`${relayUrl}\n${scope}`) as
      | { relay_url: string; scope_hash: string; last_seen_created_at: number; last_eose_at: number | null; retry_json: string }
      | undefined
    if (!row) return undefined
    const retry = JSON.parse(row.retry_json) as SyncCursor['retry'] | null
    return {
      relayUrl: row.relay_url,
      scope: row.scope_hash,
      lastSeenCreatedAt: Number(row.last_seen_created_at),
      lastEoseAt: Number(row.last_eose_at ?? 0),
      ...(retry ? { retry } : {}),
    }
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    this.repo.db
      .prepare(
        `INSERT INTO sync_cursors (key, relay_url, scope_hash, last_seen_created_at, last_eose_at, retry_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_seen_created_at = excluded.last_seen_created_at,
           last_eose_at = excluded.last_eose_at, retry_json = excluded.retry_json, updated_at = excluded.updated_at`,
      )
      .run(
        `${cursor.relayUrl}\n${cursor.scope}`,
        cursor.relayUrl,
        cursor.scope,
        cursor.lastSeenCreatedAt,
        cursor.lastEoseAt,
        JSON.stringify(cursor.retry ?? null),
        Math.floor(Date.now() / 1000),
      )
  }
}

export class PipelineEventRepository implements RelayEventRepository {
  constructor(
    private readonly pipeline: IngestPipeline,
    private readonly repo: Repository,
  ) {}

  async ingestEvent(event: Event): Promise<EventIngestResult> {
    const outcome = await this.pipeline.ingest(event, 'relay')
    if (outcome.result === 'accepted') return 'stored'
    if (outcome.result === 'duplicate') return 'duplicate'
    return 'rejected'
  }

  async listEventsByAuthor(author: string, kind: number): Promise<readonly Event[]> {
    return this.repo.byAuthorsKinds([author], [kind], { limit: 100_000 }) as Event[]
  }
}

export class HeapFrontierReader implements GraphFrontierReader {
  constructor(private readonly graph: GraphManager) {}

  positiveChildren(authors: readonly string[], nowSeconds: number): string[] {
    return [...positiveChildren(this.graph.graph, authors, nowSeconds).keys()]
  }

  authorsFromRoots(
    roots: readonly string[],
    nowSeconds: number,
    limits: { maxDepth: number; maxAuthorsPerLevel: number; maxTotalAuthors: number },
  ): { authors: string[]; reasons: string[] } {
    const result = positiveAuthorFrontier(this.graph.graph, roots, limits, nowSeconds)
    return { authors: result.authors.map((a) => a.pubkey), reasons: result.reasons }
  }
}

export interface SyncDeps {
  repo: Repository
  graph: GraphManager
  pipeline: IngestPipeline
  telemetry: Telemetry
  logger: Logger
  maxHeapEdges: number
  /** A root finished its first sync this run (coverage push). */
  onRootWarm(root: string): void
  pool?: RelayPool
}

export class SyncService {
  readonly pool: RelayPool
  readonly #deps: SyncDeps
  readonly #sync: RelaySynchronizer
  #supervisor: LiveSyncSupervisor | undefined
  #supervisorKey = ''
  #abort = new AbortController()
  #running = false
  #loop: Promise<void> | undefined
  #kick: (() => void) | undefined
  #dirty = false
  #debounce: NodeJS.Timeout | undefined
  readonly #synced = new Set<string>()
  #frontier: { size: number; truncationReasons: string[] } | null = null
  #lastPassAt = 0
  #lastAuthorsKey = ''

  constructor(deps: SyncDeps) {
    this.#deps = deps
    this.pool = deps.pool ?? new RelayPool()
    this.#sync = new RelaySynchronizer({
      client: this.pool,
      cursors: new SqliteCursorRepository(deps.repo),
      events: new PipelineEventRepository(deps.pipeline, deps.repo),
      frontier: new HeapFrontierReader(deps.graph),
      onProvenance: (o) => {
        if (o.ingestResult !== 'rejected') deps.repo.observe(o.eventId, o.relayUrl, Math.floor(o.observedAt / 1000))
      },
    })
    deps.graph.onChange((change) => {
      if (!change.subjects.some((s) => s.startsWith('p:'))) return
      clearTimeout(this.#debounce)
      this.#debounce = setTimeout(() => {
        this.#dirty = true
        this.#kick?.()
      }, FRONTIER_DEBOUNCE_MS)
      this.#debounce.unref()
    })
  }

  relays(): string[] {
    return this.#deps.repo.setting<string[]>('relays', [])
  }

  enabled(): boolean {
    return this.#deps.repo.setting<boolean>('sync.enabled', true)
  }

  strategy(): SyncStrategy {
    return this.#deps.repo.setting<SyncStrategy>('sync.strategy', 'frontier-continuous')
  }

  roots(): string[] {
    return this.#deps.repo.roots().map((r) => r.pubkey)
  }

  /** A root still waiting for its first completed sync pass (root-warming). */
  warming(root: string): boolean {
    return this.#running && this.enabled() && this.relays().length > 0 && !this.#synced.has(root)
  }

  warmingCount(): number {
    return this.roots().filter((root) => this.warming(root)).length
  }

  frontier(): { size: number; truncationReasons: string[] } | null {
    return this.#frontier
  }

  /** Wake the loop now (new root, new relay, `sync refresh`). */
  kick(): void {
    this.#dirty = true
    this.#kick?.()
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#abort = new AbortController()
    this.#loop = this.#run()
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#abort.abort()
    clearTimeout(this.#debounce)
    this.#kick?.()
    this.#supervisor?.stop()
    this.#supervisor = undefined
    await this.#loop?.catch(() => undefined)
    this.pool.close()
  }

  async #wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref()
      this.#kick = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.#kick = undefined
  }

  /** Settings are re-read every tick, so CLI changes (`sync stop`, `relays add`) apply live. */
  async #run(): Promise<void> {
    while (this.#running) {
      const relays = this.relays()
      const roots = this.roots()
      if (!this.enabled() || relays.length === 0 || roots.length === 0) {
        this.#supervisor?.stop()
        this.#supervisor = undefined
        await this.#wait(IDLE_POLL_MS)
        continue
      }
      const strategy = this.strategy()
      const refreshAt = this.#deps.repo.setting<number>('sync.refreshAt', 0) * 1000
      const every =
        strategy === 'frontier-interval'
          ? this.#deps.repo.setting<number>('sync.intervalMinutes', 15) * 60_000
          : RESYNC_EVERY_MS
      // A 32009 change only warrants a new pass when it changed the frontier itself.
      const relaysChanged = !this.#lastAuthorsKey.startsWith(`${relays.join(',')}|`)
      const frontierMoved = (this.#dirty || relaysChanged) && this.#frontierKey(roots, relays) !== this.#lastAuthorsKey
      this.#dirty = false
      const due = frontierMoved || this.#lastPassAt === 0 || refreshAt > this.#lastPassAt || Date.now() - this.#lastPassAt > every
      let passed = false
      if (strategy !== 'global-continuous' && due) {
        await this.#pass(relays, roots)
        this.#lastAuthorsKey = this.#frontierKey(roots, relays)
        passed = true
      }
      if (strategy === 'frontier-interval') {
        this.#supervisor?.stop()
        this.#supervisor = undefined
      } else if (passed || !this.#supervisor || this.#supervisorKey !== `${strategy}|${relays.join(',')}`) {
        this.#live(strategy, relays)
        if (strategy === 'global-continuous') for (const root of roots) this.#markWarm(root)
      }
      await this.#wait(IDLE_POLL_MS)
    }
  }

  async #pass(relays: string[], roots: string[]): Promise<void> {
    if (this.#deps.graph.liveEdges() >= this.#deps.maxHeapEdges) {
      // Memory guardrail: stop growing the frontier.
      this.#deps.telemetry.guardrail('heapEdges')
      return
    }
    try {
      const result = await this.#sync.synchronize({
        relayUrls: relays,
        rootPubkeys: roots,
        scope: SYNC_SCOPE,
        overlapSeconds: OVERLAP_SECONDS,
        limits: PERSONAL_SYNC_LIMITS,
        signal: this.#abort.signal,
      })
      this.#frontier = { size: result.authors.length, truncationReasons: result.truncationReasons }
      await this.#claims(relays, result.authors)
      this.#lastPassAt = Date.now()
      if (result.complete) for (const root of roots) this.#markWarm(root)
      this.#deps.logger.info(
        `sync pass: ${result.authors.length} authors, ${result.eventsStored} stored, ${result.duplicates} duplicates, ${result.rejected} rejected`,
      )
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#deps.logger.warn(`sync pass failed: ${(error as Error).message}`)
      this.#lastPassAt = Date.now()
    }
  }

  /** Kind 10011 for frontier authors and for npubs they hint (sync.md § Identity claims). */
  async #claims(relays: string[], authors: readonly string[]): Promise<void> {
    const wanted = new Set(authors)
    for (const pubkey of this.#deps.repo.hintedPubkeys(authors)) wanted.add(pubkey)
    const list = [...wanted]
    for (const relayUrl of relays) {
      for (let i = 0; i < list.length; i += CLAIM_BATCH) {
        if (this.#abort.signal.aborted) return
        try {
          await this.pool.query({
            relayUrl,
            filter: { kinds: [10011], authors: list.slice(i, i + CLAIM_BATCH) },
            onEvent: async (event) => {
              await this.#deps.pipeline.ingest(event, 'relay')
            },
            signal: this.#abort.signal,
          })
        } catch (error) {
          this.#deps.logger.warn(`claim fetch failed on a relay: ${(error as Error).message}`)
          break
        }
      }
    }
  }

  #live(strategy: SyncStrategy, relays: string[]): void {
    const authors = strategy === 'global-continuous' ? [] : this.#deps.graph.frontier(this.roots(), PERSONAL_SYNC_LIMITS).authors.map((a) => a.pubkey)
    const key = `${strategy}|${relays.join(',')}`
    if (this.#supervisor && this.#supervisorKey === key) {
      if (strategy !== 'global-continuous') this.#supervisor.replaceAuthors(authors)
      return
    }
    this.#supervisor?.stop()
    this.#supervisorKey = key
    this.#supervisor = new LiveSyncSupervisor({
      client: this.pool,
      cursors: new SqliteCursorRepository(this.#deps.repo),
      ingest: async (event) => new PipelineEventRepository(this.#deps.pipeline, this.#deps.repo).ingestEvent(event),
    })
    void this.#supervisor
      .start({
        relayUrls: relays,
        mode: strategy === 'global-continuous' ? 'global' : 'frontier',
        ...(strategy === 'global-continuous' ? {} : { authors }),
        scope: SYNC_SCOPE,
        overlapSeconds: OVERLAP_SECONDS,
        signal: this.#abort.signal,
      })
      .catch((error: Error) => this.#deps.logger.warn(`live sync stopped: ${error.message}`))
  }

  #frontierKey(roots: readonly string[], relays: readonly string[]): string {
    return relays.join(',') + '|' + this.#deps.graph
      .frontier(roots, PERSONAL_SYNC_LIMITS)
      .authors.map((a) => a.pubkey)
      .sort()
      .join(',')
  }

  #markWarm(root: string): void {
    if (this.#synced.has(root)) return
    this.#synced.add(root)
    this.#deps.onRootWarm(root)
  }
}
