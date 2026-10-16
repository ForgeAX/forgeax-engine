import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-vite-plugin-pack',
    passWithNoTests: true,
    testTimeout: 90_000,
    hookTimeout: 90_000,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
