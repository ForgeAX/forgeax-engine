import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@forgeax/template-game-3d',
    environment: 'node',
    // Bound concurrent modeling/bake owners while retaining their full assertions and budgets.
    maxWorkers: 2,
    // Scope discovery to the game's own tests; installed skills under skills/ and
    // .forgeax/ carry their own test files that are not part of this project.
    include: ['assets/**/__tests__/**/*.test.ts'],
  },
});
