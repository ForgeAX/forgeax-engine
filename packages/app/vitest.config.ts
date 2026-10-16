import { defineProject } from 'vitest/config';

// engine-app unit tests (vitest unit project). Typecheck enabled so
// *.test-d.ts assertions on createApp double-SSOT entry overload
// signatures (AC-01 / AC-02 / AC-09) are surfaced by the same
// `pnpm test:unit` invocation (TDD red-green path per plan-strategy
// section 5.1; aligns with packages/input/vitest.config.ts).
//
// Coverage thresholds left at vitest defaults in M1 -- the rAF / state
// machine / fan-out coverage thresholds (line >= 100, branch >= 95
// per plan-strategy section 5.4) land alongside the M2..M5 runtime
// implementations (M1 only ships the type-level skeleton).
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-app',
    // Exclude `*.browser.test.ts` -- those are owned by the root `browser`
    // vitest project (K-3 split). Without this, the per-package project's
    // default include glob picks up the browser test files in node env
    // (no document / no real WebGPU canvas), causing cascade fail under
    // `pnpm test:unit`. Mirrors packages/runtime/vitest.config.ts policy.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
