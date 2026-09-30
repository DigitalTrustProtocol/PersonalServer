/**
 * Interop: the shared @dtp/resolver-client (used by Attention and the
 * Website) against this server over a real socket, with Node's global
 * WebSocket.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools'
import { ResolverClient } from '@dtp/resolver-client'
import { actor, startServer, trustEvent, type Harness } from './helpers.js'

let h: Harness
const root = actor()
const alice = actor()
const bob = actor()

beforeAll(async () => {
  h = await startServer()
})

afterAll(async () => {
  await h.close()
})

describe('@dtp/resolver-client against the Personal Server', () => {
  it('publishes, queries with session defaults, reads, and receives pushes', async () => {
    const client = new ResolverClient({ url: h.server.url })
    const pushes: unknown[] = []
    const unsubscribe = await client.subscribe(['graph'], (data) => pushes.push(data))
    expect(await client.publish(await trustEvent(root, { subject: { type: 'p', value: alice.pk } }))).toMatchObject({ accepted: true })
    const second = await trustEvent(alice, { subject: { type: 'p', value: bob.pk } })
    expect((await client.publish(second)).accepted).toBe(true)
    await client.sessionUpdate({ rootPubkey: root.pk })
    const batch = await client.trustBatch({ items: [{ key: 'bob', subject: { type: 'p', value: bob.pk } }] })
    expect(batch.results.bob).toMatchObject({ connected: true, degree: 2 })
    const info = await client.info()
    expect(info.instanceId).toBe(h.server.instanceId)
    expect((await client.req([{ ids: [second.id] }])).map((e) => e.id)).toEqual([second.id])
    await expect(client.graphField({ rootPubkey: root.pk })).rejects.toMatchObject({ code: 'unsupported' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(pushes.length).toBeGreaterThan(0)
    await unsubscribe()
    client.close()
  })

  it('answers the server AUTH challenge through the signer when reads need members', async () => {
    const guarded = await startServer()
    const member = actor()
    guarded.server.repo.setSetting('auth.reads', 'members')
    guarded.server.membership.allow(member.pk, ['read'])
    const client = new ResolverClient({
      url: guarded.server.url,
      signer: {
        getPublicKey: async () => member.pk,
        signEvent: async (template) => finalizeEvent(template, member.sk),
      },
    })
    const info = await client.info()
    expect(info.api).toBe('v1')
    client.close()
    const anonymous = new ResolverClient({ url: guarded.server.url })
    await expect(anonymous.info()).rejects.toMatchObject({ code: 'auth-required' })
    anonymous.close()
    await guarded.close()
  })
})
