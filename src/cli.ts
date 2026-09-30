#!/usr/bin/env node
/**
 * `dtp-personal` (operations.md § CLI).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { WebSocket } from 'ws'
import {
  DEFAULT_PORT,
  configPath,
  defaultBootstrap,
  loadConfig,
  writeBootstrap,
  type ListenScope,
  type ServerConfig,
} from './config.js'
import { GraphManager } from './graph/graph-manager.js'
import { IngestPipeline } from './ingest/pipeline.js'
import { loadOrCreateServerKey } from './keys.js'
import { Membership, isRole, type Role } from './membership.js'
import { PersonalServer } from './server.js'
import { openDatabase } from './storage/database.js'
import { Repository } from './storage/repository.js'
import { Telemetry } from './telemetry/telemetry.js'

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

const consoleIo: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }

interface Parsed {
  positional: string[]
  flags: Map<string, string[]>
}

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      const next = argv[i + 1]
      const value = eq > 0 ? arg.slice(eq + 1) : next !== undefined && !next.startsWith('--') ? (i += 1, next) : 'true'
      flags.set(name, [...(flags.get(name) ?? []), value])
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const flag = (p: Parsed, name: string) => p.flags.get(name)?.at(-1)

/** npub or 64-hex → hex. */
export function toHexPubkey(value: string): string {
  if (/^[0-9a-f]{64}$/.test(value)) return value
  const decoded = nip19.decode(value)
  if (decoded.type !== 'npub') throw new Error(`${value} is not an npub or 64-hex pubkey`)
  return decoded.data
}

/** CLI subject: npub / hex → p; `user:id:N`, `post:id:N`, other `i` → i; `e:<hex>` → e. */
export function parseSubject(value: string): { type: 'p' | 'e' | 'i'; value: string } {
  if (value.startsWith('e:')) return { type: 'e', value: value.slice(2) }
  if (value.startsWith('npub1') || /^[0-9a-f]{64}$/.test(value)) return { type: 'p', value: toHexPubkey(value) }
  return { type: 'i', value }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function withRepo<T>(config: ServerConfig, fn: (repo: Repository) => T): T {
  const db = openDatabase(join(config.dataDir, 'personal.sqlite'))
  try {
    return fn(new Repository(db))
  } finally {
    db.close()
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function serverRunning(config: ServerConfig): Promise<boolean> {
  try {
    await fetchJson(`http://127.0.0.1:${config.port}/healthz`)
    return true
  } catch {
    return false
  }
}

/** Open a protocol socket to the running server and exchange frames. */
async function withSocket<T>(config: ServerConfig, fn: (ws: WebSocket, next: () => Promise<unknown[]>) => Promise<T>): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/`)
  const queue: unknown[][] = []
  const waiters: Array<(frame: unknown[]) => void> = []
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as unknown[]
    if (frame[0] === 'AUTH') return
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const next = () =>
    new Promise<unknown[]>((resolve) => {
      const frame = queue.shift()
      if (frame) resolve(frame)
      else waiters.push(resolve)
    })
  try {
    return await fn(ws, next)
  } finally {
    ws.close()
  }
}

/** JSON Lines of signed events, a JSON array, or an `{ events: [...] }` export document. */
export function readEvents(file: string): unknown[] {
  const text = readFileSync(file, 'utf8').trim()
  if (text.length === 0) return []
  try {
    const whole = JSON.parse(text) as unknown
    if (Array.isArray(whole)) return whole
    if (whole && typeof whole === 'object') {
      const events = (whole as { events?: unknown }).events
      return Array.isArray(events) ? events : [whole]
    }
  } catch {
    // Not one JSON document: JSON Lines.
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

function printStatus(io: CliIo, snap: Record<string, any>): void {
  const g = snap.graph
  io.out(`DTP Personal Server ${snap.server.version} — ${snap.health.ready ? 'ready' : 'NOT READY'}, up ${snap.server.uptimeSeconds}s`)
  io.out(`instance ${snap.server.instanceId} · api ${snap.server.api} · model ${snap.server.model}`)
  io.out(`graphVersion ${g.graphVersion} · nodes ${g.nodes} · edges 32009 ${g.edges['32009']} / 32014 ${g.edges['32014']} · claims ${g.claims} · floors ${g.deleteFloors}`)
  const mem = snap.memory
  io.out(`memory rss ${(mem.rssBytes / 1048576).toFixed(1)} MiB · watchdog ${mem.watchdog} · event-loop lag p99 ${mem.impl.eventLoopLagP99Ms} ms`)
  io.out(`limits: heap edges ${mem.impl.heapEdgeLimit} · heap nodes ${mem.impl.heapNodeLimit}`)
  io.out(`connections ${snap.connections.open} · in flight ${snap.queries.inFlight} · roots ${snap.roots.active}`)
  io.out(`relays: ${(snap.sources.relays as Array<{ url: string; state: string }>).map((r) => `${r.url} ${r.state}`).join(', ') || 'none'} · frontier ${snap.sources.frontier?.size ?? 'n/a'}`)
  const alerts = (snap.alerts as Array<{ name: string; active: boolean }>).filter((a) => a.active)
  io.out(`alerts: ${alerts.length === 0 ? 'none' : alerts.map((a) => a.name).join(', ')}`)
}

export async function runCli(argv: readonly string[], io: CliIo = consoleIo, env = process.env): Promise<number> {
  const parsed = parseArgs(argv)
  const [command, sub, ...rest] = parsed.positional
  const dataDir = flag(parsed, 'data-dir')
  const config = () => loadConfig({ ...(dataDir ? { dataDir } : {}), env })
  switch (command) {
    case 'init': {
      const cfg = loadConfig({ ...(dataDir ? { dataDir } : {}), env })
      let port = Number(flag(parsed, 'port') ?? DEFAULT_PORT)
      if (!Number.isInteger(port) || port <= 0 || port > 65_534) {
        io.err('--port must be 1–65534')
        return 1
      }
      while (!(await portFree(port)) || !(await portFree(port + 1))) port += 2
      const listen = (flag(parsed, 'listen') ?? 'local') as ListenScope
      if (listen !== 'local' && listen !== 'lan') {
        io.err('--listen must be local or lan')
        return 1
      }
      const bootstrap = existsSync(configPath(cfg.dataDir))
        ? { ...defaultBootstrap(port), ...JSON.parse(readFileSync(configPath(cfg.dataDir), 'utf8')), port, listen, admin: { port: port + 1, auth: 'local' } }
        : { ...defaultBootstrap(port), listen }
      const origins = parsed.flags.get('allow-origin')
      if (origins) bootstrap.allowedOrigins = origins
      mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
      writeBootstrap(cfg.dataDir, bootstrap)
      const key = loadOrCreateServerKey(cfg.dataDir)
      withRepo(cfg, () => undefined)
      io.out(`data directory ${cfg.dataDir}`)
      io.out(`protocol ws://127.0.0.1:${port}/ · admin http://127.0.0.1:${port + 1}/ · listen ${listen}`)
      io.out(`server key (self) ${key.pubkey}`)
      return 0
    }
    case 'start': {
      const cfg = config()
      if (!existsSync(configPath(cfg.dataDir))) {
        io.err(`no config at ${configPath(cfg.dataDir)}; run \`dtp-personal init\` first`)
        return 1
      }
      const server = await PersonalServer.start(cfg)
      io.out(`DTP Personal Server on ${server.url} — telemetry ${server.adminUrl} — Ctrl+C to stop`)
      await new Promise<void>((resolve) => {
        const stop = () => resolve()
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      await server.stop()
      return 0
    }
    case 'status': {
      const cfg = config()
      try {
        const snap = (await fetchJson(`http://127.0.0.1:${cfg.admin.port}/admin/api/telemetry`)) as Record<string, any>
        if (flag(parsed, 'json') === 'true') io.out(JSON.stringify(snap, null, 2))
        else printStatus(io, snap)
        return 0
      } catch (error) {
        io.err(`server not reachable on the admin port ${cfg.admin.port}: ${(error as Error).message}`)
        return 1
      }
    }
    case 'dashboard': {
      const cfg = config()
      const url = `http://127.0.0.1:${cfg.admin.port}/`
      const opener =
        process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref()
      io.out(url)
      return 0
    }
    case 'roots':
    case 'relays':
    case 'members':
    case 'auth':
      return manage(command, sub, rest, parsed, config(), io)
    case 'sync':
      return withRepo(config(), (repo) => {
        switch (sub) {
          case 'start':
          case 'stop':
            repo.setSetting('sync.enabled', sub === 'start')
            io.out(`sync ${sub === 'start' ? 'enabled' : 'disabled'} (a running server picks this up within 5 s)`)
            return 0
          case 'refresh':
            repo.setSetting('sync.refreshAt', Math.floor(Date.now() / 1000))
            io.out('frontier refresh requested')
            return 0
          case 'strategy': {
            const value = rest[0]
            if (value !== 'frontier-continuous' && value !== 'frontier-interval' && value !== 'global-continuous') {
              io.err('usage: dtp-personal sync strategy frontier-continuous|frontier-interval|global-continuous')
              return 1
            }
            repo.setSetting('sync.strategy', value)
            if (value === 'frontier-interval' && rest[1]) repo.setSetting('sync.intervalMinutes', Number(rest[1]))
            io.out(`sync.strategy = ${value}`)
            return 0
          }
          default:
            io.err('usage: dtp-personal sync start|stop|refresh|strategy <name> [minutes]')
            return 1
        }
      })
    case 'export': {
      const cfg = config()
      const out = flag(parsed, 'out')
      const lines = withRepo(cfg, (repo) => [...repo.iterateAll()].map((event) => JSON.stringify(event)))
      const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
      if (out) writeFileSync(out, text)
      else io.out(text.trimEnd())
      io.err(`exported ${lines.length} signed events`)
      return 0
    }
    case 'import': {
      const file = sub
      if (!file) {
        io.err('usage: dtp-personal import <file.jsonl | file.json>')
        return 1
      }
      const cfg = config()
      const events = readEvents(file)
      const tally = new Map<string, number>()
      const count = (message: string, ok: boolean) => {
        const key = ok ? (message.startsWith('duplicate') ? 'duplicate' : 'accepted') : message.split(':')[0] || 'rejected'
        tally.set(key, (tally.get(key) ?? 0) + 1)
      }
      if (await serverRunning(cfg)) {
        await withSocket(cfg, async (ws, next) => {
          for (const event of events) {
            ws.send(JSON.stringify(['EVENT', event]))
            const frame = await next()
            count(String(frame[3] ?? ''), frame[2] === true)
          }
        })
      } else {
        const db = openDatabase(join(cfg.dataDir, 'personal.sqlite'))
        try {
          const repo = new Repository(db)
          const graph = new GraphManager()
          graph.load(repo)
          const pipeline = new IngestPipeline(repo, graph, new Telemetry(), { maxHeapEdges: Number.POSITIVE_INFINITY })
          for (const event of events) {
            const outcome = await pipeline.ingest(event, 'local')
            count(outcome.message, outcome.ok)
          }
        } finally {
          db.close()
        }
      }
      io.out([...tally].map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to import')
      return 0
    }
    case 'query': {
      if (sub !== 'trust' && sub !== 'rating') {
        io.err('usage: dtp-personal query trust|rating <root npub|hex> <subject>')
        return 1
      }
      const [root, subject] = rest
      if (!root || !subject) {
        io.err('usage: dtp-personal query trust|rating <root npub|hex> <subject>')
        return 1
      }
      const cfg = config()
      const result = await withSocket(cfg, async (ws, next) => {
        ws.send(
          JSON.stringify(['DTP', 'cli-1', `${sub}.query`, { rootPubkey: toHexPubkey(root), subject: parseSubject(subject), format: 'path' }]),
        )
        return next()
      })
      io.out(JSON.stringify(result, null, 2))
      return result[0] === 'DTP-OK' ? 0 : 1
    }
    case undefined:
    case 'help':
    case '--help':
      io.out(
        [
          'dtp-personal init [--port 3870] [--listen local|lan] [--allow-origin <origin>]… [--data-dir <dir>]',
          'dtp-personal start | status [--json] | dashboard',
          'dtp-personal roots add|remove|list <npub|hex>',
          'dtp-personal relays add|remove|list <wss://…>',
          'dtp-personal sync start|stop|refresh | sync strategy frontier-continuous|frontier-interval <minutes>|global-continuous',
          'dtp-personal auth reads|writes open|members',
          'dtp-personal members add|remove|list <npub|hex> [--role read|write|admin]',
          'dtp-personal export [--out events.jsonl] | import <file>',
          'dtp-personal query trust|rating <root> <subject>',
        ].join('\n'),
      )
      return 0
    default:
      io.err(`unknown command ${command}; try dtp-personal help`)
      return 1
  }
}

function manage(command: string, sub: string | undefined, rest: string[], parsed: Parsed, cfg: ServerConfig, io: CliIo): number {
  const db = openDatabase(join(cfg.dataDir, 'personal.sqlite'))
  try {
    const repo = new Repository(db)
    const target = rest[0]
    switch (command) {
      case 'roots':
        if (sub === 'list') {
          for (const root of repo.roots()) io.out(`${root.pubkey} ${root.configured ? 'configured' : `active (day ${root.lastActiveDay})`}`)
          return 0
        }
        if (!target || (sub !== 'add' && sub !== 'remove')) break
        if (sub === 'add') repo.addConfiguredRoot(toHexPubkey(target))
        else if (!repo.removeRoot(toHexPubkey(target))) io.err('not a root')
        return 0
      case 'relays': {
        const relays = repo.setting<string[]>('relays', [])
        if (sub === 'list') {
          for (const relay of relays) io.out(relay)
          return 0
        }
        if (!target || (sub !== 'add' && sub !== 'remove')) break
        if (sub === 'add') {
          if (!/^wss?:\/\//.test(target)) {
            io.err('relay URL must start with wss:// or ws://')
            return 1
          }
          repo.setSetting('relays', [...new Set([...relays, target])])
        } else {
          repo.setSetting('relays', relays.filter((r) => r !== target))
        }
        return 0
      }
      case 'auth': {
        const value = rest[0]
        if ((sub !== 'reads' && sub !== 'writes') || (value !== 'open' && value !== 'members')) break
        repo.setSetting(`auth.${sub}`, value)
        io.out(`auth.${sub} = ${value}`)
        return 0
      }
      case 'members': {
        const membership = new Membership(repo, loadOrCreateServerKey(cfg.dataDir))
        if (sub === 'list') {
          for (const m of membership.members()) io.out(`${m.pubkey} ${m.banned ? 'banned' : m.roles.join(',')}`)
          return 0
        }
        if (!target || (sub !== 'add' && sub !== 'remove')) break
        const pubkey = toHexPubkey(target)
        if (sub === 'remove') {
          if (!membership.remove(pubkey)) io.err('not a member')
          return 0
        }
        const roles = (parsed.flags.get('role') ?? ['read', 'write']).filter((r): r is Role => isRole(r))
        membership.allow(pubkey, roles)
        return 0
      }
      default:
        break
    }
    io.err(`usage: dtp-personal ${command} …; see dtp-personal help`)
    return 1
  } finally {
    db.close()
  }
}

const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1])
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error((error as Error).message)
      process.exit(1)
    },
  )
}
