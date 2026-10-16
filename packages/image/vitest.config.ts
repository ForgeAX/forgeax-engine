import { defineProject } from 'vitest/config';

// engine-image unit tests (vitest unit project). Typecheck enabled at the
// project scope so *.test-d.ts assertions on the ImageErrorCode
// exhaustive switch + ImageErrorDetail discriminated narrowing are
// surfaced by the same `pnpm test:unit` invocation (TDD red-green path
// per plan-strategy section 5.1 / 5.4; mirrors packages/input/
// vitest.config.ts shape).
//
// Coverage threshold 80% per plan-strategy section 5.4 (
// "@forgeax/engine-image >= 80%; pure functions only, no DOM-side
// branches").
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-image',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
