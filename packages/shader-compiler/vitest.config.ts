import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-shader-compiler',
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
