import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { compatibilityLaunch } from '../scripts/ci/webgpu-compatibility-plan.mjs';

const webkit = process.env.FORGEAX_COMPAT_BROWSER === 'webkit';
const root = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  root,
  server: { fs: { allow: [root] } },
  plugins: [forgeaxShader()],
  define: {
    'import.meta.env.FORGEAX_COMPAT_WEBKIT': JSON.stringify(webkit),
  },
  test: {
    name: 'compatibility-scene',
    include: ['packages/runtime/src/__tests__/compatibility-scene.browser.test.ts'],
    passWithNoTests: false,
    retry: 0,
    testTimeout: 120_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: webkit ? {} : compatibilityLaunch(browserLaunch, 'scene'),
      }),
      instances: [{ browser: webkit ? 'webkit' : 'chromium' }],
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    },
  },
});
