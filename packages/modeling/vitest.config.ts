import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-modeling',
    environment: 'node',
    // A hang guard, not a speed budget (`perf-tiers` owns those). In a full gate run on the shared
    // pub runner about 60 tests take 17 to 30 s and the slowest unmarked ones reached 37 s, so 30 s
    // failed whichever test the load happened to push over.
    testTimeout: 60_000,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'examples/**/*.test.ts', 'scripts/quad-eval/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.test.json' },
    coverage: {
      exclude: ['dist/**', '**/*.config.ts', 'src/__tests__/**', 'examples/**'],
      thresholds: { lines: 80, branches: 75, functions: 80 },
    },
  },
});
