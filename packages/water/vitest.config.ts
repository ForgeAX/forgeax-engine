import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.dawn.test.ts'],
    environment: 'node',
    benchmark: { include: ['bench/**/*.bench.ts'] },
  },
});
