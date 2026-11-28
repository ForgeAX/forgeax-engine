import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/water-r3-pool',
    include: ['src/pool/__tests__/*.unit.test.ts', 'src/__tests__/*.unit.test.ts'],
    environment: 'node',
  },
});
