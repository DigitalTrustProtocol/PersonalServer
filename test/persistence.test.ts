import { rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools'
import { NOW, TestClient, actor, claimEvent, ratingEvent, startServer, tempDir, trustEvent } from './helpers.js'

describe('restart', () => {
  it('reloads winners, claims, and floors from SQLite into the heap', async () => {
    const dataDir = tempDir()
    const root = actor()
    const alice = actor()
    const bob = actor()
    const post = { type: 'i' as const, value: 'post:id:77' }
    const deleted = await trustEvent(root, { subject: { type: 'p', value: bob.pk }, createdAt: NOW - 90 })

    const first = await startServer({ dataDir })
    const c1 = await TestClient.connect(first.server.url)
    for (const event of [
      await trustEvent(root, { subject: { type: 'p', value: alice.pk } }),
      await trustEvent(alice, { subject: post, context: '', value: '-1' }),
      await ratingEvent(alice, { subject: post, score: '12.5' }),
      claimEvent(alice, '42', 'alice'),
      deleted,
    ]) {
      expect((await c1.publish(event)).ok).toBe(true)
    }
    const deletion = finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: [['e', deleted.id]] }, root.sk)
    expect((await c1.publish(deletion)).ok).toBe(true)
    const before = await c1.dtp('trust.query', { rootPubkey: root.pk, subject: post })
    c1.close()
    await first.close()

    const second = await startServer({ dataDir })
    expect(second.server.instanceId).not.toBe(first.server.instanceId)
    expect(second.server.graph.graphVersion).toBe(1)
    const c2 = await TestClient.connect(second.server.url)
    const after = await c2.dtp('trust.query', { rootPubkey: root.pk, subject: post })
    expect({ ...after, graphVersion: 0, computedAt: 0 }).toEqual({ ...before, graphVersion: 0, computedAt: 0 })
    expect(await c2.dtp('rating.query', { rootPubkey: root.pk, subject: post })).toMatchObject({ averageScore: 12.5 })
    expect((await c2.dtp('identity.claims', { twitterId: '42' })).claims).toHaveLength(1)
    expect(await c2.publish(deleted)).toEqual({ ok: false, message: 'blocked: deleted' })
    expect(second.server.graph.stats()).toMatchObject({ edges: { '32009': 2, '32014': 1 }, claims: 1, deleteFloors: 1 })
    c2.close()
    await second.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('heap guardrail', () => {
  it('refuses new slots past the heap edge limit but still accepts replacements', async () => {
    const dataDir = tempDir()
    const seed = await startServer({ dataDir })
    seed.server.repo.setSetting('memory', { maxHeapEdges: 1 })
    await seed.close()
    const h = await startServer({ dataDir })
    const c = await TestClient.connect(h.server.url)
    const a = actor()
    const target = actor()
    expect((await c.publish(await trustEvent(a, { subject: { type: 'p', value: target.pk }, createdAt: NOW - 10 }))).ok).toBe(true)
    const extra = await c.publish(await trustEvent(a, { subject: { type: 'p', value: actor().pk } }))
    expect(extra).toMatchObject({ ok: false, message: 'rate-limited: heap edge limit reached' })
    const replacement = await c.publish(await trustEvent(a, { subject: { type: 'p', value: target.pk }, value: '0', createdAt: NOW - 5 }))
    expect(replacement.ok).toBe(true)
    c.close()
    await h.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
})
