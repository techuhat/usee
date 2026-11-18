import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the built Electron app through its public UI and
 * bridge only (docs/testing.md). Run with `npm run test:e2e`, which builds first.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  // On GitHub, each failure also becomes an annotation, which anyone can read without signing in.
  reporter: process.env['CI'] === 'true' ? [['list'], ['github']] : [['list']],
  outputDir: '../../test-results/e2e',
});
