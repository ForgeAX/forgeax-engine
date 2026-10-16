import { defineProject } from 'vitest/config';

// Project-scoped vitest config. Vitest 4.x requires explicit typecheck opt-in
// at project level - without it *.test-d.ts files silently skip (matching
// @forgeax/engine-rhi sibling config pattern).
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-remote',
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
