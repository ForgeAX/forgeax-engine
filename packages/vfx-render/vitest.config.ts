import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { createRenderSourceAliases } from '../../config/vitest-render-source-alias';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tsconfig: fileURLToPath(new URL('./tsconfig.test.json', import.meta.url)),
  resolve: { alias: [...createRenderSourceAliases()] },
  test: {
    environment: 'node',
    name: '@forgeax/engine-vfx-render',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.dawn.test.ts', '**/*.browser.test.ts'],
  },
});
