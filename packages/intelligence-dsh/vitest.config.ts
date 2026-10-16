import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-intelligence-dsh',
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
