import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/water-r8-integration-acceptance',
    environment: 'node',
    include: [
      'assets/__tests__/*.unit.test.ts',
      'assets/__tests__/*.integration.test.ts',
      'src/__tests__/*.unit.test.ts',
    ],
  },
});
