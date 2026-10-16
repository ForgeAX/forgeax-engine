import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fetch-wasm',
    environment: 'node',
    include: ['scripts/__tests__/fetch-wasm-lib.test.mjs'],
    passWithNoTests: false,
  },
});
