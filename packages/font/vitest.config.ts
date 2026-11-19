import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Per-package vitest project (K-3 split policy: discovered from root
// vitest.config.ts via `packages/*` glob, addressable as
// `--project='@forgeax/engine-font'`).
//
// Mirrors `packages/gltf/vitest.config.ts` shape: name is the npm package
// id, include scopes `src/**/__tests__/**` source-collocated tests.
// Typecheck is enabled so `.test-d.ts` (compile-time discriminated-union
// narrowing fixtures) participate in the unit run.
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
  test: {
    environment: 'node',
    name: '@forgeax/engine-font',
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
