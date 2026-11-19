import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tsconfig: fileURLToPath(new URL('./tsconfig.test.json', import.meta.url)),
  test: {
    environment: 'node',
    name: '@forgeax/engine-vite-plugin-pack',
    passWithNoTests: true,
    testTimeout: 90_000,
    hookTimeout: 90_000,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
