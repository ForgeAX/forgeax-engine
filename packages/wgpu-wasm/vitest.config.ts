import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-wgpu-wasm',
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
