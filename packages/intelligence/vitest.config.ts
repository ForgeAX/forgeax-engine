import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-intelligence',
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
