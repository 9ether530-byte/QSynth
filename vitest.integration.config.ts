import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a *deployed* API and a live database. They are kept
 * out of the default `npm test` run deliberately: a unit suite that silently depends
 * on deployed infrastructure is a unit suite that fails for reasons unrelated to the
 * change under test.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Isolation and authz assertions share fixture organizations; running files in
    // parallel would interleave rate-limit windows and audit-log expectations.
    fileParallelism: false,
  },
});
