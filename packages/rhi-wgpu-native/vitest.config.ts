import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-rhi-wgpu-native',
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**', '**/*.dawn.test.ts'],
  },
});
