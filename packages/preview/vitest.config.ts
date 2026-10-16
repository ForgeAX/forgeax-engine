import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-preview',
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
