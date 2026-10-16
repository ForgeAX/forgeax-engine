import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-tool-runtime',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    typecheck: { enabled: true, include: ['__tests__/**/*.test-d.ts'] },
  },
});
