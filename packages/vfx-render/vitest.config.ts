import { defineProject } from 'vitest/config';
import { createRenderSourceAliases } from '../../config/vitest-render-source-alias';

export default defineProject({
  resolve: { alias: [...createRenderSourceAliases()] },
  test: {
    environment: 'node',
    name: '@forgeax/engine-vfx-render',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.dawn.test.ts', '**/*.browser.test.ts'],
  },
});
