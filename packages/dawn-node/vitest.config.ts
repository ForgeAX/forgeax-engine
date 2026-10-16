import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-dawn-node',
    environment: 'node',
    exclude: [...configDefaults.exclude, 'dist/**', '.native-build/**', 'scripts/**'],
  },
});
