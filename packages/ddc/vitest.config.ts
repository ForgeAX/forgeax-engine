import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-ddc',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
