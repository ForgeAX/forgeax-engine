import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-wgpu-wasm',
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
      // These contracts retain Node test contexts and their explicit CI owner.
      'scripts/__tests__/native-build.test.mjs',
      'scripts/__tests__/production-csp.test.mjs',
      'scripts/__tests__/source-key.test.mjs',
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
