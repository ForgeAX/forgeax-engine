import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-modeling',
    environment: 'node',
    // Kernel tests run 4 to a shared pub runner; the 5 s default fails them under load.
    testTimeout: 30_000,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'examples/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.test.json' },
    coverage: {
      exclude: ['dist/**', '**/*.config.ts', 'src/__tests__/**', 'examples/**'],
      thresholds: { lines: 80, branches: 75, functions: 80 },
    },
  },
});
