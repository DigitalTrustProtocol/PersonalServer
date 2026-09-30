import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools'
import {
  buildKind10011Event,
  buildKind32009Event,
  buildKind32014Event,
  type BuildKind32009Input,
  type BuildKind32014Input,
} from '@dtp/trust-protocol'
import { WebSocket } from 'ws'
import { defaultBootstrap, type ServerConfig } from '../src/config.js'
import { PersonalServer } from '../src/server.js'

export interface Actor {
  sk: Uint8Array
  pk: string
  npub: string
}

export function actor(): Actor {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  return { sk, pk, npub: nip19.npubEncode(pk) }
}

export const NOW = Math.floor(Date.now() / 1000)

export async function trustEvent(
  who: Actor,
  input: Partial<BuildKind32009Input> & Pick<BuildKind32009Input, 'subject'>,
): Promise<Event> {
  return finalizeEvent(
    await buildKind32009Event({ value: '1', context: 'identity', createdAt: NOW - 100, ...input }),
    who.sk,
  )
}

export async function ratingEvent(
  who: Actor,
  input: Partial<BuildKind32014Input> & Pick<BuildKind32014Input, 'subject'>,
): Promise<Event> {
  return finalizeEvent(
    await buildKind32014Event({ score: '80', scopes: ['x.com'], createdAt: NOW - 100, ...input }),
    who.sk,
  )
}

export function claimEvent(who: Actor, twitterId: string, handle = 'someone'): Event {
  return finalizeEvent(buildKind10011Event({ handle, twitterId, createdAt: NOW - 100 }), who.sk)
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dtp-ps-test-'))
}

export function testConfig(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const bootstrap = defaultBootstrap(0)
  return {
    ...bootstrap,
    port: 0,
    admin: { port: 0, auth: 'local' },
    dataDir,
    host: '127.0.0.1',
    logLevel: 'error',
    ...overrides,
  }
}

export interface Harness {
  server: PersonalServer
  dataDir: string
  close(): Promise<void>
}

const silent = { error() {}, warn() {}, info() {}, debug() {} }

export async function startServer(
  options: { dataDir?: string; config?: Partial<ServerConfig>; setup?: (server: PersonalServer) => void } = {},
): Promise<Harness> {
  const dataDir = options.dataDir ?? tempDir()
  const server = await PersonalServer.start(testConfig(dataDir, options.config), { logger: silent })
  options.setup?.(server)
  return {
    server,
    dataDir,
    async close() {
      await server.stop()
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

type Frame = unknown[]

/** A raw protocol client: frames in, frames out, with small helpers. */
export class TestClient {
  readonly ws: WebSocket
  readonly frames: Frame[] = []
  #waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  #seq = 0
  challenge = ''

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame
      if (frame[0] === 'AUTH' && typeof frame[1] === 'string') this.challenge = frame[1]
      const index = this.#waiters.findIndex((w) => w.match(frame))
      if (index >= 0) {
        const [waiter] = this.#waiters.splice(index, 1)
        waiter!.resolve(frame)
      } else {
        this.frames.push(frame)
      }
    })
  }

  static async connect(
    url: string,
    headers: Record<string, string> = {},
    options: { perMessageDeflate?: boolean } = {},
  ): Promise<TestClient> {
    const ws = new WebSocket(url, { headers, perMessageDeflate: options.perMessageDeflate ?? true })
    const client = new TestClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
    await client.next((f) => f[0] === 'AUTH')
    return client
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame))
  }

  next(match: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    const queued = this.frames.findIndex(match)
    if (queued >= 0) return Promise.resolve(this.frames.splice(queued, 1)[0]!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
      this.#waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }

  /** `["DTP", id, op, params]` → the DTP-OK result, or throws with the DTP-ERR code. */
  async dtp<T = any>(op: string, params: unknown = {}): Promise<T> {
    const frame = await this.dtpFrame(op, params)
    if (frame[0] === 'DTP-OK') return frame[2] as T
    const error = new Error(String(frame[3])) as Error & { code?: string }
    error.code = String(frame[2])
    throw error
  }

  async dtpFrame(op: string, params: unknown = {}): Promise<Frame> {
    const id = `r${++this.#seq}`
    this.send(['DTP', id, op, params])
    return this.next((f) => (f[0] === 'DTP-OK' || f[0] === 'DTP-ERR') && f[1] === id)
  }

  async publish(event: Event | Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    this.send(['EVENT', event])
    const id = (event as { id?: string }).id ?? ''
    const frame = await this.next((f) => f[0] === 'OK' && f[1] === id)
    return { ok: frame[2] as boolean, message: frame[3] as string }
  }

  async req(...filters: unknown[]): Promise<{ events: Event[]; closed?: string }> {
    const sub = `s${++this.#seq}`
    this.send(['REQ', sub, ...filters])
    const events: Event[] = []
    for (;;) {
      const frame = await this.next((f) => (f[0] === 'EVENT' || f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === sub)
      if (frame[0] === 'EVENT') events.push(frame[2] as Event)
      else if (frame[0] === 'EOSE') return { events }
      else return { events, closed: frame[2] as string }
    }
  }

  close(): void {
    this.ws.close()
  }
}
