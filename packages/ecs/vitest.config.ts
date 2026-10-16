import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-ecs',
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
