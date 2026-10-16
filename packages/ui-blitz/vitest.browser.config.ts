import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import browserLaunch from '../../scripts/ci/browser-launch.json' with { type: 'json' };

// This document-local DOM gate needs a real browser, but no renderer shaders or asset cook.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  test: {
    name: 'ui-blitz-browser',
    include: ['src/**/*.browser.test.ts'],
    fileParallelism: false,
    browser: {
      enabled: true,
      ui: false,
      headless: true,
      provider: playwright({ launchOptions: { ...browserLaunch, chromiumSandbox: true } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
