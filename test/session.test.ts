/**
 * The one-API session suite (TrustGraph conformance.md § One API): every
 * scripted session in TrustGraph/corpus/sessions runs against a fresh server
 * started with the session's configuration.
 */

import { describe, expect, it } from 'vitest'
import { loadSessions, runSession } from '@dtp/conformance'
import { startServer } from './helpers.js'

const sessions = loadSessions()

describe('session suite against the Personal Server', () => {
  it('has sessions to run', () => {
    expect(sessions.length).toBeGreaterThan(0)
  })

  for (const { file, session } of sessions) {
    it(`${file} › ${session.id}`, async () => {
      const h = await startServer({
        setup: (server) => {
          for (const key of ['auth.reads', 'auth.writes'] as const) {
            const value = session.config[key]
            if (value === 'open' || value === 'members') server.repo.setSetting(key, value)
          }
          // `limits.<guardrail>` entries (for example limits.maxReachedNodes) set the walk budgets.
          for (const [key, value] of Object.entries(session.config)) {
            const name = key.startsWith('limits.') ? key.slice('limits.'.length) : undefined
            if (name === undefined) continue
            if (!(name in server.guardrails) || typeof value !== 'number') throw new Error(`unknown session limit ${key}`)
            ;(server.guardrails as unknown as Record<string, number>)[name] = value
          }
        },
      })
      try {
        const outcomes = await runSession(h.server.url, session)
        const failures = outcomes.filter((o) => o.errors.length > 0)
        expect(failures.map((o) => `step ${o.step}${o.note ? ` (${o.note})` : ''}: ${o.errors.join('; ')}`)).toEqual([])
        // This server implements every operation and closes the gaps the sessions gate on.
        expect(outcomes.filter((o) => o.skipped || o.otherwise).map((o) => o.step)).toEqual([])
        expect(outcomes).toHaveLength(session.steps.length)
      } finally {
        await h.close()
      }
    })
  }
})
