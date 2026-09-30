/**
 * Signature worker (architecture.md § Process model): checks the event id
 * hash and the Schnorr signature off the main thread.
 */

import { parentPort } from 'node:worker_threads'
import { verifyEvent, type Event } from 'nostr-tools'

parentPort?.on('message', (message: { id: number; event: Event }) => {
  let ok = false
  try {
    ok = verifyEvent(message.event)
  } catch {
    ok = false
  }
  parentPort?.postMessage({ id: message.id, ok })
})
