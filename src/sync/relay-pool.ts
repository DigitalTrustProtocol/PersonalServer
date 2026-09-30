/**
 * Outbound relay connections on Node's global `WebSocket` (operations.md
 * § Runtime): the `RelayQueryClient` / `RelaySubscribeClient` ports of
 * `@dtp/relay-sync`. One socket per relay; events of one subscription are
 * handled in order and awaited before `EOSE` resolves a query.
 */

import type { Event, Filter } from 'nostr-tools'
import type {
  RelayQueryClient,
  RelayQueryRequest,
  RelaySubscribeClient,
  RelaySubscribeRequest,
  RelaySubscription,
} from '@dtp/relay-sync'
import type { RelayRow } from '@dtp/telemetry-ui'

const CONNECT_TIMEOUT_MS = 10_000
const QUERY_IDLE_TIMEOUT_MS = 30_000

interface SubHandlers {
  onEvent(event: Event): void | Promise<void>
  onEose(): void
  onClosed(reason: string): void
  chain: Promise<void>
}

class RelayConnection {
  readonly url: string
  state: RelayRow['state'] = 'idle'
  errors = 0
  lastEoseAt: number | null = null
  retryAt: number | null = null
  #ws: WebSocket | undefined
  #opening: Promise<WebSocket> | undefined
  readonly subs = new Map<string, SubHandlers>()

  constructor(url: string) {
    this.url = url
  }

  open(): Promise<WebSocket> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return Promise.resolve(this.#ws)
    if (this.#opening) return this.#opening
    this.state = 'connecting'
    this.#opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`connect timeout ${this.url}`))
      }, CONNECT_TIMEOUT_MS)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        this.#ws = ws
        this.state = 'live'
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        this.errors += 1
        this.state = 'error'
        reject(new Error(`relay error ${this.url}`))
      })
      ws.addEventListener('close', () => {
        this.#ws = undefined
        if (this.state !== 'error') this.state = 'idle'
        for (const [id, sub] of this.subs) {
          this.subs.delete(id)
          sub.onClosed('disconnected')
        }
      })
      ws.addEventListener('message', (message) => this.#onMessage(String(message.data)))
    }).finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }

  #onMessage(text: string): void {
    let frame: unknown[]
    try {
      frame = JSON.parse(text) as unknown[]
    } catch {
      return
    }
    if (!Array.isArray(frame) || typeof frame[1] !== 'string') return
    const sub = this.subs.get(frame[1])
    if (!sub) return
    switch (frame[0]) {
      case 'EVENT': {
        const event = frame[2] as Event
        sub.chain = sub.chain.then(() => sub.onEvent(event)).catch(() => undefined)
        return
      }
      case 'EOSE':
        sub.chain = sub.chain.then(() => {
          this.lastEoseAt = Math.floor(Date.now() / 1000)
          sub.onEose()
        })
        return
      case 'CLOSED':
        this.subs.delete(frame[1])
        sub.onClosed(String(frame[2] ?? 'closed'))
        return
      default:
    }
  }

  send(frame: unknown[]): void {
    this.#ws?.send(JSON.stringify(frame))
  }

  close(): void {
    this.#ws?.close()
    this.#ws = undefined
    this.state = 'idle'
  }
}

let subCounter = 0
const nextSubId = () => `dtp-${(++subCounter).toString(36)}`

export class RelayPool implements RelayQueryClient, RelaySubscribeClient {
  readonly #relays = new Map<string, RelayConnection>()

  #relay(url: string): RelayConnection {
    let relay = this.#relays.get(url)
    if (!relay) {
      relay = new RelayConnection(url)
      this.#relays.set(url, relay)
    }
    return relay
  }

  async query(request: RelayQueryRequest): Promise<void> {
    const relay = this.#relay(request.relayUrl)
    await relay.open()
    const id = nextSubId()
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const idle = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish(new Error(`query timeout ${request.relayUrl}`)), QUERY_IDLE_TIMEOUT_MS)
      }
      const finish = (error?: Error) => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        if (relay.subs.delete(id)) relay.send(['CLOSE', id])
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => finish(new Error('aborted'))
      request.signal?.addEventListener('abort', onAbort, { once: true })
      relay.subs.set(id, {
        onEvent: async (event) => {
          idle()
          await request.onEvent(event)
        },
        onEose: () => finish(),
        onClosed: (reason) => finish(new Error(`relay closed ${request.relayUrl}: ${reason}`)),
        chain: Promise.resolve(),
      })
      relay.state = 'syncing'
      idle()
      relay.send(['REQ', id, request.filter as Filter])
    })
    relay.state = 'live'
  }

  subscribe(request: RelaySubscribeRequest): RelaySubscription {
    const relay = this.#relay(request.relayUrl)
    const id = nextSubId()
    let closed = false
    const close = (reason?: string) => {
      if (closed) return
      closed = true
      if (relay.subs.delete(id)) relay.send(['CLOSE', id])
      request.onClose?.(reason ?? 'closed')
    }
    request.signal?.addEventListener('abort', () => close('aborted'), { once: true })
    relay
      .open()
      .then(() => {
        if (closed) return
        relay.subs.set(id, {
          onEvent: request.onEvent,
          onEose: () => request.onEose?.(),
          onClosed: (reason) => {
            closed = true
            request.onClose?.(reason)
          },
          chain: Promise.resolve(),
        })
        relay.send(['REQ', id, request.filter as Filter])
      })
      .catch((error: Error) => {
        closed = true
        request.onClose?.(error.message)
      })
    return { close }
  }

  releaseRelay(relayUrl: string): void {
    this.#relays.get(relayUrl)?.close()
    this.#relays.delete(relayUrl)
  }

  close(): void {
    for (const relay of this.#relays.values()) relay.close()
    this.#relays.clear()
  }

  status(): RelayRow[] {
    return [...this.#relays.values()].map((relay) => ({
      url: relay.url,
      state: relay.state,
      lastEoseAt: relay.lastEoseAt,
      cursorLagSeconds: relay.lastEoseAt === null ? null : Math.floor(Date.now() / 1000) - relay.lastEoseAt,
      errors: relay.errors,
      retryAt: relay.retryAt,
    }))
  }
}
