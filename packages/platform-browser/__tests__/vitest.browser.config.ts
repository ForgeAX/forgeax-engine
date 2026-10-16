import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/platform-browser/src/__tests__/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { chromiumSandbox: true } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
