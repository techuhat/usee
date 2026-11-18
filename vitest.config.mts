import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packagesDirectory = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources, so they never depend on a prior build.
    alias: [
      {
        find: /^@usee\/([a-z-]+)$/,
        replacement: `${packagesDirectory}$1/src/index.ts`,
      },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    // The native host integration tests launch Windows capture and encoder
    // processes; parallel workers make their startup timeout on small CPUs.
    maxWorkers: 1,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'apps/desktop/src/main/**/*.ts',
        'apps/desktop/src/preload/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
