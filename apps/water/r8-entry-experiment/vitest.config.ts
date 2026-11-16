import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/water-r8-entry-experiment',
    environment: 'node',
    include: ['src/__tests__/*.unit.test.ts'],
  },
});
