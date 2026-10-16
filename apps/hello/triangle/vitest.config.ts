import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/hello-triangle',
    include: ['__tests__/**/*.test.ts'],
  },
});
