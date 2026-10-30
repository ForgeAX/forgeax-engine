import { defineProject } from 'vitest/config';
import { DAWN_COMPACT_TEST_FILES } from '../scripts/ci/dawn-compact-roster.mjs';
import {
  DAWN_ISOLATED_TEST_FILES,
  DIRECT_LIGHT_DAWN_TEST_FILE,
} from '../scripts/ci/dawn-gate-roster.mjs';

// Every exclusion is derived from the same roster used by local, PR and nightly.
const R32FLOAT_CAPABILITY_GENERATION_TEST =
  'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
const RUNNING_DIRECT_LIGHT_PARTITION = process.env.FORGEAX_DAWN_PARTITION !== undefined;
const RUNNING_DAWN_COMPACT = process.env.FORGEAX_DAWN_COMPACT === '1';
const RUNNING_DAWN_ISOLATED = process.env.FORGEAX_DAWN_ISOLATED === '1';

/** The sole Dawn project policy for root and native-only entrypoints. */
export const dawnProject = defineProject({
  test: {
    name: 'dawn',
    environment: 'node',
    // Keep cold native startup within the existing allowance. A failing
    // renderer journey reports once instead of replaying its full setup
    // and teardown twice before the owning error becomes visible.
    testTimeout: 30000,
    retry: 0,
    // Native Dawn queue/device teardown can take longer than the root
    // 500 ms budget on the heavy runner after a dense carrier finishes.
    // Keep the bound tight but allow the worker to close cleanly instead
    // of turning completed assertions into a Vitest worker-exit error.
    teardownTimeout: 5000,
    // Dawn tests use a shared software Vulkan backend. Keep this project
    // to one worker: the 96-vCPU heavy runners can otherwise launch
    // multiple GPU processes and lose workers under lavapipe contention.
    maxWorkers: 1,
    include: [
      '**/*.dawn.test.ts',
      'packages/rhi-wgpu/src/__tests__/**/*.dawn.test.ts',
      'packages/runtime/src/__tests__/transform-hierarchy-pixel-diff.dawn.test.ts',
      // feat-20260707 M5 / w32: the equirect BC6H HDR-chain integration
      // test needs the dawn-node GPU env to read texture-compression-bc
      // and upload a BC6H texture; it is `.integration.test.ts`-named
      // (plan-tasks w32), so list it explicitly here and let it skipIf
      // navigator.gpu is absent under the per-package unit project.
      'packages/runtime/src/__tests__/equirect-bc6h.integration.test.ts',
      R32FLOAT_CAPABILITY_GENERATION_TEST,
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/artifacts/**',
      '**/docs/reports/**',
      '**/.forgeax-harness*/**',
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      ...(RUNNING_DIRECT_LIGHT_PARTITION ? [] : [DIRECT_LIGHT_DAWN_TEST_FILE]),
      ...(RUNNING_DAWN_ISOLATED ? [] : DAWN_ISOLATED_TEST_FILES),
      ...(RUNNING_DAWN_COMPACT ? [] : DAWN_COMPACT_TEST_FILES),
    ],
    setupFiles: ['./config/vitest.setup-webgpu.ts'],
  },
});
