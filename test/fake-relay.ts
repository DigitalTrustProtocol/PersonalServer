/**
 * A tiny in-process Nostr relay for sync tests: stores events, answers REQ
 * with NIP-01 filter matching (ids, authors, kinds, #tags, since, until,
 * limit), then EOSE, and streams later matching events to open subscriptions.
 */

import type { AddressInfo } from 'node:net'
import type { Event } from 'nostr-tools'
import { WebSocketServer, type WebSocket } from 'ws'

type Filter = Record<string, unknown>

function matches(event: Event, filter: Filter): boolean {
  const list = (key: string) => filter[key] as unknown[] | undefined
  if (list('ids') && !list('ids')!.includes(event.id)) return false
  if (list('authors') && !list('authors')!.includes(event.pubkey)) return false
  if (list('kinds') && !list('kinds')!.includes(event.kind)) return false
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    const name = key.slice(1)
    if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false
  }
  return true
}

export class FakeRelay {
  readonly events: Event[] = []
  readonly requests: Filter[] = []
  readonly #wss: WebSocketServer
  readonly #subs = new Map<WebSocket, Map<string, Filter[]>>()

  private constructor(wss: WebSocketServer) {
    this.#wss = wss
    wss.on('connection', (ws) => {
      this.#subs.set(ws, new Map())
      ws.on('close', () => this.#subs.delete(ws))
      ws.on('message', (data) => this.#onMessage(ws, JSON.parse(data.toString()) as unknown[]))
    })
  }

  static async start(): Promise<FakeRelay> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    return new FakeRelay(wss)
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.#wss.address() as AddressInfo).port}/`
  }

  publish(event: Event): void {
    this.events.push(event)
    for (const [ws, subs] of this.#subs) {
      for (const [id, filters] of subs) {
        if (filters.some((f) => matches(event, f))) ws.send(JSON.stringify(['EVENT', id, event]))
      }
    }
  }

  #onMessage(ws: WebSocket, frame: unknown[]): void {
    if (frame[0] === 'REQ') {
      const id = frame[1] as string
      const filters = frame.slice(2) as Filter[]
      this.requests.push(...filters)
      this.#subs.get(ws)?.set(id, filters)
      const seen = new Set<string>()
      for (const filter of filters) {
        const hits = this.events
          .filter((e) => matches(e, filter))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, typeof filter.limit === 'number' ? filter.limit : undefined)
        for (const event of hits) {
          if (seen.has(event.id)) continue
          seen.add(event.id)
          ws.send(JSON.stringify(['EVENT', id, event]))
        }
      }
      ws.send(JSON.stringify(['EOSE', id]))
    } else if (frame[0] === 'CLOSE') {
      this.#subs.get(ws)?.delete(frame[1] as string)
    }
  }

  async close(): Promise<void> {
    for (const ws of this.#wss.clients) ws.terminate()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }
}
