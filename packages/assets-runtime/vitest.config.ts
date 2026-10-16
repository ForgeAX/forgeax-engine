import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-assets-runtime',
    passWithNoTests: true,
    // Exclude `*.browser.test.ts` — those are owned by the root `browser`
    // vitest project (see repo-root vitest.config.ts). Without this, the
    // node project picks them up and fails (no `createImageBitmap` /
    // `OffscreenCanvas` in node env). Mirrors packages/audio-webaudio and
    // packages/runtime policy.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: ['dist/**', '**/*.config.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
