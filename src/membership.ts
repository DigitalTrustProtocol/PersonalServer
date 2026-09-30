/**
 * NIP-43 membership (resolver-api.md § The whitelist is a NIP-43 membership
 * list): members and roles in SQLite, published as a kind 13534 list signed
 * by the server key, plus kind 33534 role definitions. Re-signed after every
 * change.
 */

import { finalizeEvent, type Event } from 'nostr-tools'
import type { ServerKey } from './keys.js'
import type { MemberRow, Repository } from './storage/repository.js'

export const MEMBERSHIP_LIST_KIND = 13534
export const ROLE_DEFINITION_KIND = 33534
export const ROLES = ['read', 'write', 'admin'] as const
export type Role = (typeof ROLES)[number]

const ROLE_TEXT: Record<Role, string> = {
  read: 'May use DTP operations and REQ when auth.reads = members',
  write: 'May push EVENTs when auth.writes = members',
  admin: 'May use NIP-86 management',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export class Membership {
  readonly #repo: Repository
  readonly #key: ServerKey
  #list?: Event
  #roles?: Event[]

  constructor(repo: Repository, key: ServerKey) {
    this.#repo = repo
    this.#key = key
  }

  members(): MemberRow[] {
    return this.#repo.members()
  }

  rolesOf(pubkey: string): Set<Role> {
    const row = this.#repo.members().find((m) => m.pubkey === pubkey)
    if (!row || row.banned) return new Set()
    return new Set(row.roles.filter(isRole))
  }

  isBanned(pubkey: string): boolean {
    return this.#repo.members().some((m) => m.pubkey === pubkey && m.banned)
  }

  /** Add or update a member; `roles` default to read + write. */
  allow(pubkey: string, roles: readonly Role[] = ['read', 'write']): void {
    const existing = this.#repo.members().find((m) => m.pubkey === pubkey)
    this.#repo.putMember(pubkey, [...new Set([...(existing?.banned ? [] : (existing?.roles ?? [])), ...roles])])
    this.#invalidate()
  }

  assign(pubkey: string, role: Role): void {
    this.allow(pubkey, [role])
  }

  unassign(pubkey: string, role: Role): boolean {
    const existing = this.#repo.members().find((m) => m.pubkey === pubkey)
    if (!existing) return false
    this.#repo.putMember(pubkey, existing.roles.filter((r) => r !== role), existing.banned)
    this.#invalidate()
    return true
  }

  remove(pubkey: string): boolean {
    const removed = this.#repo.removeMember(pubkey)
    this.#invalidate()
    return removed
  }

  ban(pubkey: string): void {
    this.#repo.putMember(pubkey, [], true)
    this.#invalidate()
  }

  #invalidate(): void {
    this.#list = undefined
  }

  /** The current kind 13534, signed by the server key. */
  listEvent(now = Math.floor(Date.now() / 1000)): Event {
    if (!this.#list) {
      const tags: string[][] = [['-']]
      for (const member of this.#repo.members()) {
        if (member.banned || member.roles.length === 0) continue
        tags.push(['member', member.pubkey, ...member.roles])
      }
      this.#list = finalizeEvent({ kind: MEMBERSHIP_LIST_KIND, created_at: now, tags, content: '' }, this.#key.secretKey)
    }
    return this.#list
  }

  roleEvents(now = Math.floor(Date.now() / 1000)): Event[] {
    if (!this.#roles) {
      this.#roles = ROLES.map((role) =>
        finalizeEvent(
          { kind: ROLE_DEFINITION_KIND, created_at: now, tags: [['d', role]], content: ROLE_TEXT[role] },
          this.#key.secretKey,
        ),
      )
    }
    return this.#roles
  }
}
