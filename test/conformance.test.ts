/**
 * The shared corpus gate (TrustGraph conformance.md § Runners and CI): the
 * same runner as TrustGraph, against the @dtp packages this server bundles.
 */

import { describe, expect, it } from 'vitest'
import { isProtocolCase, loadCorpus, runModelCase, runProtocolEntry } from '@dtp/conformance'

const entries = loadCorpus()

describe('dtp-wot/1 corpus against the bundled packages', () => {
  it('loads a real corpus', () => {
    expect(entries.length).toBeGreaterThan(50)
  })

  for (const { file, testCase } of entries) {
    it(`${file} › ${testCase.id}`, async () => {
      if (isProtocolCase(testCase)) {
        expect(await runProtocolEntry(testCase)).toEqual([])
        return
      }
      const failures = runModelCase(testCase).filter((o) => o.errors.length > 0)
      expect(failures.map((o) => `${o.label}: ${o.errors.join('; ')}`)).toEqual([])
    })
  }
})
