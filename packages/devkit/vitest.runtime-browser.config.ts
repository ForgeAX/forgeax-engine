import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const browserFiles = {
  runtime: ['__tests__/runtime-pack-worker.test.ts', '__tests__/host-runtime-fault.test.ts'],
  workspace: ['__tests__/workspace-thumbnails.test.ts', '__tests__/workspace-project-server.test.ts'],
  vase: ['__tests__/game-3d-runtime-vase.test.ts', '__tests__/runtime-pack-single-html.test.ts'],
};
const partition = process.env.FORGEAX_DEVKIT_RUNTIME_BROWSER_PARTITION;
if (partition !== undefined && !Object.hasOwn(browserFiles, partition))
  throw new Error(`unknown DevKit runtime browser partition: ${partition}`);
const include =
  partition === undefined
    ? Object.values(browserFiles).flat()
    : browserFiles[partition as keyof typeof browserFiles];

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-devkit/runtime-browser',
    setupFiles: ['src/__tests__/fixtures/catalogue-store.ts'],
    reporters: process.env.FORGEAX_BROWSER_COST_REPORT === '1'
      ? ['default', fileURLToPath(new URL('../../scripts/ci/browser-cost-reporter.mjs', import.meta.url))]
      : ['default'],
    environment: 'node',
    include,
    fileParallelism: false,
    testTimeout: 240000,
  },
});
