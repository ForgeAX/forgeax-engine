import { defineProject } from 'vitest/config';

// Type-only package — only typecheck contributions. The single test file
// metric-error-code.test-d.ts (M1 T-002) asserts the closed-union shape +
// per-code .detail narrowing + exhaustive-switch B-1 regression guard.
//
// Vitest 4.x: project scope requires explicit `typecheck.enabled = true`,
// otherwise *.test-d.ts is silently skipped. The pattern mirrors
// packages/rhi/vitest.config.ts so the workspace is symmetric.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-types',
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
