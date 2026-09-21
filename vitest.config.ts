import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@qsynth/core': fileURLToPath(new URL('./packages/qsynth-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Integration tests need a live DATABASE_URL and run under their own config.
    include: ['packages/**/test/**/*.test.ts', 'functions/*/test/**/*.test.ts'],
    environment: 'node',
    // Property-based and exhaustive-equivalence tests are CPU-bound, not IO-bound.
    testTimeout: 30_000,
  },
});
