import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['assets/__tests__/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
