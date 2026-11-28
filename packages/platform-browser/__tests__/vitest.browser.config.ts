import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { selectBrowserExecutable } from '../../../scripts/ci/browser-executable.mjs';

export default defineConfig({
  test: {
    include: ['packages/platform-browser/src/__tests__/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: selectBrowserExecutable({ channel: 'chrome', chromiumSandbox: true }),
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
