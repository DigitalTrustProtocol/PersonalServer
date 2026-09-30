/**
 * GraphManager — the only thing that touches the heap (architecture.md
 * § Components), mirroring AttentionX `background/graphManager.ts`.
 * Every read goes through @dtp/trust-query, which calls the one walk
 * (`IndexResolver`). Writes update SQLite and the heap together (ingest
 * pipeline), then bump `graphVersion` and notify listeners.
 */

import { Graph, indexResolver, type ITrustEvent, type TrustEdgeRecord } from '@dtp/trust-graph'
import {
  DEFAULT_RESOLVE_BOUNDS,
  SlotFloors,
  applyWithFloors,
  executeRatingQuery,
  executeTrustQuery,
  lookupCounts,
  lookupPage,
  neighborhoodLookup,
  positiveAuthorFrontier,
  slotWinner,
  type FloorApplyResult,
  type FrontierLimits,
  type FrontierResult,
  type LookupCountsParams,
  type LookupCountsResult,
  type LookupDirection,
  type LookupLimits,
  type LookupPage,
  type LookupParams,
  type NeighborhoodParams,
  type NeighborhoodResult,
  type RatingQuery,
  type RatingQueryResult,
  type TrustQuery,
  type TrustQueryResult,
} from '@dtp/trust-query'
import type { Repository, StoredClaim } from '../storage/repository.js'

/**
 * 10011 claims attached to the Graph instance (the extension attaches its
 * chrome maps the same way): twitterId → pubkey → claim event id.
 */
const claimsByGraph = new WeakMap<Graph, Map<string, Map<string, string>>>()

function graphClaims(graph: Graph): Map<string, Map<string, string>> {
  let claims = claimsByGraph.get(graph)
  if (!claims) {
    claims = new Map()
    claimsByGraph.set(graph, claims)
  }
  return claims
}

export interface GraphChange {
  graphVersion: number
  /** Wire ids of subjects whose statements changed. */
  subjects: string[]
}

export interface GraphStats {
  nodes: number
  edges: { '32009': number; '32014': number }
  claims: number
  hintedStatements: number
  deleteFloors: number
}

export class GraphManager {
  readonly graph = new Graph()
  readonly floors = new SlotFloors()
  graphVersion = 0
  #listeners = new Set<(change: GraphChange) => void>()
  #pending: string[] = []
  #edgeCounts = { '32009': 0, '32014': 0 }
  #hinted = 0

  /** Lifecycle § Start steps 2–4: claims, heap rows, floors; graphVersion = 1. */
  load(repository: Repository): { records: number; claims: number } {
    this.graph.clear()
    this.floors.clear()
    graphClaims(this.graph).clear()
    this.#edgeCounts = { '32009': 0, '32014': 0 }
    this.#hinted = 0
    const claims = repository.claims()
    for (const claim of claims) this.putClaim(claim)
    for (const [addressKey, floor] of repository.floors()) this.floors.raise(addressKey, floor)
    const records = repository.iterateHeapRecords((record) => {
      if (this.graph.applyTrustEvent(record as ITrustEvent)) this.#count(record, 1)
    })
    this.graphVersion = 1
    return { records, claims: claims.length }
  }

  onChange(listener: (change: GraphChange) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #count(record: TrustEdgeRecord, sign: 1 | -1): void {
    if (record.nValue === undefined) return
    const kind = String(record.kind) as '32009' | '32014'
    if (kind in this.#edgeCounts) this.#edgeCounts[kind] += sign
    if (record.hintPubkey) this.#hinted += sign
  }

  #touched(record: { subjectType?: string; subject?: string; pubkey: string }): void {
    if (record.subjectType && record.subject) this.#pending.push(`${record.subjectType}:${record.subject}`)
    this.#pending.push(`p:${record.pubkey}`)
  }

  /** Bump graphVersion once per write and tell listeners what changed. */
  commit(): GraphChange | undefined {
    if (this.#pending.length === 0) return undefined
    this.graphVersion += 1
    const change = { graphVersion: this.graphVersion, subjects: [...new Set(this.#pending)] }
    this.#pending = []
    for (const listener of this.#listeners) listener(change)
    return change
  }

  winner(addressKey: string): ITrustEvent | undefined {
    return slotWinner(this.graph, addressKey)
  }

  /** Heap apply for a stored 32009 / 32014 winner (floors checked first). */
  applyRecord(record: TrustEdgeRecord): FloorApplyResult {
    const previous = this.winner(record.addressKey)
    const result = applyWithFloors(this.graph, this.floors, record as ITrustEvent)
    if (result === 'applied') {
      if (previous) this.#count(previous, -1)
      this.#count(record, 1)
      this.#touched(record)
      if (previous && previous.subject !== record.subject) this.#touched(previous)
    }
    return result
  }

  /** Remove a slot's winner from the heap and set its floor (NIP-09). */
  removeSlot(addressKey: string, floor: number): ITrustEvent | undefined {
    const winner = this.winner(addressKey)
    if (winner) {
      this.graph.removeTrustEvent(winner)
      this.#count(winner, -1)
      this.#touched(winner)
    }
    this.floors.raise(addressKey, floor)
    return winner
  }

  raiseFloor(addressKey: string, floor: number): void {
    this.floors.raise(addressKey, floor)
  }

  putClaim(claim: StoredClaim): void {
    const claims = graphClaims(this.graph)
    // One winning 10011 per pubkey: drop whatever it claimed before.
    this.dropClaims(claim.pubkey, false)
    let byPubkey = claims.get(claim.twitterId)
    if (!byPubkey) {
      byPubkey = new Map()
      claims.set(claim.twitterId, byPubkey)
    }
    byPubkey.set(claim.pubkey, claim.eventId)
    this.#pending.push(`i:user:id:${claim.twitterId}`)
  }

  dropClaims(pubkey: string, touch = true): void {
    for (const [twitterId, byPubkey] of graphClaims(this.graph)) {
      if (byPubkey.delete(pubkey) && touch) this.#pending.push(`i:user:id:${twitterId}`)
      if (byPubkey.size === 0) graphClaims(this.graph).delete(twitterId)
    }
  }

  claimsFor(twitterId: string): Array<{ pubkey: string; eventId: string }> {
    const byPubkey = graphClaims(this.graph).get(twitterId)
    if (!byPubkey) return []
    return [...byPubkey]
      .map(([pubkey, eventId]) => ({ pubkey, eventId }))
      .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0))
  }

  /** Live (non-Delete) heap edges, O(1). */
  liveEdges(): number {
    return this.#edgeCounts['32009'] + this.#edgeCounts['32014']
  }

  stats(): GraphStats {
    let claims = 0
    for (const byPubkey of graphClaims(this.graph).values()) claims += byPubkey.size
    let nodes = 0
    for (const node of this.graph.nodesList) if (node) nodes += 1
    return {
      nodes,
      edges: { ...this.#edgeCounts },
      claims,
      hintedStatements: this.#hinted,
      deleteFloors: this.floors.size,
    }
  }

  // ---- reads (one payload per request) ----------------------------------

  trust(query: TrustQuery): TrustQueryResult {
    return executeTrustQuery(
      this.graph,
      indexResolver,
      { ...query, bounds: { ...DEFAULT_RESOLVE_BOUNDS, ...query.bounds } },
      this.graphVersion,
    )
  }

  rating(query: RatingQuery): RatingQueryResult {
    return executeRatingQuery(this.graph, indexResolver, query, this.graphVersion, DEFAULT_RESOLVE_BOUNDS)
  }

  lookup(direction: LookupDirection, params: LookupParams, limits: LookupLimits): LookupPage {
    return lookupPage(this.graph, this.graphVersion, direction, params, limits)
  }

  counts(params: LookupCountsParams, limits: LookupLimits): LookupCountsResult {
    return lookupCounts(this.graph, this.graphVersion, params, limits)
  }

  neighborhood(params: NeighborhoodParams, maxLimit: number): NeighborhoodResult {
    return neighborhoodLookup(this.graph, this.graphVersion, params, maxLimit)
  }

  frontier(roots: readonly string[], limits: FrontierLimits, now?: number): FrontierResult {
    return positiveAuthorFrontier(this.graph, roots, limits, now)
  }
}
