import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-plugin',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.mjs', 'src/__tests__/**/*.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: [
        'dist/**',
        '**/*.config.ts',
        '__tests__/**',
        'bench/**',
        '**/*.bench.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
