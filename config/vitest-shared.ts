import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { DawnSequencer } from './vitest-dawn-sequencer';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Shared runner policy; project declarations own only their own workload. */
export const sharedVitestConfig = defineConfig({
  root: REPOSITORY_ROOT,
  test: {
    globals: false,
    sequence: { sequencer: DawnSequencer },
    passWithNoTests: true,
    teardownTimeout: 500,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      provider: 'v8',
      // Package projects exercise one another through workspace imports. Keep
      // those first-party sources in the aggregate instead of dropping them
      // merely because they sit outside the importing project's root.
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html'],
      // Exclude test fixtures, mocks, and generated build artifacts so the
      // global threshold reflects production source coverage. `__tests__/`
      // hosts vitest test files plus shared fixtures (`_arbs.ts` /
      // `_fixtures.ts` / `__mocks__/gpu-device.ts`); `wgpu-wasm/pkg/` is the
      // merged wasm-pack output (generated JS bindings, not hand-authored
      // source — feat-20260511-naga-rhi-wgpu-merge M1 productionised the
      // archived @forgeax/engine-naga-wasm-shim into this single bundle). Keeping
      // these inside the threshold pool penalised production-source
      // contributions disproportionately (charter proposition 4 explicit
      // failure: thresholds must measure the SUT, not its scaffolding).
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.mjs',
        '**/*.test-d.ts',
        '**/coverage/**',
        '**/wgpu-wasm/pkg/**',
        '**/scripts/**',
        '**/build.mjs',
        '**/vitest.config.ts',
        '**/tsup.config.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
