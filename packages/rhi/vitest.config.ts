import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-rhi',
    passWithNoTests: true,
    // Vitest 4.x: project scope must explicitly opt-in to typecheck, otherwise *.test-d.ts is silently skipped.
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
