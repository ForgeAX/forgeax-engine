import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/water-r5-gpu-mesh-async-pontoons',
    environment: 'node',
    include: ['assets/__tests__/*.unit.test.ts', 'src/__tests__/*.unit.test.ts'],
  },
});
