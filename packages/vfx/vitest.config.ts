import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-vfx',
    benchmark: {
      include: ['src/**/__tests__/**/*.bench.ts'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      reporters: ['default'],
    },
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
