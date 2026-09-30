/**
 * Ingest pipeline (architecture.md § Lifecycle, resolver-api.md § Ingest):
 * verify → scope eligibility → slot reduction → one SQLite transaction →
 * heap apply in the same tick → graphVersion. Used by `EVENT`, the CLI
 * import, and (later) relay sync. Answers carry NIP-01 `OK` prefixes.
 *
 * Signatures are checked in the worker pool when one is given (the server),
 * inline otherwise (offline CLI import).
 */

import { validateEvent, type Event } from 'nostr-tools'
import { classifyEvent, type EventRecord, type IdentityClaim, type ParsedDeletion } from '@dtp/trust-protocol'
import type { GraphManager } from '../graph/graph-manager.js'
import type { VerifyPool } from './verify-pool.js'
import type { EventSource, Repository } from '../storage/repository.js'
import type { IngestResult, Telemetry } from '../telemetry/telemetry.js'

export interface IngestOutcome {
  ok: boolean
  /** NIP-01 `OK` message: empty, or `<prefix>: <reason>`. */
  message: string
  result: IngestResult
  eventId: string
}

export interface IngestOptions {
  maxHeapEdges: number
  now?: () => number
  /** Off-thread signature checks; without it verification runs inline. */
  verifier?: VerifyPool
}

const VERIFIED_KINDS = new Set([32009, 32014, 10011, 5])

function eventIdOf(input: unknown): string {
  const id = (input as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : ''
}

function isNewer(candidate: { created_at: number; id: string }, current: { created_at: number; id: string }): boolean {
  return candidate.created_at > current.created_at || (candidate.created_at === current.created_at && candidate.id < current.id)
}

export class IngestPipeline {
  readonly #repo: Repository
  readonly #graph: GraphManager
  readonly #telemetry: Telemetry
  readonly #options: IngestOptions

  constructor(repo: Repository, graph: GraphManager, telemetry: Telemetry, options: IngestOptions) {
    this.#repo = repo
    this.#graph = graph
    this.#telemetry = telemetry
    this.#options = options
  }

  #now(): number {
    return this.#options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  #done(kind: number, eventId: string, ok: boolean, result: IngestResult, message = ''): IngestOutcome {
    const prefix = message.includes(':') ? message.slice(0, message.indexOf(':')) : undefined
    this.#telemetry.recordIngest(kind, result, ok ? undefined : prefix)
    return { ok, message, result, eventId }
  }

  async ingest(input: unknown, source: EventSource): Promise<IngestOutcome> {
    const eventId = eventIdOf(input)
    const rawKind = Number((input as { kind?: unknown } | null)?.kind)
    let verifyInline = true
    const verifier = this.#options.verifier
    if (verifier && VERIFIED_KINDS.has(rawKind) && validateEvent(input) && typeof (input as Event).sig === 'string') {
      if (!(await verifier.verify(input as Event))) {
        return this.#done(rawKind, eventId, false, 'invalid', 'invalid: event id or signature does not verify')
      }
      verifyInline = false
    }
    const classified = await classifyEvent(input, { now: this.#now(), verifyEvent: verifyInline })
    switch (classified.type) {
      case 'rejected':
        return this.#done(
          rawKind,
          eventId,
          false,
          classified.prefix === 'invalid' ? 'invalid' : 'blocked',
          `${classified.prefix}: ${classified.message}`,
        )
      case 'statement':
        return this.#putWinner(classified.record, source)
      case 'identity':
        return this.#putWinner(classified.record, source, classified.claim)
      case 'deletion':
        return this.#delete(classified.deletion)
      default: {
        const _exhaustive: never = classified
        return _exhaustive
      }
    }
  }

  /** Slot reduction + store + heap, synchronously (no await between compare and write). */
  #putWinner(record: EventRecord, source: EventSource, claim?: IdentityClaim): IngestOutcome {
    const kind = record.kind
    if (this.#graph.floors.blocks(record)) {
      return this.#done(kind, record.id, false, 'blocked', 'blocked: deleted')
    }
    const current = this.#repo.getWinner(record.addressKey)
    if (current) {
      if (current.id === record.id) return this.#done(kind, record.id, true, 'duplicate', 'duplicate: already have this event')
      if (!isNewer(record, current)) {
        return this.#done(kind, record.id, true, 'duplicate', 'duplicate: older than the stored winner')
      }
    } else if (kind !== 10011) {
      if (this.#graph.liveEdges() >= this.#options.maxHeapEdges) {
        this.#telemetry.guardrail('heapEdges')
        return this.#done(kind, record.id, false, 'rate_limited', 'rate-limited: heap edge limit reached')
      }
    }
    this.#repo.transaction(() => this.#repo.putWinner(record, source, claim?.twitterId))
    if (kind === 10011) {
      this.#graph.dropClaims(record.pubkey)
      if (claim) this.#graph.putClaim({ pubkey: claim.pubkey, twitterId: claim.twitterId, eventId: claim.eventId })
    } else {
      const { tags: _tags, sig: _sig, ...heapRecord } = record
      this.#graph.applyRecord(heapRecord)
    }
    this.#graph.commit()
    return this.#done(kind, record.id, true, 'accepted')
  }

  /** NIP-09: only the target's author; the kind 5 itself is not stored. */
  #delete(deletion: ParsedDeletion): IngestOutcome {
    const author = deletion.event.pubkey.toLowerCase()
    const deletionAt = deletion.event.created_at
    let removed = 0
    let floors = 0
    this.#repo.transaction(() => {
      for (const id of deletion.eventIds) {
        const target = this.#repo.getById(id)
        if (!target || target.pubkey !== author) continue
        this.#repo.deleteWinner(target.addressKey)
        this.#repo.raiseFloor(target.addressKey, target.created_at)
        this.#removeFromHeap(target.kind, target.addressKey, target.pubkey, target.created_at)
        removed += 1
        floors += 1
      }
      for (const address of deletion.addresses) {
        const target = this.#repo.getWinner(address.addressKey)
        if (target && target.created_at <= deletionAt) {
          this.#repo.deleteWinner(address.addressKey)
          removed += 1
        }
        this.#repo.raiseFloor(address.addressKey, deletionAt)
        if (target && target.created_at <= deletionAt) {
          this.#removeFromHeap(target.kind, address.addressKey, target.pubkey, deletionAt)
        } else {
          this.#graph.raiseFloor(address.addressKey, deletionAt)
        }
        floors += 1
      }
    })
    this.#graph.commit()
    if (removed === 0 && floors === 0) {
      return this.#done(5, deletion.event.id, false, 'blocked', 'blocked: no held event matches this deletion')
    }
    this.#telemetry.recordIngest(5, 'deleted')
    return this.#done(5, deletion.event.id, true, 'accepted')
  }

  #removeFromHeap(kind: number, addressKey: string, pubkey: string, floor: number): void {
    if (kind === 10011) {
      this.#graph.dropClaims(pubkey)
      this.#graph.raiseFloor(addressKey, floor)
    } else {
      this.#graph.removeSlot(addressKey, floor)
    }
  }
}
