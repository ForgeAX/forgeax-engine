import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@forgeax/engine-ui-blitz',
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
    testTimeout: 30_000,
    typecheck: { enabled: true, tsconfig: './tsconfig.test.json' },
  },
});
