import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-rhi-wgpu',
    passWithNoTests: true,
    // Mirror packages/rhi-webgpu/vitest.config.ts (K-3 split stance):
    // exclude `*.browser.test.ts` / `*.dawn.test.ts` so the per-package
    // project does not collide with the root `browser` / `dawn` projects.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
