import { describe, expect, it } from 'vitest'
import { DEFAULT_GUARDRAILS, defaultDataDir, localHostNames, originAllowed, parseBootstrap } from '../src/config.js'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { GraphManager } from '../src/graph/graph-manager.js'
import { VerifyPool } from '../src/ingest/verify-pool.js'
import { OpError } from '../src/protocol/errors.js'
import { runOperation, type OpContext } from '../src/protocol/ops.js'
import { parseDefaults, resolveQuery } from '../src/protocol/session.js'
import { Telemetry } from '../src/telemetry/telemetry.js'

function ctx(overrides: Partial<OpContext> = {}): OpContext {
  return {
    graph: new GraphManager(),
    guardrails: { ...DEFAULT_GUARDRAILS },
    session: {},
    subscriptions: new Set(),
    info: () => ({}),
    onActiveRoot: () => undefined,
    coverageReasons: () => [],
    deadlineAt: Date.now() + 500,
    isCancelled: () => false,
    guardrail: () => undefined,
    ...overrides,
  }
}

const ROOT = 'a'.repeat(64)

describe('config', () => {
  it('resolves the data directory per OS', () => {
    expect(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32')).toMatch(/DigitalTrust[\\/]PersonalServer$/)
    expect(defaultDataDir({ XDG_DATA_HOME: '/tmp/xdg' }, 'linux')).toMatch(/digitaltrust[\\/]personal-server$/)
    expect(defaultDataDir({ DTP_PERSONAL_DATA_DIR: '/data/ps' }, 'linux')).toMatch(/ps$/)
  })

  it('parses config.json defensively', () => {
    expect(parseBootstrap({ port: 4000, listen: 'lan', admin: {} })).toMatchObject({ port: 4000, listen: 'lan', admin: { port: 4001 } })
    expect(parseBootstrap({ port: 'x', listen: 'public' })).toMatchObject({ port: 3870, listen: 'local' })
  })

  it('matches Host names and Origin patterns', () => {
    expect(localHostNames(3870).has('localhost:3870')).toBe(true)
    expect(originAllowed(undefined, [])).toBe(true)
    expect(originAllowed('chrome-extension://abc', ['chrome-extension://*'])).toBe(true)
    expect(originAllowed('https://evil.example', ['chrome-extension://*'])).toBe(false)
    expect(originAllowed('null', ['chrome-extension://*'])).toBe(false)
  })
})

describe('session defaults and query fields', () => {
  it('validates defaults and merges them into queries with guardrail clamps', () => {
    expect(() => parseDefaults({ rootPubkey: 'nope' })).toThrow(OpError)
    expect(() => parseDefaults({ bounds: { maxDepth: 9 } })).toThrow(/maxDepth/)
    const session = parseDefaults({ rootPubkey: ROOT, bindingMode: 'strict', statementLimit: 900 })
    const resolved = resolveQuery({}, { type: 'p', value: ROOT }, 'trust', session, { ...DEFAULT_GUARDRAILS, maxDepth: 3 })
    expect(resolved.query).toMatchObject({ rootPubkey: ROOT, context: 'identity', bounds: { maxDepth: 3 } })
    expect(resolved.statementLimit).toBe(500)
    expect(resolved.bindingMode).toBe('strict')
    expect(resolveQuery({ rootPubkey: ROOT }, { type: 'i', value: 'post:id:1' }, 'rating', {}, DEFAULT_GUARDRAILS).query.context).toBe('')
    expect(() => resolveQuery({}, { type: 'p', value: ROOT }, 'trust', {}, DEFAULT_GUARDRAILS)).toThrow(/rootPubkey/)
  })
})

describe('operations', () => {
  it('cancels a batch between items', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ key: `k${i}`, subject: { type: 'p', value: ROOT } }))
    await expect(
      runOperation(ctx({ isCancelled: () => true }), 'trust.batch', { rootPubkey: ROOT, items }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('reports timeout for batch items past the batch deadline', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ key: `k${i}`, subject: { type: 'p', value: ROOT } }))
    const result = (await runOperation(ctx({ guardrails: { ...DEFAULT_GUARDRAILS, batchDeadline: -1 } }), 'trust.batch', {
      rootPubkey: ROOT,
      items,
    })) as { errors: Record<string, string> }
    expect(result.errors).toEqual({ k0: 'timeout', k1: 'timeout', k2: 'timeout' })
  })

  it('keeps subscriptions per connection', async () => {
    const c = ctx()
    await runOperation(c, 'subscribe', { topics: ['graph', 'coverage'] })
    expect(await runOperation(c, 'unsubscribe', { topics: ['coverage'] })).toEqual({ topics: ['graph'] })
  })
})

describe('signature worker pool', () => {
  it('verifies in worker threads and rejects forgeries', async () => {
    const pool = new VerifyPool(2)
    const sk = generateSecretKey()
    const event = finalizeEvent({ kind: 32009, created_at: 1, tags: [], content: '' }, sk)
    const results = await Promise.all([
      pool.verify(event),
      pool.verify({ ...event, sig: 'ab'.repeat(64) }),
      pool.verify({ ...event, content: 'tampered' }),
    ])
    expect(results).toEqual([true, false, false])
    await pool.close()
    await expect(pool.verify(event)).rejects.toThrow(/closed/)
  })
})

describe('telemetry', () => {
  it('computes latency percentiles and rates without identifiers', () => {
    const t = new Telemetry()
    for (let i = 1; i <= 100; i += 1) t.recordOperation('trust.query', 'ok', i / 1000)
    t.recordIngest(32009, 'accepted')
    t.recordIngest(32009, 'invalid', 'invalid')
    expect(t.ops.get('trust.query')).toMatchObject({ ok: 100 })
    expect(t.ingest['32009']).toMatchObject({ accepted: 1, invalid: 1 })
    expect(t.rejectsByPrefix).toEqual({ invalid: 1 })
  })
})
