import { defineProject } from 'vitest/config';

// Per-package vitest project (K-3 split policy: discovered from root
// vitest.config.ts via `packages/*` glob, addressable as
// `--project='@forgeax/engine-import'`). Mirrors the gltf / pack project
// shape. Typecheck enabled so any `.test-d.ts` narrowing fixtures join the
// unit run.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-import',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test-d.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
