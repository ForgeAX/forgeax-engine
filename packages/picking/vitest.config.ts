import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineProject({
  resolve: {
    alias: [
      // Picking tests exercise owner-local render implementations directly.
      // Keep public render imports on that same source graph so ECS component
      // tokens are not duplicated by a separately bundled dist graph.
      {
        find: /^@forgeax\/engine-render$/,
        replacement: fileURLToPath(new URL('../render/src/index.ts', import.meta.url)),
      },
      {
        find: '@forgeax/engine-render/authoring',
        replacement: fileURLToPath(new URL('../render/src/authoring.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    exclude: ['**/*.browser.test.ts', '**/*.dawn.test.ts', '**/node_modules/**', '**/dist/**'],
    name: '@forgeax/engine-picking',
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: ['dist/**', '**/*.config.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
