import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
      include: ['src/**/*.test.ts', 'src/**/*.test-d.ts'],
    },
    include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
