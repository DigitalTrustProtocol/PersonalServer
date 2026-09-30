/**
 * Configuration (operations.md § Configuration, resolver-api.md
 * § Configuration). `config.json` in the data directory holds bootstrap
 * values; environment variables override it. Everything else lives in the
 * `settings` table and is changed with the CLI (or NIP-86).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_PORT = 3870

export type ListenScope = 'local' | 'lan'
export type AccessPolicy = 'open' | 'members'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** Shared guardrails (resolver-api.md § Guardrails), `dtp.limits` names. */
export interface Guardrails {
  operationDeadline: number
  batchDeadline: number
  maxDepth: number
  maxReachedNodes: number
  maxWalkRecords: number
  maxStatementLimit: number
  maxPathNodes: number
  maxNeighborhoodLimit: number
  maxBatchItems: number
  maxLookupKeys: number
  maxLookupPage: number
  maxLookupBatch: number
  maxLookupRecords: number
  maxInFlight: number
  maxConnections: number
  maxColdWalks: number
  maxUnsentOutput: number
  maxPendingOks: number
  maxWriterConnections: number
}

export const DEFAULT_GUARDRAILS: Readonly<Guardrails> = Object.freeze({
  operationDeadline: 500,
  batchDeadline: 1_000,
  maxDepth: 7,
  maxReachedNodes: 5_000_000,
  maxWalkRecords: 50_000_000,
  maxStatementLimit: 500,
  maxPathNodes: 1_000,
  maxNeighborhoodLimit: 500,
  maxBatchItems: 200,
  maxLookupKeys: 50,
  maxLookupPage: 500,
  maxLookupBatch: 50,
  maxLookupRecords: 5_000_000,
  maxInFlight: 32,
  maxConnections: 16,
  maxColdWalks: 4,
  maxUnsentOutput: 8 * 1024 * 1024,
  maxPendingOks: 5_000,
  maxWriterConnections: 8,
})

/** Memory guardrails (architecture.md § Guardrails). */
export interface MemoryGuardrails {
  maxHeapEdges: number
  maxHeapNodes: number
  /** V8 old-space limit the launcher sets; used for the watchdog percentages. */
  heapLimitBytes: number
  ingestQueueCap: number
}

export const DEFAULT_MEMORY_GUARDRAILS: Readonly<MemoryGuardrails> = Object.freeze({
  maxHeapEdges: 2_000_000,
  maxHeapNodes: 1_000_000,
  heapLimitBytes: 4 * 1024 * 1024 * 1024,
  ingestQueueCap: 50_000,
})

export const MAX_MESSAGE_LENGTH = 4 * 1024 * 1024

/** Bootstrap file `config.json`. */
export interface BootstrapConfig {
  port: number
  listen: ListenScope
  logLevel: LogLevel
  /** Web origins accepted at upgrade. A trailing `*` matches a prefix. */
  allowedOrigins: string[]
  /** Extra `Host` values accepted besides the local names of `port`. */
  allowedHosts: string[]
  admin: { port: number; auth: 'local' }
}

export interface ServerConfig extends BootstrapConfig {
  dataDir: string
  /** Bind address derived from `listen` (overridable for tests). */
  host: string
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.DTP_PERSONAL_DATA_DIR) return resolve(env.DTP_PERSONAL_DATA_DIR)
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'DigitalTrust', 'PersonalServer')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'DigitalTrust', 'PersonalServer')
  }
  const xdg = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(xdg, 'digitaltrust', 'personal-server')
}

export function defaultBootstrap(port = DEFAULT_PORT): BootstrapConfig {
  return {
    port,
    listen: 'local',
    logLevel: 'info',
    // Unpacked extension ids differ per install, so any extension origin is
    // accepted by default; websites (http/https origins) are not (PS-D6).
    allowedOrigins: ['chrome-extension://*'],
    allowedHosts: [],
    admin: { port: port + 1, auth: 'local' },
  }
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535
}

/** Parse and validate `config.json` content; unknown keys are ignored. */
export function parseBootstrap(raw: unknown, fallbackPort = DEFAULT_PORT): BootstrapConfig {
  const base = defaultBootstrap(fallbackPort)
  if (!raw || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>
  const port = isPort(record.port) ? record.port : base.port
  const listen = record.listen === 'lan' ? 'lan' : 'local'
  const logLevel = ['error', 'warn', 'info', 'debug'].includes(record.logLevel as string)
    ? (record.logLevel as LogLevel)
    : base.logLevel
  const strings = (value: unknown, fallback: string[]) =>
    Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : fallback
  const admin = (record.admin ?? {}) as Record<string, unknown>
  return {
    port,
    listen,
    logLevel,
    allowedOrigins: strings(record.allowedOrigins, base.allowedOrigins),
    allowedHosts: strings(record.allowedHosts, []),
    admin: { port: isPort(admin.port) ? admin.port : port === 0 ? 0 : port + 1, auth: 'local' },
  }
}

export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json')
}

export function loadConfig(options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): ServerConfig {
  const env = options.env ?? process.env
  const dataDir = options.dataDir ?? defaultDataDir(env)
  const path = configPath(dataDir)
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  const bootstrap = parseBootstrap(raw)
  if (env.DTP_PERSONAL_PORT && isPort(Number(env.DTP_PERSONAL_PORT))) {
    bootstrap.port = Number(env.DTP_PERSONAL_PORT)
    bootstrap.admin.port = bootstrap.port === 0 ? 0 : bootstrap.port + 1
  }
  if (env.DTP_PERSONAL_LISTEN === 'lan' || env.DTP_PERSONAL_LISTEN === 'local') {
    bootstrap.listen = env.DTP_PERSONAL_LISTEN
  }
  const level = env.DTP_PERSONAL_LOG_LEVEL
  if (level === 'error' || level === 'warn' || level === 'info' || level === 'debug') bootstrap.logLevel = level
  return { ...bootstrap, dataDir, host: bootstrap.listen === 'lan' ? '0.0.0.0' : '127.0.0.1' }
}

export function writeBootstrap(dataDir: string, config: BootstrapConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeFileSync(configPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/** Host header values accepted for a listener on `port` (DNS-rebinding guard). */
export function localHostNames(port: number, extra: readonly string[] = []): Set<string> {
  const names = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extra]
  return new Set(names.map((n) => n.toLowerCase()))
}

/** Origin allow-list match; a trailing `*` matches any suffix. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true
  const lower = origin.toLowerCase()
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase()
    return pattern.endsWith('*') ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern
  })
}
