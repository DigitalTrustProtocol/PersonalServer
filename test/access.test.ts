import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools'
import { NOW, TestClient, actor, startServer, trustEvent, type Harness } from './helpers.js'

let h: Harness

beforeAll(async () => {
  h = await startServer()
})

afterAll(async () => {
  await h.close()
})

function rawHttp(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: options.path ?? '/', method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('HTTP: NIP-11 and health', () => {
  it('serves the NIP-11 document on GET / with Accept application/nostr+json', async () => {
    const res = await rawHttp(h.server.port, { headers: { Accept: 'application/nostr+json' } })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    const doc = JSON.parse(res.body)
    expect(doc).toMatchObject({
      self: h.server.key.pubkey,
      supported_nips: [1, 9, 11, 42, 43, 86],
      limitation: { auth_required: false, restricted_writes: false, max_message_length: 4 * 1024 * 1024 },
      dtp: { api: 'v1', model: 'dtp-wot/1', corpus: 'dtp-wot-corpus/1', scopeProfile: 'x.com', gaps: ['G5'] },
    })
    expect(doc.dtp.capabilities).toEqual(expect.arrayContaining(['lookup.batch', 'graph.field']))
    expect(doc.dtp.unsupported).toBeUndefined()
    expect(doc.dtp.limits).toMatchObject({ operationDeadline: 500, maxBatchItems: 200, maxLookupKeys: 50, maxInFlight: 32 })
  })

  it('answers /healthz and /readyz', async () => {
    expect((await rawHttp(h.server.port, { path: '/healthz' })).status).toBe(200)
    const ready = await rawHttp(h.server.port, { path: '/readyz' })
    expect(ready.status).toBe(200)
    expect(JSON.parse(ready.body)).toMatchObject({ ready: true })
  })
})

describe('Host and Origin guards', () => {
  it('refuses unknown Host values on HTTP and on upgrade (DNS rebinding)', async () => {
    const res = await rawHttp(h.server.port, { path: '/healthz', headers: { Host: 'evil.example:80' } })
    expect(res.status).toBe(421)
    await expect(TestClient.connect(h.server.url, { Host: 'evil.example' })).rejects.toThrow(/421/)
    const local = await TestClient.connect(`ws://localhost:${h.server.port}/`)
    local.close()
  })

  it('refuses web origins that are not allowed; allows extensions and clients without Origin', async () => {
    await expect(TestClient.connect(h.server.url, { Origin: 'https://evil.example' })).rejects.toThrow(/403/)
    const ext = await TestClient.connect(h.server.url, { Origin: 'chrome-extension://abcdefghijklmnop' })
    ext.close()
    const native = await TestClient.connect(h.server.url)
    native.close()
  })
})

describe('NIP-42 with auth.writes / auth.reads = members', () => {
  it('requires authentication and the right role', async () => {
    const guarded = await startServer()
    guarded.server.repo.setSetting('auth.writes', 'members')
    const writer = actor()
    const c = await TestClient.connect(guarded.server.url)
    const event = await trustEvent(writer, { subject: { type: 'p', value: actor().pk } })
    expect(await c.publish(event)).toMatchObject({ ok: false, message: expect.stringMatching(/^auth-required:/) })

    const auth = (challenge: string, relay = guarded.server.url) =>
      finalizeEvent(
        { kind: 22242, created_at: NOW, content: '', tags: [['relay', relay], ['challenge', challenge]] },
        writer.sk,
      )
    const wrong = auth('not-the-challenge')
    c.send(['AUTH', wrong])
    expect((await c.next((f) => f[0] === 'OK' && f[1] === wrong.id))[2]).toBe(false)
    const badRelay = auth(c.challenge, 'wss://elsewhere.example/')
    c.send(['AUTH', badRelay])
    expect((await c.next((f) => f[0] === 'OK' && f[1] === badRelay.id))[3]).toMatch(/relay/)
    const good = auth(c.challenge)
    c.send(['AUTH', good])
    expect(await c.next((f) => f[0] === 'OK' && f[1] === good.id)).toEqual(['OK', good.id, true, ''])

    expect(await c.publish(event)).toMatchObject({ ok: false, message: expect.stringMatching(/^restricted:/) })
    guarded.server.membership.allow(writer.pk, ['write'])
    expect(await c.publish(event)).toEqual({ ok: true, message: '' })
    expect(guarded.server.membership.listEvent().tags).toContainEqual(['member', writer.pk, 'write'])

    guarded.server.repo.setSetting('auth.reads', 'members')
    const anonymous = await TestClient.connect(guarded.server.url)
    await expect(anonymous.dtp('info')).rejects.toMatchObject({ code: 'auth-required' })
    expect((await anonymous.req({ ids: [event.id] })).closed).toMatch(/^auth-required:/)
    await expect(c.dtp('info')).rejects.toMatchObject({ code: 'restricted' })
    guarded.server.membership.assign(writer.pk, 'read')
    expect((await c.dtp('info')).api).toBe('v1')
    const nip11 = JSON.parse((await rawHttp(guarded.server.port, { headers: { Accept: 'application/nostr+json' } })).body)
    expect(nip11.limitation).toMatchObject({ auth_required: true, restricted_writes: true })
    anonymous.close()
    c.close()
    await guarded.close()
  })
})

describe('NIP-86 management with NIP-98', () => {
  it('lets an admin manage members and refuses everyone else', async () => {
    const admin = actor()
    const stranger = actor()
    const member = actor()
    h.server.repo.setSetting('auth.admins', [admin.pk])
    const url = `http://127.0.0.1:${h.server.port}/`
    const call = async (who: typeof admin, method: string, params: unknown[]) => {
      const body = JSON.stringify({ method, params })
      const auth = finalizeEvent(
        {
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          content: '',
          tags: [
            ['u', url],
            ['method', 'POST'],
            ['payload', createHash('sha256').update(body).digest('hex')],
          ],
        },
        who.sk,
      )
      const res = await rawHttp(h.server.port, {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/nostr+json+rpc',
          Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
        },
      })
      return { status: res.status, body: JSON.parse(res.body) as { result?: unknown; error?: string } }
    }
    expect((await call(stranger, 'allowpubkey', [member.pk])).status).toBe(403)
    expect((await call(admin, 'supportedmethods', [])).body.result).toContain('allowpubkey')
    expect((await call(admin, 'allowpubkey', [member.pk])).body.result).toBe(true)
    expect((await call(admin, 'listallowedpubkeys', [])).body.result).toContainEqual({ pubkey: member.pk, reason: 'read,write' })
    expect((await call(admin, 'assignrole', [member.pk, 'admin'])).body.result).toBe(true)
    expect(h.server.membership.rolesOf(member.pk).has('admin')).toBe(true)
    expect((await call(admin, 'banpubkey', [member.pk])).body.result).toBe(true)
    expect(h.server.membership.isBanned(member.pk)).toBe(true)
    const writer = await TestClient.connect(h.server.url)
    const banned = await trustEvent(member, { subject: { type: 'p', value: actor().pk } })
    expect(await writer.publish(banned)).toMatchObject({ ok: false, message: expect.stringMatching(/^restricted:/) })
    writer.close()
    const unsigned = await rawHttp(h.server.port, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/nostr+json+rpc' },
    })
    expect(unsigned.status).toBe(401)
  })
})
