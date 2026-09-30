/**
 * The server's own keypair (NIP-11 `self`): signs the NIP-43 membership list.
 * A server identity, never a user key. Stored owner-only in the data dir.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

const bytesToHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

export interface ServerKey {
  secretKey: Uint8Array
  pubkey: string
}

export function serverKeyPath(dataDir: string): string {
  return join(dataDir, 'server.key')
}

export function loadOrCreateServerKey(dataDir: string): ServerKey {
  const path = serverKeyPath(dataDir)
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${path} is not a 64-hex secret key`)
    const secretKey = hexToBytes(hex)
    return { secretKey, pubkey: getPublicKey(secretKey) }
  }
  const secretKey = generateSecretKey()
  writeFileSync(path, `${bytesToHex(secretKey)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows: the data directory ACL protects the file (security.md).
  }
  return { secretKey, pubkey: getPublicKey(secretKey) }
}
