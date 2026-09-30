/**
 * NIP-86 relay management over HTTP (`POST /`,
 * `Content-Type: application/nostr+json+rpc`), authorized with NIP-98
 * (kind 27235 in `Authorization: Nostr <base64>`). Only pubkeys listed in
 * `auth.admins` or holding the `admin` role may call it.
 */

import { createHash } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools'
import { isRole, type Membership } from '../membership.js'

const HTTP_AUTH_KIND = 27235
const HEX_64 = /^[0-9a-f]{64}$/

export const NIP86_METHODS = [
  'supportedmethods',
  'allowpubkey',
  'unallowpubkey',
  'listallowedpubkeys',
  'banpubkey',
  'listbannedpubkeys',
  'assignrole',
  'unassignrole',
] as const

export interface Nip86Request {
  method: string
  /** Absolute URL the request was sent to (`http://<Host><path>`). */
  url: string
  authorization: string | undefined
  body: string
}

export interface Nip86Response {
  status: number
  body: { result?: unknown; error?: string }
}

/** Verify the NIP-98 header; returns the signer pubkey or an error. */
export function verifyNip98(req: Nip86Request, now = Math.floor(Date.now() / 1000)): { pubkey: string } | { error: string } {
  const header = req.authorization ?? ''
  if (!header.startsWith('Nostr ')) return { error: 'missing NIP-98 Authorization header' }
  let event: Event
  try {
    event = JSON.parse(Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')) as Event
  } catch {
    return { error: 'Authorization is not a base64 JSON event' }
  }
  if (event.kind !== HTTP_AUTH_KIND) return { error: 'NIP-98 event must be kind 27235' }
  if (typeof event.created_at !== 'number' || Math.abs(event.created_at - now) > 60) return { error: 'NIP-98 event is stale' }
  const tag = (name: string) => event.tags?.find((t) => t[0] === name)?.[1]
  if (tag('u') !== req.url) return { error: 'NIP-98 u tag does not match the request URL' }
  if ((tag('method') ?? '').toUpperCase() !== req.method.toUpperCase()) return { error: 'NIP-98 method tag does not match' }
  const payload = createHash('sha256').update(req.body, 'utf8').digest('hex')
  if (tag('payload') !== payload) return { error: 'NIP-98 payload tag does not match the body' }
  let ok = false
  try {
    ok = verifyEvent(event)
  } catch {
    ok = false
  }
  if (!ok) return { error: 'NIP-98 signature does not verify' }
  return { pubkey: event.pubkey }
}

export function handleNip86(
  req: Nip86Request,
  deps: { membership: Membership; admins: () => readonly string[] },
): Nip86Response {
  const auth = verifyNip98(req)
  if ('error' in auth) return { status: 401, body: { error: auth.error } }
  const isAdmin = deps.admins().includes(auth.pubkey) || deps.membership.rolesOf(auth.pubkey).has('admin')
  if (!isAdmin) return { status: 403, body: { error: 'restricted: not an admin' } }
  let call: { method?: unknown; params?: unknown }
  try {
    call = JSON.parse(req.body) as typeof call
  } catch {
    return { status: 400, body: { error: 'invalid JSON-RPC body' } }
  }
  const params = Array.isArray(call.params) ? call.params : []
  const pubkey = typeof params[0] === 'string' ? params[0].toLowerCase() : undefined
  const needPubkey = () => (pubkey && HEX_64.test(pubkey) ? undefined : { status: 400, body: { error: 'params[0] must be a 64-hex pubkey' } })
  const m = deps.membership
  switch (call.method) {
    case 'supportedmethods':
      return { status: 200, body: { result: [...NIP86_METHODS] } }
    case 'allowpubkey':
      return needPubkey() ?? (m.allow(pubkey!), { status: 200, body: { result: true } })
    case 'unallowpubkey':
      return needPubkey() ?? { status: 200, body: { result: m.remove(pubkey!) } }
    case 'listallowedpubkeys':
      return {
        status: 200,
        body: { result: m.members().filter((row) => !row.banned).map((row) => ({ pubkey: row.pubkey, reason: row.roles.join(',') })) },
      }
    case 'banpubkey':
      return needPubkey() ?? (m.ban(pubkey!), { status: 200, body: { result: true } })
    case 'listbannedpubkeys':
      return { status: 200, body: { result: m.members().filter((row) => row.banned).map((row) => ({ pubkey: row.pubkey })) } }
    case 'assignrole':
    case 'unassignrole': {
      const missing = needPubkey()
      if (missing) return missing
      const role = params[1]
      if (!isRole(role)) return { status: 400, body: { error: 'params[1] must be read, write, or admin' } }
      if (call.method === 'assignrole') {
        m.assign(pubkey!, role)
        return { status: 200, body: { result: true } }
      }
      return { status: 200, body: { result: m.unassign(pubkey!, role) } }
    }
    default:
      return { status: 200, body: { error: `unsupported method ${String(call.method).slice(0, 64)}` } }
  }
}
