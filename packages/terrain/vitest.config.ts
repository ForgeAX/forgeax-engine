import { defineProject } from 'vitest/config';

export default defineProject({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    name: '@forgeax/engine-terrain',
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: ['dist/**', '**/*.config.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
