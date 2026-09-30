/**
 * `graph` pushes (resolver-api.md § Push topics): coalesced to at most 4 per
 * second; `changed.subjects` is included when at most 500 subjects changed
 * since the last push.
 */

import type { GraphChange } from '../graph/graph-manager.js'
import type { Connection } from './connection.js'

export const PUSH_INTERVAL_MS = 250
export const MAX_CHANGED_SUBJECTS = 500

export class PushHub {
  readonly #connections: () => Iterable<Connection>
  #subjects = new Set<string>()
  #overflow = false
  #graphVersion = 0
  #timer: NodeJS.Timeout | undefined
  #lastSent = 0

  constructor(connections: () => Iterable<Connection>) {
    this.#connections = connections
  }

  onChange(change: GraphChange): void {
    this.#graphVersion = change.graphVersion
    for (const subject of change.subjects) {
      if (this.#subjects.size >= MAX_CHANGED_SUBJECTS) {
        this.#overflow = true
        break
      }
      this.#subjects.add(subject)
    }
    if (this.#timer) return
    const wait = Math.max(0, this.#lastSent + PUSH_INTERVAL_MS - Date.now())
    this.#timer = setTimeout(() => this.flush(), wait)
    this.#timer.unref()
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#graphVersion === 0) return
    const data: Record<string, unknown> = { graphVersion: this.#graphVersion }
    if (!this.#overflow && this.#subjects.size > 0) data.changed = { subjects: [...this.#subjects].sort() }
    this.#subjects = new Set()
    this.#overflow = false
    this.#lastSent = Date.now()
    for (const connection of this.#connections()) {
      if (connection.subscriptions.has('graph')) connection.send(['DTP-PUSH', 'graph', data])
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
