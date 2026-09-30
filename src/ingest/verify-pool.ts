/**
 * Signature worker pool (architecture.md § Process model): `worker_threads`
 * running nostr-tools verification in parallel, sized `max(1, cores − 1)`
 * (capped by the `verifyWorkers` setting). Workers start on first use.
 */

import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { Event } from 'nostr-tools'

interface Pending {
  resolve(ok: boolean): void
  reject(error: Error): void
}

function workerUrl(): URL {
  const js = new URL('./verify-worker.js', import.meta.url)
  // Tests run the TypeScript sources; Node strips types in workers too.
  return existsSync(fileURLToPath(js)) ? js : new URL('./verify-worker.ts', import.meta.url)
}

export class VerifyPool {
  readonly size: number
  readonly #workers: Worker[] = []
  readonly #pending = new Map<number, Pending>()
  #next = 0
  #seq = 0
  #closed = false

  constructor(size = Math.max(1, cpus().length - 1)) {
    this.size = Math.max(1, size)
  }

  #spawn(): void {
    const url = workerUrl()
    for (let i = this.#workers.length; i < this.size; i += 1) {
      const worker = new Worker(url)
      worker.unref()
      worker.on('message', (message: { id: number; ok: boolean }) => {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        pending.resolve(message.ok)
      })
      worker.on('error', (error) => {
        for (const [id, pending] of this.#pending) {
          this.#pending.delete(id)
          pending.reject(error)
        }
      })
      this.#workers.push(worker)
    }
  }

  /** True when the event id matches its hash and the signature verifies. */
  verify(event: Event): Promise<boolean> {
    if (this.#closed) return Promise.reject(new Error('verify pool closed'))
    if (this.#workers.length === 0) this.#spawn()
    const id = ++this.#seq
    const worker = this.#workers[this.#next++ % this.#workers.length]!
    return new Promise<boolean>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      worker.postMessage({
        id,
        event: {
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        },
      })
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(new Error('verify pool closed'))
    this.#pending.clear()
    await Promise.all(this.#workers.map((worker) => worker.terminate()))
    this.#workers.length = 0
  }
}
