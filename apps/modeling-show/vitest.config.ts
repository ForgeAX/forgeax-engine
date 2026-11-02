import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@forgeax/app-modeling-show',
    environment: 'node',
    // The Dawn smoke belongs to the repository dawn project.
    include: ['__tests__/*.unit.test.ts'],
  },
});
