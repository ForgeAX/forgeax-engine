import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-devkit/runtime-browser',
    reporters: process.env.FORGEAX_BROWSER_COST_REPORT === '1'
      ? ['default', fileURLToPath(new URL('../../scripts/ci/browser-cost-reporter.mjs', import.meta.url))]
      : ['default'],
    environment: 'node',
    include: [
      '__tests__/runtime-pack-worker.test.ts',
      '__tests__/game-3d-runtime-vase.test.ts',
      '__tests__/host-runtime-fault.test.ts',
      '__tests__/workspace-thumbnails.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 240000,
  },
});
