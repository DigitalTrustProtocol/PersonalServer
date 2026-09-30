/**
 * Session defaults (resolver-api.md § Session defaults) and the resolver
 * query fields (§ Query fields). Missing query fields come from the session;
 * lookups never use a root.
 */

import type { RatingQuery, TrustQuery, TrustSubject } from '@dtp/trust-query'
import { parseWireSubject } from '@dtp/trust-query'
import type { Guardrails } from '../config.js'
import { OpError, invalid } from './errors.js'

export type BindingMode = 'lenient' | 'strict'

export interface SessionDefaults {
  rootPubkey?: string
  bindingMode?: BindingMode
  followTrustThreshold?: number
  followTrustRed?: number
  bounds?: { maxDepth?: number }
  statementLimit?: number
}

const HEX_64 = /^[0-9a-f]{64}$/
export const DEFAULT_STATEMENT_LIMIT = 50
/** Product profile `attention` (wot-model.md §9): trust queries score in `identity`, ratings in `""`. */
export const DEFAULT_TRUST_CONTEXT = 'identity'
export const DEFAULT_RATING_CONTEXT = ''
export const HOP_CONTEXT = 'identity'

function percent(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw invalid(`${name} must be a number in [0, 100]`)
  }
  return value
}

function maxDepthOf(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 7) {
    throw invalid('bounds.maxDepth must be an integer in [1, 7]')
  }
  return value
}

function pubkeyOf(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !HEX_64.test(value)) throw invalid(`${name} must be 64 lowercase hex`)
  return value
}

function bindingModeOf(value: unknown): BindingMode | undefined {
  if (value === undefined) return undefined
  if (value !== 'lenient' && value !== 'strict') throw invalid('bindingMode must be lenient or strict')
  return value
}

function statementLimitOf(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid('statementLimit must be a positive integer')
  }
  return value
}

/** Validate `session.update` defaults; unknown fields are ignored (additive protocol). */
export function parseDefaults(raw: unknown): SessionDefaults {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('defaults must be an object')
  const record = raw as Record<string, unknown>
  const bounds = record.bounds
  if (bounds !== undefined && (typeof bounds !== 'object' || bounds === null)) throw invalid('bounds must be an object')
  const out: SessionDefaults = {}
  const rootPubkey = pubkeyOf('rootPubkey', record.rootPubkey)
  if (rootPubkey) out.rootPubkey = rootPubkey
  const bindingMode = bindingModeOf(record.bindingMode)
  if (bindingMode) out.bindingMode = bindingMode
  const green = percent('followTrustThreshold', record.followTrustThreshold)
  if (green !== undefined) out.followTrustThreshold = green
  const red = percent('followTrustRed', record.followTrustRed)
  if (red !== undefined) out.followTrustRed = red
  const maxDepth = maxDepthOf((bounds as { maxDepth?: unknown } | undefined)?.maxDepth)
  if (maxDepth !== undefined) out.bounds = { maxDepth }
  const statementLimit = statementLimitOf(record.statementLimit)
  if (statementLimit !== undefined) out.statementLimit = statementLimit
  return out
}

export interface ResolvedQuery {
  query: TrustQuery & RatingQuery
  statementLimit: number
  bindingMode: BindingMode
  deadlineMs?: number
}

/** Merge a resolver request with the session defaults and clamp to the guardrails. */
export function resolveQuery(
  params: Record<string, unknown>,
  subjectInput: unknown,
  kind: 'trust' | 'rating',
  session: SessionDefaults,
  guardrails: Guardrails,
): ResolvedQuery {
  const subject: TrustSubject | undefined = parseWireSubject(subjectInput)
  if (!subject) throw invalid('subject must be { type: p | e | i, value }')
  const rootPubkey = pubkeyOf('rootPubkey', params.rootPubkey) ?? session.rootPubkey
  if (!rootPubkey) throw invalid('rootPubkey is required (set it here or with session.update)')
  const context = params.context ?? (kind === 'trust' ? DEFAULT_TRUST_CONTEXT : DEFAULT_RATING_CONTEXT)
  if (typeof context !== 'string' || context.length > 128) throw invalid('context must be a string of at most 128 bytes')
  const hopContext = params.hopContext ?? HOP_CONTEXT
  if (hopContext !== HOP_CONTEXT) {
    throw new OpError('unsupported', 'hopContext other than identity is not supported by this server')
  }
  const now = params.now
  if (now !== undefined && (typeof now !== 'number' || !Number.isFinite(now))) throw invalid('now must be a number')
  const format = params.format ?? 'default'
  if (format !== 'default' && format !== 'path') throw invalid('format must be default or path')
  const boundsRaw = params.bounds
  if (boundsRaw !== undefined && (typeof boundsRaw !== 'object' || boundsRaw === null)) throw invalid('bounds must be an object')
  const requestedDepth =
    maxDepthOf((boundsRaw as { maxDepth?: unknown } | undefined)?.maxDepth) ?? session.bounds?.maxDepth ?? 4
  const maxDepth = Math.min(requestedDepth, guardrails.maxDepth)
  const followTrustThreshold = percent('followTrustThreshold', params.followTrustThreshold) ?? session.followTrustThreshold
  const followTrustRed = percent('followTrustRed', params.followTrustRed) ?? session.followTrustRed
  const statementLimit = Math.min(
    statementLimitOf(params.statementLimit) ?? session.statementLimit ?? DEFAULT_STATEMENT_LIMIT,
    guardrails.maxStatementLimit,
  )
  const bindingMode = bindingModeOf(params.bindingMode) ?? session.bindingMode ?? 'lenient'
  const deadline = params.deadlineMs
  if (deadline !== undefined && (typeof deadline !== 'number' || !(deadline > 0))) throw invalid('deadlineMs must be positive')
  let labels: string[] | undefined
  if (kind === 'rating' && params.labels !== undefined) {
    if (!Array.isArray(params.labels) || params.labels.some((l) => typeof l !== 'string')) {
      throw invalid('labels must be an array of strings')
    }
    labels = params.labels as string[]
  }
  return {
    query: {
      rootPubkey,
      subject,
      context,
      ...(now !== undefined ? { now } : {}),
      bounds: { maxDepth },
      format,
      ...(followTrustThreshold !== undefined ? { followTrustThreshold } : {}),
      ...(followTrustRed !== undefined ? { followTrustRed } : {}),
      ...(labels ? { labels } : {}),
    },
    statementLimit,
    bindingMode,
    ...(deadline !== undefined ? { deadlineMs: deadline as number } : {}),
  }
}
