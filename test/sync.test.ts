import { describe, expect, it } from 'vitest'
import { NOW, TestClient, actor, claimEvent, ratingEvent, startServer, trustEvent } from './helpers.js'
import { FakeRelay } from './fake-relay.js'

async function eventually<T>(fn: () => Promise<T> | T, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() > until) throw new Error(`condition not met: ${JSON.stringify(value).slice(0, 300)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('relay sync (continuous frontier)', () => {
  it('pulls the root frontier from a relay, fetches claims, and follows live events', async () => {
    const relay = await FakeRelay.start()
    const root = actor()
    const alice = actor()
    const bob = actor()
    const carol = actor()
    const post = { type: 'i' as const, value: 'post:id:31' }
    relay.publish(await trustEvent(root, { subject: { type: 'p', value: alice.pk }, createdAt: NOW - 500 }))
    relay.publish(await trustEvent(alice, { subject: { type: 'p', value: bob.pk }, createdAt: NOW - 400 }))
    relay.publish(await ratingEvent(bob, { subject: post, score: '70', createdAt: NOW - 300 }))
    relay.publish(claimEvent(bob, '999', 'bob'))
    // Outside the frontier: never fetched by author.
    relay.publish(await trustEvent(carol, { subject: { type: 'p', value: bob.pk }, value: '-1', createdAt: NOW - 200 }))

    const h = await startServer({
      setup: (server) => {
        server.repo.setSetting('relays', [relay.url])
        server.repo.addConfiguredRoot(root.pk)
        server.sync.kick()
      },
    })
    const client = await TestClient.connect(h.server.url)
    const subscribed = await client.dtp('subscribe', { topics: ['coverage'] })
    expect(subscribed.topics).toEqual(['coverage'])

    const rating = await eventually(
      () => client.dtp('rating.query', { rootPubkey: root.pk, subject: post }),
      (r) => r.claimCount === 1,
    )
    expect(rating).toMatchObject({ degree: 3, averageScore: 70 })
    const bobTrust = await client.dtp('trust.query', { rootPubkey: root.pk, subject: { type: 'p', value: bob.pk } })
    expect(bobTrust).toMatchObject({ connected: true, degree: 2, distrust: 0 })
    await eventually(
      () => client.dtp('identity.claims', { twitterId: '999' }),
      (r) => r.claims.length === 1,
    )
    expect(relay.requests.some((f) => Array.isArray(f.kinds) && (f.kinds as number[]).includes(10011))).toBe(true)
    expect(relay.requests.some((f) => Array.isArray(f.authors) && (f.authors as string[]).includes(carol.pk))).toBe(false)

    const coverage = await client.next((f) => f[0] === 'DTP-PUSH' && f[1] === 'coverage')
    expect(coverage[2]).toMatchObject({ rootPubkey: root.pk, coverage: 'complete' })
    const warm = await client.dtp('trust.query', { rootPubkey: root.pk, subject: { type: 'p', value: alice.pk } })
    expect(warm.coverage).toBe('complete')

    // A live event from a frontier author arrives without another pass.
    const later = await trustEvent(bob, { subject: { type: 'p', value: carol.pk }, createdAt: NOW - 10 })
    relay.publish(later)
    const carolTrust = await eventually(
      () => client.dtp('trust.query', { rootPubkey: root.pk, subject: { type: 'p', value: carol.pk } }),
      (r) => r.connected === true,
    )
    expect(carolTrust.degree).toBe(3)

    const snapshot = h.server.snapshot()
    expect(snapshot.sources.relays).toEqual([expect.objectContaining({ url: relay.url })])
    expect(snapshot.sources.frontier?.size).toBeGreaterThanOrEqual(3)
    client.close()
    await h.close()
    await relay.close()
  })

  it('reports root-warming until the first pass completes', async () => {
    const root = actor()
    const h = await startServer({
      setup: (server) => {
        // A relay that never answers keeps the root warming.
        server.repo.setSetting('relays', ['ws://127.0.0.1:9/'])
        server.repo.addConfiguredRoot(root.pk)
      },
    })
    const client = await TestClient.connect(h.server.url)
    const result = await client.dtp('trust.query', { rootPubkey: root.pk, subject: { type: 'p', value: actor().pk } })
    expect(result).toMatchObject({ coverage: 'partial', coverageReasons: ['root-warming'] })
    client.close()
    await h.close()
  })
})
