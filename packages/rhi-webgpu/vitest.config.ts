import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-rhi-webgpu',
    passWithNoTests: true,
    // Exclude `*.browser.test.ts` / `*.dawn.test.ts` -- those are owned by
    // the root `browser` / `dawn` vitest projects (K-3 split stance, root
    // vitest.config.ts projects). Without this, the per-package project's
    // default include glob picks up the dedicated test files in node env
    // (no document, no dawn injection setupFiles), causing cascade failures
    // under `pnpm test:unit`. Mirror of packages/engine/vitest.config.ts.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
