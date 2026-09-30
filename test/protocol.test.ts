import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent, nip19 } from 'nostr-tools'
import { NOW, TestClient, actor, claimEvent, ratingEvent, startServer, trustEvent, type Harness } from './helpers.js'

const root = actor()
const alice = actor()
const bob = actor()
const carol = actor()
const X = { type: 'i' as const, value: 'user:id:11348282' }
const POST = { type: 'i' as const, value: 'post:id:2080659774136291424' }

let h: Harness
let client: TestClient

beforeAll(async () => {
  h = await startServer()
  client = await TestClient.connect(h.server.url)
})

afterAll(async () => {
  client.close()
  await h.close()
})

describe('connection', () => {
  it('sends an AUTH challenge on connect', () => {
    expect(client.challenge).toMatch(/^[0-9a-f]{32}$/)
  })

  it('answers malformed frames with NOTICE', async () => {
    client.ws.send('not json')
    expect((await client.next((f) => f[0] === 'NOTICE'))[1]).toMatch(/^invalid:/)
    client.send(['BOGUS'])
    expect((await client.next((f) => f[0] === 'NOTICE'))[1]).toMatch(/^unsupported:/)
  })
})

describe('EVENT ingest', () => {
  it('accepts, deduplicates, and discards older events with NIP-01 prefixes', async () => {
    const first = await trustEvent(root, { subject: { type: 'p', value: alice.pk }, createdAt: NOW - 50 })
    expect(await client.publish(first)).toEqual({ ok: true, message: '' })
    expect(await client.publish(first)).toEqual({ ok: true, message: 'duplicate: already have this event' })
    const older = await trustEvent(root, { subject: { type: 'p', value: alice.pk }, value: '-1', createdAt: NOW - 60 })
    expect(await client.publish(older)).toEqual({ ok: true, message: 'duplicate: older than the stored winner' })
  })

  it('rejects forged events as invalid and ineligible scopes or kinds as blocked', async () => {
    const good = await trustEvent(carol, { subject: { type: 'p', value: bob.pk } })
    const forged = await client.publish({ ...good, sig: 'ab'.repeat(64) })
    expect(forged.ok).toBe(false)
    expect(forged.message).toMatch(/^invalid:/)
    const scoped = await client.publish(await trustEvent(carol, { subject: X, scopes: ['example.com'] }))
    expect(scoped.ok).toBe(false)
    expect(scoped.message).toMatch(/^blocked:/)
    const note = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: 'hi' }, carol.sk)
    expect((await client.publish(note)).message).toMatch(/^blocked: kind 1/)
    const rating = await client.publish(await ratingEvent(carol, { subject: POST, scopes: [] }))
    expect(rating.message).toMatch(/^blocked:/)
  })
})

describe('resolver operations', () => {
  beforeAll(async () => {
    for (const event of [
      await trustEvent(alice, { subject: { type: 'p', value: bob.pk }, createdAt: NOW - 40 }),
      await trustEvent(bob, { subject: X, scopes: ['x.com'], createdAt: NOW - 30 }),
      await trustEvent(alice, { subject: POST, context: '', value: '-1', createdAt: NOW - 20 }),
      await ratingEvent(alice, { subject: POST, score: '40', createdAt: NOW - 10 }),
      await ratingEvent(root, { subject: { type: 'i', value: 'post:id:5' }, score: '90', createdAt: NOW - 10 }),
    ]) {
      expect((await client.publish(event)).ok).toBe(true)
    }
  })

  it('trust.query walks the heap and reports statements and coverage', async () => {
    const result = await client.dtp('trust.query', { rootPubkey: root.pk, subject: { type: 'p', value: bob.pk } })
    expect(result).toMatchObject({
      connected: true,
      degree: 2,
      trust: 1,
      distrust: 0,
      resolution: 'trusted',
      coverage: 'complete',
      context: 'identity',
    })
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0]).toMatchObject({ author: alice.pk, value: 1, distance: 1 })
    expect(typeof result.graphVersion).toBe('number')
  })

  it('answers user:id results with binding provenance, complete coverage', async () => {
    const result = await client.dtp('trust.query', { rootPubkey: root.pk, subject: X, format: 'path' })
    expect(result).toMatchObject({
      connected: true,
      degree: 3,
      coverage: 'complete',
      binding: { mode: 'lenient', source: 'none', confirmed: false },
    })
    expect(result.coverageReasons).toBeUndefined()
    expect(result.pathView.nodes.every((n: { subject?: unknown }) => n.subject)).toBe(true)
  })

  it('session.update defaults let a batch send only subjects', async () => {
    const defaults = await client.dtp('session.update', {
      defaults: { rootPubkey: root.pk, followTrustThreshold: 75, followTrustRed: 25, bounds: { maxDepth: 4 }, statementLimit: 1 },
    })
    expect(defaults.defaults.rootPubkey).toBe(root.pk)
    const batch = await client.dtp('trust.batch', {
      items: [
        { key: 'bob', subject: { type: 'p', value: bob.pk } },
        { key: 'post', subject: POST },
        { key: 'bad', subject: { type: 'x', value: '1' } },
      ],
    })
    expect(batch.results.bob).toMatchObject({ connected: true, degree: 2 })
    expect(batch.results.post).toMatchObject({ connected: true, distrust: 1, resolution: 'distrusted' })
    expect(batch.errors.bad).toMatch(/^invalid:/)
    const limited = await client.dtp('trust.batch', {
      items: [{ key: 'x', subject: X }],
      statementLimit: 1,
    })
    expect(limited.results.x.statements.length).toBeLessThanOrEqual(1)
  })

  it('rejects oversized batches and duplicate keys', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, subject: POST }))
    await expect(client.dtp('trust.batch', { items })).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      client.dtp('trust.batch', { items: [{ key: 'a', subject: POST }, { key: 'a', subject: POST }] }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rating.query and rating.batch use hop threshold 1 and exact context', async () => {
    const rating = await client.dtp('rating.query', { rootPubkey: root.pk, subject: POST })
    expect(rating).toMatchObject({ degree: 2, claimCount: 1, averageScore: 40 })
    const batch = await client.dtp('rating.batch', {
      items: [
        { key: 'a', subject: POST },
        { key: 'own', subject: { type: 'i', value: 'post:id:5' } },
      ],
    })
    expect(batch.results.own).toMatchObject({ degree: 1, averageScore: 90 })
    expect(batch.results.own.own.author).toBe(root.pk)
  })

  it('lookups page with keyset cursors and count exactly', async () => {
    const incoming = await client.dtp('lookup.incoming', { keys: [`p:${bob.pk}`], context: 'identity', withTotals: true })
    expect(incoming.items.map((i: { author: string }) => i.author)).toEqual([alice.pk])
    expect(incoming.totals).toEqual({ trust: 1, neutral: 0, distrust: 0, ratings: 0 })
    const outgoing = await client.dtp('lookup.outgoing', { keys: [`p:${alice.pk}`], kinds: [32009, 32014], contextMatch: 'any', limit: 2 })
    expect(outgoing.items).toHaveLength(2)
    expect(outgoing.nextCursor).toBeTypeOf('string')
    const rest = await client.dtp('lookup.outgoing', {
      keys: [`p:${alice.pk}`],
      kinds: [32009, 32014],
      contextMatch: 'any',
      limit: 2,
      cursor: outgoing.nextCursor,
    })
    expect(rest.items).toHaveLength(1)
    expect(rest.nextCursor).toBeUndefined()
    const counts = await client.dtp('lookup.counts', {
      keys: [`p:${alice.pk}`],
      direction: 'outgoing',
      kinds: [32009, 32014],
      contextMatch: 'any',
    })
    expect(counts.counts[`p:${alice.pk}`]).toEqual({ trust: 1, neutral: 0, distrust: 1, ratings: 1 })
    const batch = await client.dtp('lookup.batch', {
      queries: [
        { id: 'in', op: 'incoming', params: { keys: [`i:${POST.value}`], kinds: [32014] } },
        { id: 'bad', op: 'incoming', params: { keys: [] } },
      ],
    })
    expect(batch.results.in.items[0]).toMatchObject({ kind: 32014, score: 40, author: alice.pk })
    expect(batch.errors.bad).toMatch(/^invalid:/)
    await expect(client.dtp('lookup.incoming', { keys: ['nope'] })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('graph.neighborhood and graph.frontier', async () => {
    const hood = await client.dtp('graph.neighborhood', { centerId: `p:${alice.pk}`, direction: 'out', context: 'identity' })
    expect(hood.nodes.some((n: { subject: { value: string } }) => n.subject.value === bob.pk)).toBe(true)
    expect(hood.truncated).toBe(false)
    const frontier = await client.dtp('graph.frontier', { roots: [root.pk], maxDepth: 3 })
    expect(frontier.authors.map((a: { pubkey: string }) => a.pubkey)).toEqual([root.pk, alice.pk, bob.pk])
    expect(frontier.authors[2]).toMatchObject({ depth: 2, via: alice.pk })
  })

  it('identity.claims lists 10011 claimants', async () => {
    expect((await client.publish(claimEvent(carol, '11348282', 'nasa'))).ok).toBe(true)
    const claims = await client.dtp('identity.claims', { twitterId: '11348282' })
    expect(claims.claims).toEqual([{ pubkey: carol.pk, eventId: expect.any(String) }])
    await expect(client.dtp('identity.claims', { twitterId: 'abc' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('answers graph.field with the level structure, unknown ops with invalid', async () => {
    const field = await client.dtp('graph.field', { rootPubkey: root.pk })
    expect(field).toMatchObject({ completeDepth: 3, levels: [[root.pk], [alice.pk], [bob.pk], []], binds: [] })
    expect(typeof field.graphVersion).toBe('number')
    await expect(client.dtp('graph.field', { rootPubkey: root.pk, hopContext: 'security' })).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(client.dtp('no.such.op')).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      client.dtp('trust.query', { rootPubkey: root.pk, subject: POST, hopContext: 'security' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('info returns the dtp object with graphVersion', async () => {
    const info = await client.dtp('info')
    expect(info).toMatchObject({ api: 'v1', model: 'dtp-wot/1', instanceId: h.server.instanceId, gaps: ['G5'] })
    expect(info.capabilities).toContain('graph.field')
    expect(info.unsupported).toBeUndefined()
    expect(info.graphVersion).toBeGreaterThan(1)
  })
})

describe('identity binding and walk budgets', () => {
  // Root trusts Alice; Alice's x.com statement about X hints Dave (a witness
  // and a hop); Dave trusts Erin. Lenient binds X = Dave; strict needs Dave's 10011.
  const bindRoot = actor()
  const witness = actor()
  const dave = actor()
  const erin = actor()
  const BOUND = { type: 'i' as const, value: 'user:id:777' }
  let b: Harness
  let c: TestClient

  beforeAll(async () => {
    b = await startServer()
    c = await TestClient.connect(b.server.url)
    for (const event of [
      await trustEvent(bindRoot, { subject: { type: 'p', value: witness.pk } }),
      await trustEvent(witness, {
        subject: BOUND,
        scopes: ['x.com'],
        subjectHints: [{ kind: 'npub', npub: nip19.npubEncode(dave.pk) }],
      }),
      await trustEvent(dave, { subject: { type: 'p', value: erin.pk } }),
    ]) {
      expect((await c.publish(event)).ok).toBe(true)
    }
  })

  afterAll(async () => {
    c.close()
    await b.close()
  })

  it('binds through a witness in lenient mode (the default) and not in strict mode without a claim', async () => {
    const lenient = await c.dtp('trust.query', { rootPubkey: bindRoot.pk, subject: { type: 'p', value: erin.pk } })
    expect(lenient).toMatchObject({ connected: true, degree: 3 })
    const strict = await c.dtp('trust.query', {
      rootPubkey: bindRoot.pk,
      subject: { type: 'p', value: erin.pk },
      bindingMode: 'strict',
    })
    expect(strict.connected).toBe(false)
    const provenance = await c.dtp('trust.query', { rootPubkey: bindRoot.pk, subject: BOUND })
    expect(provenance.binding).toMatchObject({ mode: 'lenient', pubkey: dave.pk, source: 'witness', witnessDegree: 2, confirmed: false })
  })

  it('binds in strict mode once the pubkey claims the X account', async () => {
    expect((await c.publish(claimEvent(dave, '777'))).ok).toBe(true)
    const strict = await c.dtp('trust.query', {
      rootPubkey: bindRoot.pk,
      subject: { type: 'p', value: erin.pk },
      bindingMode: 'strict',
    })
    expect(strict).toMatchObject({ connected: true, degree: 3 })
    const field = await c.dtp('graph.field', { rootPubkey: bindRoot.pk, bindingMode: 'strict' })
    expect(field.binds).toEqual([{ subject: 'i:user:id:777', pubkey: dave.pk, source: 'witness', level: 1, witnessEventId: expect.any(String) }])
  })

  it('stops a walk on the node budget and reports completeDepth', async () => {
    Object.assign(b.server.guardrails, { maxReachedNodes: 2 })
    try {
      const result = await c.dtp('trust.query', { rootPubkey: bindRoot.pk, subject: { type: 'p', value: erin.pk } })
      expect(result).toMatchObject({ connected: false, truncated: true, truncatedReasons: ['nodeBudget'], completeDepth: 1 })
    } finally {
      Object.assign(b.server.guardrails, { maxReachedNodes: 5_000_000 })
    }
  })
})

describe('REQ (limited reads)', () => {
  it('reads by ids and by authors + kinds; refuses other filters', async () => {
    const event = await trustEvent(carol, { subject: { type: 'p', value: alice.pk }, createdAt: NOW - 5 })
    await client.publish(event)
    const byId = await client.req({ ids: [event.id] })
    expect(byId.events).toEqual([JSON.parse(JSON.stringify(event))])
    const byAuthor = await client.req({ authors: [carol.pk], kinds: [32009, 10011] })
    expect(byAuthor.events.map((e) => e.kind).sort()).toEqual([10011, 32009])
    const other = await client.req({ '#p': [alice.pk] })
    expect(other.closed).toMatch(/^unsupported:/)
    const tooMany = await client.req({ authors: Array.from({ length: 21 }, () => carol.pk), kinds: [32009] })
    expect(tooMany.closed).toMatch(/^invalid:/)
  })

  it('serves the NIP-43 membership list and role definitions signed by self', async () => {
    const { events } = await client.req({ kinds: [13534, 33534] })
    expect(events.map((e) => e.kind).sort()).toEqual([13534, 33534, 33534, 33534])
    expect(events.every((e) => e.pubkey === h.server.key.pubkey)).toBe(true)
  })
})

describe('NIP-09 deletions', () => {
  it('removes the winner, sets a floor, and refuses the deleted event afterwards', async () => {
    const dave = actor()
    const target = await trustEvent(dave, { subject: { type: 'p', value: carol.pk }, createdAt: NOW - 30 })
    await client.publish(target)
    const before = await client.dtp('trust.query', { rootPubkey: dave.pk, subject: { type: 'p', value: carol.pk } })
    expect(before.connected).toBe(true)
    const foreign = finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: [['e', target.id]] }, carol.sk)
    expect(await client.publish(foreign)).toMatchObject({ ok: false, message: expect.stringMatching(/^blocked:/) })
    const deletion = finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: [['e', target.id], ['k', '32009']] }, dave.sk)
    expect(await client.publish(deletion)).toEqual({ ok: true, message: '' })
    const after = await client.dtp('trust.query', { rootPubkey: dave.pk, subject: { type: 'p', value: carol.pk } })
    expect(after.connected).toBe(false)
    expect(await client.publish(target)).toEqual({ ok: false, message: 'blocked: deleted' })
    expect((await client.req({ ids: [target.id] })).events).toEqual([])
    const newer = await trustEvent(dave, { subject: { type: 'p', value: carol.pk }, value: '-1', createdAt: NOW - 29 })
    expect((await client.publish(newer)).ok).toBe(true)
  })

  it('an a-tag deletion clears the slot up to its time', async () => {
    const erin = actor()
    const target = await trustEvent(erin, { subject: { type: 'p', value: carol.pk }, createdAt: NOW - 30 })
    await client.publish(target)
    const d = target.tags.find((t) => t[0] === 'd')![1]
    const deletion = finalizeEvent({ kind: 5, created_at: NOW - 20, content: '', tags: [['a', `32009:${erin.pk}:${d}`]] }, erin.sk)
    expect((await client.publish(deletion)).ok).toBe(true)
    const older = await trustEvent(erin, { subject: { type: 'p', value: carol.pk }, createdAt: NOW - 25 })
    expect(await client.publish(older)).toEqual({ ok: false, message: 'blocked: deleted' })
  })
})

describe('graph pushes', () => {
  it('pushes graphVersion and changed subjects to subscribers', async () => {
    const listener = await TestClient.connect(h.server.url)
    expect(await listener.dtp('subscribe', { topics: ['graph'] })).toEqual({ topics: ['graph'] })
    await expect(listener.dtp('subscribe', { topics: ['nope'] })).rejects.toMatchObject({ code: 'invalid' })
    const frank = actor()
    await client.publish(await trustEvent(frank, { subject: { type: 'p', value: root.pk } }))
    const push = await listener.next(
      (f) =>
        f[0] === 'DTP-PUSH' &&
        f[1] === 'graph' &&
        ((f[2] as { changed?: { subjects?: string[] } }).changed?.subjects ?? []).includes(`p:${frank.pk}`),
    )
    const data = push[2] as { graphVersion: number; changed?: { subjects: string[] } }
    expect(typeof data.graphVersion).toBe('number')
    expect(data.changed?.subjects).toEqual(expect.arrayContaining([`p:${root.pk}`, `p:${frank.pk}`]))
    listener.close()
  })
})

describe('in-flight guardrail', () => {
  it('answers busy past maxInFlight instead of queueing', async () => {
    const busy = await startServer({ setup: (server) => Object.assign(server.guardrails, { maxInFlight: 1 }) })
    // Without permessage-deflate the server parses pipelined frames in one tick.
    const c = await TestClient.connect(busy.server.url, {}, { perMessageDeflate: false })
    const items = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, subject: POST }))
    for (let i = 0; i < 8; i += 1) c.send(['DTP', `b${i}`, 'trust.batch', { rootPubkey: root.pk, items }])
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => c.next((f) => (f[0] === 'DTP-OK' || f[0] === 'DTP-ERR') && f[1] === `b${i}`)),
    )
    expect(answers.some((f) => f[0] === 'DTP-ERR' && f[2] === 'busy')).toBe(true)
    expect(answers.some((f) => f[0] === 'DTP-OK')).toBe(true)
    c.close()
    await busy.close()
  })
})
