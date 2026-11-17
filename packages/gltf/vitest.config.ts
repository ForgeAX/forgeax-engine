import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Per-package vitest project (K-3 split policy: discovered from root
// vitest.config.ts via `packages/*` glob, addressable as
// `--project='@forgeax/engine-gltf'`).
//
// Mirrors `packages/import/vitest.config.ts` shape: name is the npm package
// id, include scopes source-collocated `__tests__` suites. Typecheck is
// enabled so `.test-d.ts`
// (compile-time discriminated-union narrowing fixtures) participate in
// the unit run.
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Vite transforms use the shared compiler policy; tsc owns project references.
  tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
  test: {
    environment: 'node',
    name: '@forgeax/engine-gltf',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
      include: ['src/**/*.test.ts', 'src/**/*.test-d.ts'],
    },
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test-d.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
