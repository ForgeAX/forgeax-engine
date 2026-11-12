import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { compatibilityLaunch } from '../scripts/ci/webgpu-compatibility-plan.mjs';

const webkit = process.env.FORGEAX_COMPAT_BROWSER === 'webkit';
const phase = process.env.FORGEAX_COMPAT_PHASE ?? 'owners';

// The compatibility owner does not import unrelated Pack/App build outputs.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    name: 'webgpu-compatibility',
    include:
      phase !== 'owners'
        ? ['packages/rhi-webgpu/src/__tests__/compatibility-profile.browser.test.ts']
        : webkit
          ? ['packages/rhi-wgpu/src/__tests__/texture-compatibility.browser.test.ts']
          : ['packages/rhi-webgpu/src/__tests__/*.browser.test.ts'],
    exclude: phase === 'owners' ? ['**/compatibility-profile.browser.test.ts'] : [],
    fileParallelism: false,
    passWithNoTests: false,
    retry: 0,
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: webkit ? {} : compatibilityLaunch(browserLaunch, phase),
      }),
      instances: [{ browser: webkit ? 'webkit' : 'chromium' }],
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    },
  },
  define: { __FORGEAX_COMPAT_PHASE__: JSON.stringify(phase) },
});
