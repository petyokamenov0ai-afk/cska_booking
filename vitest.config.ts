import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit / integration tests only (node environment). Playwright owns the
 * browser journey in `e2e/` — kept out of `include` on purpose.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    // The integration fixture shares the app's database; drop it after the run
    // so test geometry never shows up as real inventory.
    globalSetup: ['tests/helpers/globalTeardown.ts'],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests hit one shared Postgres; don't let files race.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts', 'app/api/**/*.ts', 'scripts/pipeline/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
