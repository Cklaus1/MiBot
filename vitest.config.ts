import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // Per-test-file isolated DB (see test/setup.ts) — runs once per worker before imports.
    setupFiles: ['test/setup.ts'],
  },
});
