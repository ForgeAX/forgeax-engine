import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { playwrightWithBackgroundPages } from './vitest-browser-provider';
import { createRenderSourceAliases } from './vitest-render-source-alias';
import { createRhiDebugSourceAliases } from './vitest-rhi-debug-source-alias';

// Qualification of the six owned native Worker error/lifecycle fixtures only.
// No authored assets, cooker publications, shader production, or GPU acceptance.
const rootDir = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  root: rootDir,
  test: {
    globals: false,
    passWithNoTests: false,
    teardownTimeout: 500,
    deps: { optimizer: { client: { enabled: false } } },
    projects: [
      {
        // Predeclare only dependencies discovered by the actual native fixture run.
        // Nested IDs resolve from their owning workspace package with pnpm isolation.
        optimizeDeps: {
          include: [
            '@forgeax/engine-app > @forgeax/engine-plugin > @deepseek-ai/cordis',
            '@forgeax/engine-pack > @noble/hashes/legacy.js',
            '@forgeax/engine-pack > @noble/hashes/sha2.js',
            '@forgeax/engine-pack > @noble/hashes/utils.js',
            '@forgeax/engine-pack > acorn',
            '@forgeax/engine-geometry > earcut',
            '@forgeax/engine-image > @forgeax/engine-codec > fzstd',
            '@forgeax/engine-image > @forgeax/engine-codec > @hpcc-js/wasm-zstd',
            '@forgeax/engine-image > jpeg-js',
            '@forgeax/engine-image > pako',
            '@forgeax/engine-assets-runtime > @forgeax/engine-ui > css-tree/dist/csstree.esm',
            '@forgeax/engine-assets-runtime > @forgeax/engine-ui > parse5',
            'upng-js',
            '@forgeax/engine-pack > uuidv7',
          ],
        },
        resolve: { alias: [...createRenderSourceAliases(), ...createRhiDebugSourceAliases()] },
        server: {
          watch: { ignored: ['**/.forgeax-harness/**'] },
          fs: { allow: [rootDir] },
          ...(process.env.FORGEAX_BROWSER_CROSS_ORIGIN_ISOLATED === '1'
            ? {
                headers: {
                  'Cross-Origin-Opener-Policy': 'same-origin',
                  'Cross-Origin-Embedder-Policy': 'require-corp',
                },
              }
            : {}),
        },
        define: {
          'import.meta.env.FORGEAX_RUNTIME_SCOPE_ID': JSON.stringify('browser-tests'),
        },
        test: {
          name: 'browser',
          include: ['packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/artifacts/**',
            '**/.worktrees/**',
            '**/.forgeax-harness/**',
          ],
          fileParallelism: false,
          maxWorkers: 1,
          deps: { optimizer: { client: { enabled: false } } },
          browser: {
            enabled: true,
            ui: false,
            provider: playwrightWithBackgroundPages({
              launchOptions: {
                ...browserLaunch,
                args: [
                  ...browserLaunch.args,
                  ...(process.env.CI ? ['--use-angle=swiftshader', '--disable-gpu-watchdog'] : []),
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
          },
        },
      },
    ],
  },
});
