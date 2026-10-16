import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: ROOT,
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['scripts/__tests__/**/*.test.ts'],
    passWithNoTests: false,
  },
});
