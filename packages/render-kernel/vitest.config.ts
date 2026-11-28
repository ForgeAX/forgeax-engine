import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-render-kernel',
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.browser-no-webgpu.test.ts',
      '**/*.dawn.test.ts',
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
