import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
  test: {
    name: '@forgeax/water-shared',
    environment: 'node',
    include: ['__tests__/*.unit.test.ts'],
  },
});
