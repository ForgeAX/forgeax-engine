import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineProject({
  resolve: {
    alias: {
      '@forgeax/engine-ecs': fileURLToPath(new URL('../ecs/src/index.ts', import.meta.url)),
      '@forgeax/engine-intelligence': fileURLToPath(
        new URL('../intelligence/src/index.ts', import.meta.url),
      ),
      '@forgeax/engine-plugin': fileURLToPath(new URL('../plugin/src/index.ts', import.meta.url)),
      '@forgeax/engine-types': fileURLToPath(new URL('../types/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    name: '@forgeax/engine-dsh',
    include: ['src/__tests__/**/*.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: ['dist/**', 'lib/**', '**/*.config.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
