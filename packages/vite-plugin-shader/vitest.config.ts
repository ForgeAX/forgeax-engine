import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-vite-plugin-shader',
    passWithNoTests: true,
    // The root Dawn project installs the GPU environment for these tests.
    exclude: [...configDefaults.exclude, '**/*.dawn.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
