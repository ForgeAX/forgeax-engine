import { pcmRangeFixture } from './src/__tests__/support/pcm-range-fixture';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import browserLaunch from '../../scripts/ci/browser-launch.json' with { type: 'json' };

// Generated PCM and real Web Audio need no renderer or contributor Pack assets.
export default defineConfig({
  plugins: [pcmRangeFixture()],
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['packages/audio-webaudio/src/__tests__/*.browser.test.ts'],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: browserLaunch }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
