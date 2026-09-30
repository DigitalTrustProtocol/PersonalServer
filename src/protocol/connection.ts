/**
 * One WebSocket connection: NIP-01 framing (EVENT / REQ / CLOSE / AUTH) plus
 * the DTP messages (resolver-api.md § Messages). Pipelined operations,
 * in-flight cap, DTP-CANCEL, NIP-42 authentication, access checks, and the
 * per-connection output / pending-OK guardrails.
 */

import { randomBytes } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools'
import type { WebSocket } from 'ws'
import type { AccessPolicy, Guardrails } from '../config.js'
import type { GraphManager } from '../graph/graph-manager.js'
import type { IngestPipeline } from '../ingest/pipeline.js'
import { MEMBERSHIP_LIST_KIND, ROLE_DEFINITION_KIND, type Membership, type Role } from '../membership.js'
import type { Repository } from '../storage/repository.js'
import type { ConnectionInfo, OriginClass, Telemetry } from '../telemetry/telemetry.js'
import { OpError, type ErrorCode } from './errors.js'
import { runOperation, type PushTopic } from './ops.js'
import type { SessionDefaults } from './session.js'

const AUTH_KIND = 22242
const AUTH_WINDOW_SECONDS = 600
const HELD_KINDS = new Set([32009, 32014, 10011])
const MAX_REQ_IDS = 500
const MAX_REQ_AUTHORS = 20
const MAX_REQ_LIMIT = 500
export const IDLE_CLOSE_MS = 5 * 60_000

export interface AccessSettings {
  reads: AccessPolicy
  writes: AccessPolicy
  admins: string[]
}

export interface ConnectionDeps {
  graph: GraphManager
  repo: Repository
  ingest: IngestPipeline
  membership: Membership
  telemetry: Telemetry
  guardrails: Guardrails
  access(): AccessSettings
  /** `host:port` values a NIP-42 `relay` tag may name. */
  relayHosts: ReadonlySet<string>
  info(): Record<string, unknown>
  onActiveRoot(pubkey: string): void
  /** `root-warming` while the root's first sync runs. */
  coverageReasons(root: string): string[]
  logger: { warn(message: string): void; debug(message: string): void }
}

type Frame = unknown[]

function hostOfRelayUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

export function originClass(origin: string | undefined): OriginClass {
  if (!origin) return 'native'
  if (/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) return 'extension'
  return 'other'
}

export class Connection {
  readonly #ws: WebSocket
  readonly #deps: ConnectionDeps
  readonly challenge = randomBytes(16).toString('hex')
  readonly authed = new Set<string>()
  readonly session: SessionDefaults = {}
  readonly subscriptions = new Set<PushTopic>()
  readonly #inFlight = new Map<string, { cancelled: boolean }>()
  readonly info: ConnectionInfo
  #pendingOks = 0
  #paused = false
  #lastMessageAt = Date.now()
  #closed = false

  constructor(ws: WebSocket, deps: ConnectionDeps, origin: string | undefined) {
    this.#ws = ws
    this.#deps = deps
    this.info = {
      role: 'anonymous_reader',
      origin: originClass(origin),
      connectedSince: Math.floor(Date.now() / 1000),
      writerPubkey: null,
      events: 0,
      rejects: 0,
      inFlight: 0,
      pendingOks: 0,
    }
    deps.telemetry.connections.add(this.info)
    ws.on('message', (data, isBinary) => {
      this.#lastMessageAt = Date.now()
      if (isBinary) {
        this.#send(['NOTICE', 'invalid: binary frames are not supported'])
        return
      }
      this.#handle(data.toString())
    })
    ws.on('close', () => this.#onClose())
    this.#send(['AUTH', this.challenge])
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Idle read-only connections close after 5 minutes (resolver-api.md § Keepalive). */
  isIdle(now = Date.now()): boolean {
    return (
      this.subscriptions.size === 0 &&
      this.#inFlight.size === 0 &&
      this.info.role !== 'writer' &&
      now - this.#lastMessageAt > IDLE_CLOSE_MS
    )
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return
    this.#ws.close(code, reason)
  }

  #onClose(): void {
    this.#closed = true
    for (const entry of this.#inFlight.values()) entry.cancelled = true
    this.#inFlight.clear()
    this.#deps.telemetry.connections.delete(this.info)
  }

  send(frame: Frame): void {
    this.#send(frame)
  }

  #send(frame: Frame): void {
    if (this.#closed || this.#ws.readyState !== this.#ws.OPEN) return
    this.#ws.send(JSON.stringify(frame))
    if (this.#ws.bufferedAmount > this.#deps.guardrails.maxUnsentOutput) {
      this.#deps.telemetry.slowClientDisconnects += 1
      this.#deps.telemetry.guardrail('maxUnsentOutput')
      this.#ws.terminate()
    }
  }

  #handle(text: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      this.#send(['NOTICE', 'invalid: message is not JSON'])
      return
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') {
      this.#send(['NOTICE', 'invalid: message must be a JSON array with a type'])
      return
    }
    switch (frame[0]) {
      case 'EVENT':
        void this.#onEvent(frame[1])
        return
      case 'AUTH':
        this.#onAuth(frame[1])
        return
      case 'REQ':
        this.#onReq(frame)
        return
      case 'CLOSE':
        return
      case 'DTP':
        void this.#onDtp(frame)
        return
      case 'DTP-CANCEL': {
        const entry = typeof frame[1] === 'string' ? this.#inFlight.get(frame[1]) : undefined
        if (entry) entry.cancelled = true
        return
      }
      default:
        this.#send(['NOTICE', `unsupported: message type ${String(frame[0]).slice(0, 32)}`])
    }
  }

  // ---- access ------------------------------------------------------------

  #roles(): Set<Role> {
    const roles = new Set<Role>()
    const admins = new Set(this.#deps.access().admins)
    for (const pubkey of this.authed) {
      for (const role of this.#deps.membership.rolesOf(pubkey)) roles.add(role)
      if (admins.has(pubkey)) roles.add('admin')
    }
    return roles
  }

  /** undefined = allowed; otherwise the machine-readable refusal. */
  #refusal(policy: AccessPolicy, role: Role): { code: ErrorCode; message: string } | undefined {
    if (policy === 'open') return undefined
    if (this.authed.size === 0) return { code: 'auth-required', message: `authenticate to ${role === 'write' ? 'write' : 'read'}` }
    const roles = this.#roles()
    if (roles.has(role) || roles.has('admin')) return undefined
    return { code: 'restricted', message: `needs the ${role} role` }
  }

  // ---- NIP-42 --------------------------------------------------------------

  #onAuth(input: unknown): void {
    const event = input as Event | undefined
    const id = typeof event?.id === 'string' ? event.id : ''
    const fail = (message: string) => this.#send(['OK', id, false, message])
    if (!event || typeof event !== 'object') return fail('invalid: AUTH needs a signed kind 22242 event')
    if (event.kind !== AUTH_KIND) return fail('invalid: AUTH event must be kind 22242')
    const now = Math.floor(Date.now() / 1000)
    if (typeof event.created_at !== 'number' || Math.abs(event.created_at - now) > AUTH_WINDOW_SECONDS) {
      return fail('invalid: created_at is more than 10 minutes away')
    }
    const tag = (name: string) => (Array.isArray(event.tags) ? event.tags.find((t) => t[0] === name)?.[1] : undefined)
    if (tag('challenge') !== this.challenge) return fail('invalid: challenge does not match')
    const host = hostOfRelayUrl(tag('relay') ?? '')
    if (!host || !this.#deps.relayHosts.has(host)) return fail('invalid: relay tag does not name this server')
    let verified = false
    try {
      verified = verifyEvent(event)
    } catch {
      verified = false
    }
    if (!verified) return fail('invalid: signature does not verify')
    if (this.#deps.membership.isBanned(event.pubkey)) return fail('restricted: pubkey is banned')
    this.authed.add(event.pubkey)
    this.#deps.telemetry.authentications += 1
    const roles = this.#roles()
    if (roles.has('admin')) this.info.role = 'admin'
    else if (this.info.role !== 'writer' && roles.size > 0) this.info.role = 'member_reader'
    this.#send(['OK', id, true, ''])
  }

  // ---- EVENT ingest ------------------------------------------------------

  async #onEvent(input: unknown): Promise<void> {
    const id = typeof (input as { id?: unknown } | null)?.id === 'string' ? (input as { id: string }).id : ''
    const refusal = this.#refusal(this.#deps.access().writes, 'write')
    if (refusal) {
      this.#deps.telemetry.recordIngest(Number((input as { kind?: unknown } | null)?.kind), 'blocked', refusal.code)
      this.#send(['OK', id, false, `${refusal.code}: ${refusal.message}`])
      return
    }
    const author = (input as { pubkey?: unknown } | null)?.pubkey
    if (typeof author === 'string' && this.#deps.membership.isBanned(author)) {
      this.#send(['OK', id, false, 'blocked: pubkey is banned'])
      return
    }
    this.info.role = this.info.role === 'admin' ? 'admin' : 'writer'
    if (this.info.writerPubkey === null && this.authed.size > 0) this.info.writerPubkey = [...this.authed][0]!
    this.#pendingOks += 1
    this.info.pendingOks = this.#pendingOks
    if (!this.#paused && this.#pendingOks >= this.#deps.guardrails.maxPendingOks) {
      // Backpressure: stop reading the socket instead of growing a queue.
      this.#paused = true
      this.#ws.pause()
      this.#deps.telemetry.guardrail('maxPendingOks')
    }
    try {
      const outcome = await this.#deps.ingest.ingest(input, 'local')
      this.info.events += 1
      if (!outcome.ok) this.info.rejects += 1
      this.#send(['OK', outcome.eventId || id, outcome.ok, outcome.message])
    } catch (error) {
      this.#deps.logger.warn(`ingest failed: ${(error as Error).message}`)
      this.#send(['OK', id, false, 'error: could not store the event'])
    } finally {
      this.#pendingOks -= 1
      this.info.pendingOks = this.#pendingOks
      if (this.#paused && this.#pendingOks < this.#deps.guardrails.maxPendingOks / 2) {
        this.#paused = false
        this.#ws.resume()
      }
    }
  }

  // ---- REQ (limited reads) ------------------------------------------------

  #onReq(frame: Frame): void {
    const subId = frame[1]
    if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) {
      this.#send(['NOTICE', 'invalid: REQ needs a subscription id'])
      return
    }
    const refusal = this.#refusal(this.#deps.access().reads, 'read')
    if (refusal) {
      this.#send(['CLOSED', subId, `${refusal.code}: ${refusal.message}`])
      return
    }
    const filters = frame.slice(2)
    if (filters.length === 0) {
      this.#send(['CLOSED', subId, 'invalid: REQ needs at least one filter'])
      return
    }
    const events = new Map<string, Event>()
    for (const raw of filters) {
      const result = this.#readFilter(raw)
      if (typeof result === 'string') {
        this.#send(['CLOSED', subId, result])
        return
      }
      for (const event of result) events.set(event.id, event)
    }
    const ordered = [...events.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    for (const event of ordered) this.#send(['EVENT', subId, event])
    this.#send(['EOSE', subId])
  }

  /** Events for one filter, or a CLOSED message. */
  #readFilter(raw: unknown): Event[] | string {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid: filter must be an object'
    const filter = raw as Record<string, unknown>
    const allowed = new Set(['ids', 'authors', 'kinds', 'since', 'until', 'limit'])
    for (const key of Object.keys(filter)) {
      if (!allowed.has(key)) return `unsupported: filter field ${key.slice(0, 32)} (limited reads: ids; authors + kinds; NIP-43 kinds)`
    }
    const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === 'string')
    const limit = typeof filter.limit === 'number' && filter.limit >= 0 ? Math.min(filter.limit, MAX_REQ_LIMIT) : MAX_REQ_LIMIT
    const kinds = Array.isArray(filter.kinds) ? (filter.kinds as unknown[]) : undefined
    if (kinds && !kinds.every((k) => typeof k === 'number')) return 'invalid: kinds must be numbers'
    if (filter.ids !== undefined) {
      if (!strings(filter.ids)) return 'invalid: ids must be strings'
      const ids = filter.ids as string[]
      if (ids.length > MAX_REQ_IDS) return `invalid: at most ${MAX_REQ_IDS} ids`
      let events = this.#deps.repo.getByIds(ids.filter((id) => /^[0-9a-f]{64}$/.test(id))) as Event[]
      if (kinds) events = events.filter((e) => kinds.includes(e.kind))
      return events.slice(0, limit)
    }
    if (kinds && kinds.length > 0 && kinds.every((k) => k === MEMBERSHIP_LIST_KIND || k === ROLE_DEFINITION_KIND)) {
      const self = this.#deps.membership
      const out: Event[] = []
      if (kinds.includes(MEMBERSHIP_LIST_KIND)) out.push(self.listEvent())
      if (kinds.includes(ROLE_DEFINITION_KIND)) out.push(...self.roleEvents())
      const authors = strings(filter.authors) ? (filter.authors as string[]) : undefined
      return out.filter((e) => !authors || authors.includes(e.pubkey)).slice(0, limit)
    }
    if (filter.authors !== undefined && kinds) {
      if (!strings(filter.authors)) return 'invalid: authors must be strings'
      const authors = filter.authors as string[]
      if (authors.length > MAX_REQ_AUTHORS) return `invalid: at most ${MAX_REQ_AUTHORS} authors`
      if (!kinds.every((k) => HELD_KINDS.has(k as number))) return 'unsupported: kinds must be 32009, 32014, or 10011'
      const since = typeof filter.since === 'number' ? filter.since : undefined
      const until = typeof filter.until === 'number' ? filter.until : undefined
      return this.#deps.repo.byAuthorsKinds(authors, kinds as number[], {
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit,
      }) as Event[]
    }
    return 'unsupported: limited reads are ids, authors + kinds (32009 / 32014 / 10011), or kinds 13534 / 33534'
  }

  // ---- DTP -----------------------------------------------------------------

  async #onDtp(frame: Frame): Promise<void> {
    const [, reqId, op, params] = frame
    if (typeof reqId !== 'string' || reqId.length === 0 || reqId.length > 64) {
      this.#send(['NOTICE', 'invalid: DTP needs a reqId string'])
      return
    }
    if (typeof op !== 'string') {
      this.#send(['DTP-ERR', reqId, 'invalid', 'op must be a string'])
      return
    }
    const telemetry = this.#deps.telemetry
    if (this.#inFlight.has(reqId)) {
      this.#send(['DTP-ERR', reqId, 'invalid', 'reqId is already in flight'])
      telemetry.recordOperation(op, 'invalid')
      return
    }
    if (this.#inFlight.size >= this.#deps.guardrails.maxInFlight) {
      this.#send(['DTP-ERR', reqId, 'busy', `more than ${this.#deps.guardrails.maxInFlight} operations in flight`])
      telemetry.recordOperation(op, 'busy')
      telemetry.guardrail('maxInFlight')
      return
    }
    const refusal = this.#refusal(this.#deps.access().reads, 'read')
    if (refusal) {
      this.#send(['DTP-ERR', reqId, refusal.code, refusal.message])
      telemetry.recordOperation(op, 'invalid')
      return
    }
    const entry = { cancelled: false }
    this.#inFlight.set(reqId, entry)
    this.info.inFlight = this.#inFlight.size
    const started = performance.now()
    const deadlineMs =
      params && typeof params === 'object' && typeof (params as { deadlineMs?: unknown }).deadlineMs === 'number'
        ? Math.min((params as { deadlineMs: number }).deadlineMs, this.#deps.guardrails.operationDeadline)
        : this.#deps.guardrails.operationDeadline
    try {
      const result = await runOperation(
        {
          graph: this.#deps.graph,
          guardrails: this.#deps.guardrails,
          session: this.session,
          subscriptions: this.subscriptions,
          info: this.#deps.info,
          onActiveRoot: this.#deps.onActiveRoot,
          coverageReasons: this.#deps.coverageReasons,
          deadlineAt: Date.now() + deadlineMs,
          isCancelled: () => entry.cancelled,
          guardrail: (reason) => telemetry.guardrail(reason),
        },
        op,
        params,
      )
      if (entry.cancelled) throw new OpError('cancelled', 'cancelled by DTP-CANCEL')
      this.#send(['DTP-OK', reqId, result])
      telemetry.recordOperation(op, 'ok', (performance.now() - started) / 1000)
    } catch (error) {
      if (error instanceof OpError) {
        this.#send(['DTP-ERR', reqId, error.code, error.message])
        telemetry.recordOperation(op, error.code === 'busy' ? 'busy' : error.code === 'rate-limited' ? 'rate_limited' : error.code === 'invalid' ? 'invalid' : 'error')
      } else {
        this.#deps.logger.warn(`operation ${op} failed: ${(error as Error).message}`)
        telemetry.log('error', `operation ${op} failed`)
        this.#send(['DTP-ERR', reqId, 'error', 'internal error'])
        telemetry.recordOperation(op, 'error')
      }
    } finally {
      this.#inFlight.delete(reqId)
      this.info.inFlight = this.#inFlight.size
    }
  }
}
