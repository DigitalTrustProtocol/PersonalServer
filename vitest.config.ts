import { defineConfig } from 'vitest/config'

// @dtp/* resolve to the built TrustGraph packages (file: links), exactly as at runtime.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
