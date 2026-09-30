/**
 * The dtp-personal process (architecture.md § Components): SQLite
 * repository, heap load, one protocol port (WebSocket + NIP-11 / NIP-86 /
 * health on HTTP — plain node:http, decision PS-D3), and the loopback admin
 * listener with the shared telemetry pages.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { cpus, networkInterfaces } from 'node:os'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { WebSocketServer, type WebSocket } from 'ws'
import { telemetryAssetsDir } from '@dtp/telemetry-ui/assets'
import { AdminServer } from './admin/admin-server.js'
import {
  DEFAULT_GUARDRAILS,
  DEFAULT_MEMORY_GUARDRAILS,
  MAX_MESSAGE_LENGTH,
  localHostNames,
  originAllowed,
  type AccessPolicy,
  type Guardrails,
  type MemoryGuardrails,
  type ServerConfig,
} from './config.js'
import { GraphManager } from './graph/graph-manager.js'
import { handleNip86 } from './http/nip86.js'
import { IngestPipeline } from './ingest/pipeline.js'
import { VerifyPool } from './ingest/verify-pool.js'
import { loadOrCreateServerKey, type ServerKey } from './keys.js'
import { ServerLogger, type Logger } from './log.js'
import { Membership } from './membership.js'
import { Connection, type AccessSettings } from './protocol/connection.js'
import { IMPLEMENTED_OPS, UNSUPPORTED_OPS } from './protocol/ops.js'
import { PushHub } from './protocol/push.js'
import { openDatabase } from './storage/database.js'
import { Repository } from './storage/repository.js'
import { SyncService } from './sync/sync-service.js'
import { Telemetry, type SnapshotContext } from './telemetry/telemetry.js'
import { VERSION } from './version.js'

export const API_VERSION = 'v1'
export const MODEL_VERSION = 'dtp-wot/1'
export const CORPUS_VERSION = 'dtp-wot-corpus/1'
/**
 * Model gaps still open in the @dtp/trust-graph walk this server runs
 * (TrustGraph specs/conformance.md § Known gaps). G5: `web:` keys are
 * lowercased whole.
 */
export const OPEN_GAPS = ['G5'] as const

const PING_INTERVAL_MS = 20_000
const PONG_TIMEOUT_MS = 60_000
const HISTORY_INTERVAL_MS = 10_000
const ACTIVE_ROOT_DAYS = 30

export interface StartOptions {
  logger?: Logger
  /** Print logs to the console (default true). */
  console?: boolean
  /** Run relay sync (default true; it idles until relays and roots are configured). */
  sync?: boolean
}

function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1') return true
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true
  const m = /^172\.(\d+)\./.exec(a)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)
}

function lanHostNames(port: number): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (!isPrivateAddress(info.address)) continue
      out.push(info.family === 'IPv6' ? `[${info.address}]:${port}` : `${info.address}:${port}`)
    }
  }
  return out
}

function dayNumber(now = Date.now()): number {
  return Math.floor(now / 86_400_000)
}

export class PersonalServer {
  readonly config: ServerConfig
  readonly instanceId = randomUUID()
  readonly startedAt = Math.floor(Date.now() / 1000)
  readonly repo: Repository
  readonly graph = new GraphManager()
  readonly telemetry = new Telemetry()
  readonly membership: Membership
  readonly ingest: IngestPipeline
  readonly key: ServerKey
  readonly logger: Logger
  readonly guardrails: Guardrails
  readonly memory: MemoryGuardrails
  readonly sync: SyncService
  readonly verifier: VerifyPool
  readonly #runSync: boolean
  readonly #http: Server
  readonly #wss: WebSocketServer
  readonly #admin: AdminServer
  readonly #connections = new Set<Connection>()
  readonly #alive = new WeakMap<WebSocket, number>()
  readonly #perIp = new Map<string, number>()
  readonly #push: PushHub
  readonly #lag = monitorEventLoopDelay({ resolution: 20 })
  #timers: NodeJS.Timeout[] = []
  #ready = false
  #coveragePushes = 0
  #readySince = Date.now()
  #port = 0
  #adminPort = 0
  #hosts: Set<string> = new Set()
  #adminHosts: Set<string> = new Set()

  private constructor(config: ServerConfig, options: StartOptions) {
    this.config = config
    const db = openDatabase(join(config.dataDir, 'personal.sqlite'))
    this.repo = new Repository(db)
    this.key = loadOrCreateServerKey(config.dataDir)
    this.logger =
      options.logger ??
      new ServerLogger({
        level: config.logLevel,
        dir: join(config.dataDir, 'logs'),
        console: options.console !== false,
        sink: (level, message) => this.telemetry.log(level, message),
      })
    this.guardrails = {
      ...DEFAULT_GUARDRAILS,
      maxColdWalks: Math.max(1, cpus().length - 1),
      ...this.repo.setting<Partial<Guardrails>>('guardrails', {}),
    }
    this.memory = { ...DEFAULT_MEMORY_GUARDRAILS, ...this.repo.setting<Partial<MemoryGuardrails>>('memory', {}) }
    this.membership = new Membership(this.repo, this.key)
    this.verifier = new VerifyPool(
      this.repo.setting<number>('verifyWorkers', Math.min(4, Math.max(1, cpus().length - 1))),
    )
    this.ingest = new IngestPipeline(this.repo, this.graph, this.telemetry, {
      maxHeapEdges: this.memory.maxHeapEdges,
      verifier: this.verifier,
    })
    this.#push = new PushHub(() => this.#connections)
    this.graph.onChange((change) => this.#push.onChange(change))
    this.#runSync = options.sync !== false
    this.sync = new SyncService({
      repo: this.repo,
      graph: this.graph,
      pipeline: this.ingest,
      telemetry: this.telemetry,
      logger: this.logger,
      maxHeapEdges: this.memory.maxHeapEdges,
      onRootWarm: (root) => {
        this.#coveragePushes += 1
        for (const connection of this.#connections) {
          if (connection.subscriptions.has('coverage')) {
            connection.send(['DTP-PUSH', 'coverage', { rootPubkey: root, coverage: 'complete', reasons: [] }])
          }
        }
      },
    })
    this.#http = createServer((req, res) => void this.#onHttp(req, res))
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_LENGTH,
      perMessageDeflate: { threshold: 1024 },
    })
    this.#admin = new AdminServer({
      assetsDir: telemetryAssetsDir,
      snapshot: () => this.snapshot(),
      metrics: () => this.telemetry.prometheus(this.#snapshotContext()),
      history: (series, window) => this.telemetry.history(series, window),
      allowedHosts: () => this.#adminHosts,
    })
  }

  static async start(config: ServerConfig, options: StartOptions = {}): Promise<PersonalServer> {
    const server = new PersonalServer(config, options)
    await server.#start()
    return server
  }

  get port(): number {
    return this.#port
  }

  get adminPort(): number {
    return this.#adminPort
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}/`
  }

  get adminUrl(): string {
    return `http://127.0.0.1:${this.#adminPort}/`
  }

  get ready(): boolean {
    return this.#ready
  }

  access(): AccessSettings {
    return {
      reads: this.repo.setting<AccessPolicy>('auth.reads', 'open'),
      writes: this.repo.setting<AccessPolicy>('auth.writes', 'open'),
      admins: this.repo.setting<string[]>('auth.admins', []),
    }
  }

  async #start(): Promise<void> {
    const started = performance.now()
    this.repo.pruneInactiveRoots(dayNumber() - ACTIVE_ROOT_DAYS)
    const loaded = this.graph.load(this.repo)
    this.logger.info(
      `heap loaded: ${loaded.records} records, ${loaded.claims} claims in ${Math.round(performance.now() - started)} ms`,
    )
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket as Socket, head))
    await new Promise<void>((resolve, reject) => {
      this.#http.once('error', reject)
      this.#http.listen(this.config.port, this.config.host, () => {
        this.#http.off('error', reject)
        resolve()
      })
    })
    const address = this.#http.address()
    this.#port = typeof address === 'object' && address ? address.port : this.config.port
    this.#hosts = localHostNames(this.#port, [
      ...this.config.allowedHosts,
      ...(this.config.listen === 'lan' ? lanHostNames(this.#port) : []),
    ])
    const adminPort = this.config.admin.port === 0 || this.config.port === 0 ? 0 : this.config.admin.port
    this.#adminPort = await this.#admin.listen(adminPort)
    this.#adminHosts = localHostNames(this.#adminPort)
    this.#lag.enable()
    this.#timers.push(
      setInterval(() => this.#keepalive(), PING_INTERVAL_MS),
      setInterval(() => this.telemetry.sample({ rssBytes: process.memoryUsage.rss(), edges: this.graph.liveEdges() }), HISTORY_INTERVAL_MS),
    )
    for (const timer of this.#timers) timer.unref()
    if (this.#runSync) this.sync.start()
    this.#ready = true
    this.#readySince = Date.now()
    this.logger.info(`listening on ${this.url} (admin ${this.adminUrl})`)
  }

  async stop(): Promise<void> {
    this.#ready = false
    for (const timer of this.#timers) clearInterval(timer)
    this.#timers = []
    await this.sync.stop()
    this.#push.stop()
    this.#lag.disable()
    for (const connection of this.#connections) connection.close(1001, 'server shutting down')
    for (const client of this.#wss.clients) client.terminate()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.#http.close(() => resolve()))
    this.#http.closeAllConnections()
    await this.#admin.close()
    await this.verifier.close()
    this.repo.db.close()
  }

  #keepalive(): void {
    const now = Date.now()
    for (const ws of this.#wss.clients) {
      const last = this.#alive.get(ws) ?? now
      if (now - last > PONG_TIMEOUT_MS) {
        ws.terminate()
        continue
      }
      ws.ping()
    }
    for (const connection of this.#connections) {
      if (connection.isIdle(now)) connection.close(1000, 'idle')
    }
  }

  // ---- HTTP: NIP-11, health, NIP-86 -------------------------------------

  #hostOk(req: IncomingMessage): boolean {
    return this.#hosts.has((req.headers.host ?? '').toLowerCase())
  }

  #remoteOk(req: IncomingMessage): boolean {
    return this.config.listen === 'local' || isPrivateAddress(req.socket.remoteAddress)
  }

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!this.#remoteOk(req)) return json(403, { error: 'non-private address' })
    if (!this.#hostOk(req)) return json(421, { error: 'unknown host' })
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST',
      })
      return void res.end()
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok' })
    if (req.method === 'GET' && url.pathname === '/readyz') {
      return json(this.#ready ? 200 : 503, { ready: this.#ready, graphVersion: this.graph.graphVersion })
    }
    if (req.method === 'GET' && url.pathname === '/' && (req.headers.accept ?? '').includes('application/nostr+json')) {
      return json(200, this.nip11(), 'application/nostr+json')
    }
    if (req.method === 'POST' && url.pathname === '/' && (req.headers['content-type'] ?? '').includes('application/nostr+json+rpc')) {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > 64 * 1024) return json(413, { error: 'body too large' })
        chunks.push(chunk as Buffer)
      }
      const outcome = handleNip86(
        {
          method: 'POST',
          url: `http://${req.headers.host}${url.pathname}`,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        },
        { membership: this.membership, admins: () => this.access().admins },
      )
      return json(outcome.status, outcome.body, 'application/nostr+json+rpc')
    }
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('DTP Personal Server: connect with a WebSocket, or GET / with Accept: application/nostr+json\n')
  }

  #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!this.#remoteOk(req)) return refuse(403, 'Forbidden')
    if (!this.#hostOk(req)) return refuse(421, 'Misdirected Request')
    const origin = req.headers.origin
    if (!originAllowed(origin, this.config.allowedOrigins)) return refuse(403, 'Forbidden')
    const ip = req.socket.remoteAddress ?? 'unknown'
    const open = this.#perIp.get(ip) ?? 0
    if (open >= this.guardrails.maxConnections) {
      this.telemetry.guardrail('maxConnections')
      return refuse(429, 'Too Many Requests')
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#perIp.set(ip, open + 1)
      this.#alive.set(ws, Date.now())
      ws.on('pong', () => this.#alive.set(ws, Date.now()))
      const connection = new Connection(
        ws,
        {
          graph: this.graph,
          repo: this.repo,
          ingest: this.ingest,
          membership: this.membership,
          telemetry: this.telemetry,
          guardrails: this.guardrails,
          access: () => this.access(),
          relayHosts: this.#hosts,
          info: () => this.info(),
          onActiveRoot: (pubkey) => {
            this.repo.touchActiveRoot(pubkey, dayNumber())
            this.sync.kick()
          },
          coverageReasons: (root) => (this.sync.warming(root) ? ['root-warming'] : []),
          logger: this.logger,
        },
        origin,
      )
      this.#connections.add(connection)
      ws.on('close', () => {
        this.#connections.delete(connection)
        const left = (this.#perIp.get(ip) ?? 1) - 1
        if (left <= 0) this.#perIp.delete(ip)
        else this.#perIp.set(ip, left)
      })
    })
  }

  // ---- documents -----------------------------------------------------------

  limits(): Record<string, number> {
    return { ...this.guardrails }
  }

  dtpObject(): Record<string, unknown> {
    return {
      api: API_VERSION,
      model: MODEL_VERSION,
      corpus: CORPUS_VERSION,
      instanceId: this.instanceId,
      scopeProfile: 'x.com',
      capabilities: [...IMPLEMENTED_OPS],
      ...(Object.keys(UNSUPPORTED_OPS).length > 0 ? { unsupported: { ...UNSUPPORTED_OPS } } : {}),
      ...(OPEN_GAPS.length > 0 ? { gaps: [...OPEN_GAPS] } : {}),
      limits: this.limits(),
    }
  }

  nip11(): Record<string, unknown> {
    const access = this.access()
    return {
      name: 'DTP Personal Server',
      description: 'Local Web-of-Trust resolver for kinds 32009, 32014, and 10011 (Digital Trust Protocol).',
      pubkey: this.key.pubkey,
      self: this.key.pubkey,
      software: 'https://github.com/DigitalTrustProtocol/PersonalServer',
      version: VERSION,
      supported_nips: [1, 9, 11, 42, 43, 86],
      limitation: {
        auth_required: access.reads === 'members',
        restricted_writes: access.writes === 'members',
        max_message_length: MAX_MESSAGE_LENGTH,
        max_limit: 500,
      },
      dtp: this.dtpObject(),
    }
  }

  #memoryStatus(): SnapshotContext['memory'] {
    const usage = process.memoryUsage()
    const limit = this.memory.heapLimitBytes
    const ratio = usage.heapUsed / limit
    return {
      limitBytes: limit,
      rssBytes: usage.rss,
      shares: {
        heap: { bytes: usage.heapUsed, limit },
        external: { bytes: usage.external, limit: null },
      },
      watchdog: ratio > 0.95 ? 'critical' : ratio > 0.85 ? 'pressure' : 'ok',
      impl: {
        v8HeapUsedBytes: usage.heapUsed,
        v8HeapTotalBytes: usage.heapTotal,
        eventLoopLagP99Ms: Math.round(this.#lag.percentile(99) / 1e6),
        heapEdgeLimit: this.memory.maxHeapEdges,
        heapNodeLimit: this.memory.maxHeapNodes,
      },
    }
  }

  info(): Record<string, unknown> {
    const memory = this.#memoryStatus()
    return {
      ...this.dtpObject(),
      graphVersion: this.graph.graphVersion,
      memory: { rssBytes: memory.rssBytes, limitBytes: memory.limitBytes, watchdog: memory.watchdog },
    }
  }

  #snapshotContext(): SnapshotContext {
    const stats = this.graph.stats()
    const roots = this.repo.roots()
    const access = this.access()
    const authOn = access.reads === 'members' || access.writes === 'members'
    const members = this.membership.members().filter((m) => !m.banned)
    return {
      server: {
        kind: 'personal',
        version: VERSION,
        api: API_VERSION,
        model: MODEL_VERSION,
        corpus: CORPUS_VERSION,
        instanceId: this.instanceId,
        startedAt: this.startedAt,
        uptimeSeconds: Math.floor(Date.now() / 1000) - this.startedAt,
      },
      health: {
        ready: this.#ready,
        stateSinceSeconds: Math.floor((Date.now() - this.#readySince) / 1000),
        notReadyReason: this.#ready ? null : 'starting',
      },
      graph: {
        graphVersion: this.graph.graphVersion,
        epochLagSeconds: null,
        nodes: stats.nodes,
        edges: stats.edges,
        claims: stats.claims,
        hintedStatements: stats.hintedStatements,
        deleteFloors: stats.deleteFloors,
      },
      memory: this.#memoryStatus(),
      roots: { active: roots.length, warming: this.sync.warmingCount(), coveragePushes: this.#coveragePushes },
      sources: { relays: this.sync.pool.status(), frontier: this.sync.frontier() },
      config: {
        effective: {
          listen: this.config.listen,
          port: this.#port,
          adminPort: this.#adminPort,
          allowedOrigins: this.config.allowedOrigins,
          'auth.reads': access.reads,
          'auth.writes': access.writes,
          'auth.admins': access.admins.length,
          guardrails: this.guardrails,
          memory: this.memory,
          relays: this.repo.setting<string[]>('relays', []),
        },
        nip11: this.nip11(),
        membership: authOn
          ? {
              counts: {
                read: members.filter((m) => m.roles.includes('read')).length,
                write: members.filter((m) => m.roles.includes('write')).length,
                admin: members.filter((m) => m.roles.includes('admin')).length,
              },
              members: members.map((m) => ({ pubkey: m.pubkey, roles: m.roles })),
            }
          : null,
      },
      queueCap: this.memory.ingestQueueCap,
      operationDeadlineMs: this.guardrails.operationDeadline,
    }
  }

  snapshot(): ReturnType<Telemetry['snapshot']> {
    return this.telemetry.snapshot(this.#snapshotContext())
  }
}
