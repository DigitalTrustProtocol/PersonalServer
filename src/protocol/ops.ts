/**
 * DTP operations (resolver-api.md § Operations). Each handler returns one
 * payload built by GraphManager (→ @dtp/trust-query → the one walk).
 *
 * Walk budgets (`maxReachedNodes`, `maxWalkRecords`, and the operation
 * deadline) run inside the walk and report `truncated` + `completeDepth`;
 * deadlines are also checked between operations (batch items, lookup batch
 * entries).
 */

import {
  LookupError,
  limitRatingResult,
  limitTrustResult,
  type LookupCountsParams,
  type LookupLimits,
  type LookupParams,
  type NeighborhoodParams,
  type WalkBudgets,
  type WireRatingResult,
  type WireTrustResult,
} from '@dtp/trust-query'
import type { Guardrails } from '../config.js'
import type { GraphManager } from '../graph/graph-manager.js'
import { OpError, invalid } from './errors.js'
import { parseDefaults, resolveField, resolveQuery, type ResolvedQuery, type SessionDefaults } from './session.js'

export const PUSH_TOPICS = ['graph', 'coverage', 'want'] as const
export type PushTopic = (typeof PUSH_TOPICS)[number]

/** Operations this server implements. */
export const IMPLEMENTED_OPS = [
  'info',
  'session.update',
  'trust.query',
  'trust.batch',
  'rating.query',
  'rating.batch',
  'lookup.incoming',
  'lookup.outgoing',
  'lookup.counts',
  'lookup.batch',
  'graph.neighborhood',
  'graph.frontier',
  'graph.field',
  'identity.claims',
  'subscribe',
  'unsubscribe',
] as const

/** Operations named in `dtp.unsupported` with their reason; none today. */
export const UNSUPPORTED_OPS: Readonly<Record<string, string>> = Object.freeze({})

export interface OpContext {
  graph: GraphManager
  guardrails: Guardrails
  session: SessionDefaults
  subscriptions: Set<PushTopic>
  /** NIP-11 `dtp` object plus memory status. */
  info(): Record<string, unknown>
  /** A root set by session.update becomes an active root. */
  onActiveRoot(pubkey: string): void
  /** Server-side coverage reasons for a root (`root-warming`). */
  coverageReasons(root: string): string[]
  /** Absolute deadline (ms since epoch) for this operation. */
  deadlineAt: number
  isCancelled(): boolean
  /** Guardrail hit accounting. */
  guardrail(reason: string): void
}

function asObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object')
  return params as Record<string, unknown>
}

function lookupLimits(g: Guardrails): LookupLimits {
  return { maxKeys: g.maxLookupKeys, maxPage: g.maxLookupPage, maxRecords: g.maxLookupRecords }
}

/** `root-warming` while the root's first sync runs. */
function coverageFor<T extends WireTrustResult | WireRatingResult>(ctx: OpContext, result: T, resolved: ResolvedQuery): T {
  const reasons = ctx.coverageReasons(resolved.query.rootPubkey)
  if (reasons.length > 0) return { ...result, coverage: 'partial', coverageReasons: [...reasons] }
  return { ...result, coverage: 'complete' }
}

/** Walk budgets from the guardrails; the deadline is the earlier of the operation's and the request's `deadlineMs`. */
function walkBudgets(ctx: OpContext, deadlineAt: number, deadlineMs?: number): WalkBudgets {
  return {
    maxReachedNodes: ctx.guardrails.maxReachedNodes,
    maxWalkRecords: ctx.guardrails.maxWalkRecords,
    deadline: Math.min(deadlineAt, deadlineMs !== undefined ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY),
  }
}

function runTrust(ctx: OpContext, resolved: ResolvedQuery, deadlineAt = ctx.deadlineAt): WireTrustResult {
  const result = ctx.graph.trust({ ...resolved.query, budgets: walkBudgets(ctx, deadlineAt, resolved.deadlineMs) })
  const limited = limitTrustResult(result, {
    statementLimit: resolved.statementLimit,
    maxPathNodes: ctx.guardrails.maxPathNodes,
  })
  for (const reason of limited.truncatedReasons ?? []) ctx.guardrail(reason)
  return coverageFor(ctx, limited, resolved)
}

function runRating(ctx: OpContext, resolved: ResolvedQuery, deadlineAt = ctx.deadlineAt): WireRatingResult {
  const result = ctx.graph.rating({ ...resolved.query, budgets: walkBudgets(ctx, deadlineAt, resolved.deadlineMs) })
  const limited = limitRatingResult(result, {
    statementLimit: resolved.statementLimit,
    maxPathNodes: ctx.guardrails.maxPathNodes,
  })
  for (const reason of limited.truncatedReasons ?? []) ctx.guardrail(reason)
  return coverageFor(ctx, limited, resolved)
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function runBatch<T>(
  ctx: OpContext,
  params: Record<string, unknown>,
  kind: 'trust' | 'rating',
  run: (resolved: ResolvedQuery, deadlineAt: number) => T,
): Promise<{ graphVersion: number; results: Record<string, T>; errors?: Record<string, string> }> {
  const items = params.items
  if (!Array.isArray(items)) throw invalid('items must be an array')
  if (items.length > ctx.guardrails.maxBatchItems) throw invalid(`at most ${ctx.guardrails.maxBatchItems} items per batch`)
  const { items: _items, ...shared } = params
  const deadlineMs = typeof params.deadlineMs === 'number' && params.deadlineMs > 0 ? params.deadlineMs : undefined
  const batchDeadline = Math.min(
    Date.now() + ctx.guardrails.batchDeadline,
    deadlineMs !== undefined ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY,
  )
  const results: Record<string, T> = {}
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  const graphVersion = ctx.graph.graphVersion
  let sliceStart = performance.now()
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') throw invalid('each item must be an object with a key')
    const item = raw as Record<string, unknown>
    if (typeof item.key !== 'string' || item.key.length === 0) throw invalid('each item needs a string key')
    if (seen.has(item.key)) throw invalid(`duplicate item key ${item.key.slice(0, 64)}`)
    seen.add(item.key)
  }
  for (const [index, raw] of items.entries()) {
    const item = raw as Record<string, unknown>
    const key = item.key as string
    if (ctx.isCancelled()) throw new OpError('cancelled', 'cancelled by DTP-CANCEL')
    if (Date.now() > batchDeadline) {
      for (const rest of items.slice(index) as Array<{ key: string }>) errors[rest.key] = 'timeout'
      ctx.guardrail('timeBudget')
      break
    }
    try {
      const resolved = resolveQuery({ ...shared, ...item }, item.subject, kind, ctx.session, ctx.guardrails)
      results[key] = run(resolved, batchDeadline)
    } catch (error) {
      if (error instanceof OpError && error.code !== 'invalid' && error.code !== 'unsupported') throw error
      errors[key] = error instanceof OpError ? `${error.code}: ${error.message}` : 'error: internal error'
    }
    // Yield about every 5 ms so DTP-CANCEL and other sockets are served.
    if (performance.now() - sliceStart > 5) {
      await yieldToLoop()
      sliceStart = performance.now()
    }
  }
  return { graphVersion, results, ...(Object.keys(errors).length > 0 ? { errors } : {}) }
}

function lookup(ctx: OpContext, op: 'incoming' | 'outgoing' | 'counts', params: Record<string, unknown>): unknown {
  try {
    if (op === 'counts') return ctx.graph.counts(params as unknown as LookupCountsParams, lookupLimits(ctx.guardrails))
    const page = ctx.graph.lookup(op, params as unknown as LookupParams, lookupLimits(ctx.guardrails))
    if (page.truncated) ctx.guardrail('edgeBudget')
    return page
  } catch (error) {
    if (error instanceof LookupError) throw invalid(error.message)
    throw error
  }
}

async function lookupBatch(ctx: OpContext, params: Record<string, unknown>): Promise<unknown> {
  const queries = params.queries
  if (!Array.isArray(queries)) throw invalid('queries must be an array')
  if (queries.length > ctx.guardrails.maxLookupBatch) throw invalid(`at most ${ctx.guardrails.maxLookupBatch} queries per batch`)
  const results: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  const ids = new Set<string>()
  for (const raw of queries) {
    const q = raw as { id?: unknown; op?: unknown }
    if (!q || typeof q.id !== 'string') throw invalid('each query needs a string id')
    if (ids.has(q.id)) throw invalid(`duplicate query id ${q.id.slice(0, 64)}`)
    if (q.op !== 'incoming' && q.op !== 'outgoing' && q.op !== 'counts') throw invalid('op must be incoming, outgoing, or counts')
    ids.add(q.id)
  }
  const graphVersion = ctx.graph.graphVersion
  for (const [index, raw] of queries.entries()) {
    const q = raw as { id: string; op: 'incoming' | 'outgoing' | 'counts'; params?: unknown }
    if (ctx.isCancelled()) throw new OpError('cancelled', 'cancelled by DTP-CANCEL')
    if (Date.now() > ctx.deadlineAt) {
      for (const rest of queries.slice(index) as Array<{ id: string }>) errors[rest.id] = 'timeout'
      ctx.guardrail('timeBudget')
      break
    }
    try {
      results[q.id] = lookup(ctx, q.op, asObject(q.params))
    } catch (error) {
      if (!(error instanceof OpError)) throw error
      errors[q.id] = `${error.code}: ${error.message}`
    }
    await yieldToLoop()
  }
  return { graphVersion, results, ...(Object.keys(errors).length > 0 ? { errors } : {}) }
}

function intParam(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(`${name} must be a non-negative integer`)
  return Math.min(value, max)
}

function topicsOf(params: Record<string, unknown>): PushTopic[] {
  const topics = params.topics
  if (!Array.isArray(topics) || topics.some((t) => typeof t !== 'string')) throw invalid('topics must be an array of strings')
  for (const topic of topics) {
    if (!(PUSH_TOPICS as readonly string[]).includes(topic)) throw invalid(`unknown topic ${String(topic).slice(0, 32)}`)
  }
  return topics as PushTopic[]
}

export async function runOperation(ctx: OpContext, op: string, rawParams: unknown): Promise<unknown> {
  if (UNSUPPORTED_OPS[op]) throw new OpError('unsupported', UNSUPPORTED_OPS[op]!)
  const params = asObject(rawParams)
  switch (op) {
    case 'info':
      return ctx.info()
    case 'session.update': {
      const defaults = parseDefaults(params.defaults)
      Object.assign(ctx.session, defaults)
      if (defaults.rootPubkey) ctx.onActiveRoot(defaults.rootPubkey)
      return { defaults: { ...ctx.session } }
    }
    case 'trust.query':
      return runTrust(ctx, resolveQuery(params, params.subject, 'trust', ctx.session, ctx.guardrails))
    case 'rating.query':
      return runRating(ctx, resolveQuery(params, params.subject, 'rating', ctx.session, ctx.guardrails))
    case 'trust.batch':
      return runBatch(ctx, params, 'trust', (resolved, deadlineAt) => runTrust(ctx, resolved, deadlineAt))
    case 'rating.batch':
      return runBatch(ctx, params, 'rating', (resolved, deadlineAt) => runRating(ctx, resolved, deadlineAt))
    case 'lookup.incoming':
      return lookup(ctx, 'incoming', params)
    case 'lookup.outgoing':
      return lookup(ctx, 'outgoing', params)
    case 'lookup.counts':
      return lookup(ctx, 'counts', params)
    case 'lookup.batch':
      return lookupBatch(ctx, params)
    case 'graph.neighborhood': {
      const direction = params.direction ?? 'both'
      if (direction !== 'in' && direction !== 'out' && direction !== 'both') throw invalid('direction must be in, out, or both')
      const valueFilter = params.valueFilter ?? 'both'
      if (valueFilter !== 'trust' && valueFilter !== 'distrust' && valueFilter !== 'both') {
        throw invalid('valueFilter must be trust, distrust, or both')
      }
      if (params.keys !== undefined && (!Array.isArray(params.keys) || params.keys.some((k) => typeof k !== 'string'))) {
        throw invalid('keys must be wire node ids')
      }
      if (((params.keys as unknown[] | undefined)?.length ?? 0) > ctx.guardrails.maxLookupKeys) {
        throw invalid(`at most ${ctx.guardrails.maxLookupKeys} keys`)
      }
      const centerId = params.centerId
      if (centerId !== undefined && typeof centerId !== 'number' && typeof centerId !== 'string') {
        throw invalid('centerId must be a heap index or a wire node id')
      }
      if (centerId === undefined && !Array.isArray(params.keys)) throw invalid('keys or centerId is required')
      const limit = intParam('limit', params.limit, 200, ctx.guardrails.maxNeighborhoodLimit)
      const result = ctx.graph.neighborhood(
        { ...(params as NeighborhoodParams), direction, valueFilter, limit },
        ctx.guardrails.maxNeighborhoodLimit,
      )
      if (result.truncated) ctx.guardrail('neighborhoodLimit')
      return result
    }
    case 'graph.frontier': {
      const roots = params.roots
      if (!Array.isArray(roots) || roots.length === 0 || roots.some((r) => typeof r !== 'string' || !/^[0-9a-f]{64}$/.test(r))) {
        throw invalid('roots must be a non-empty array of 64-hex pubkeys')
      }
      if (roots.length > 500) throw invalid('at most 500 roots')
      const result = ctx.graph.frontier(roots as string[], {
        maxDepth: intParam('maxDepth', params.maxDepth, 3, 7),
        maxAuthorsPerLevel: intParam('maxAuthorsPerLevel', params.maxAuthorsPerLevel, 500, 100_000),
        maxTotalAuthors: intParam('maxTotalAuthors', params.maxTotalAuthors, 5_000, 1_000_000),
      })
      return { graphVersion: ctx.graph.graphVersion, ...result }
    }
    case 'graph.field': {
      const deadlineMs = typeof params.deadlineMs === 'number' && params.deadlineMs > 0 ? params.deadlineMs : undefined
      const result = ctx.graph.field({
        ...resolveField(params, ctx.session, ctx.guardrails),
        budgets: walkBudgets(ctx, ctx.deadlineAt, deadlineMs),
      })
      for (const reason of result.truncatedReasons ?? []) ctx.guardrail(reason)
      return result
    }
    case 'identity.claims': {
      const twitterId = params.twitterId
      if (typeof twitterId !== 'string' || !/^\d+$/.test(twitterId)) throw invalid('twitterId must be decimal digits')
      return { graphVersion: ctx.graph.graphVersion, claims: ctx.graph.claimsFor(twitterId) }
    }
    case 'subscribe':
      for (const topic of topicsOf(params)) ctx.subscriptions.add(topic)
      return { topics: [...ctx.subscriptions].sort() }
    case 'unsubscribe':
      for (const topic of topicsOf(params)) ctx.subscriptions.delete(topic)
      return { topics: [...ctx.subscriptions].sort() }
    default:
      throw invalid(`unknown op ${op.slice(0, 64)}`)
  }
}
