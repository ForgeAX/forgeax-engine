import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';
import { pcmRangeFixture } from '../packages/audio-webaudio/src/__tests__/support/pcm-range-fixture';
import { websocketListenerCommands } from '../packages/net-websocket/__tests__/support/ws-listener-commands';
import hostFiles from '../scripts/ci/browser-host-files.json' with { type: 'json' };
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { browserProcessCacheDir } from '../scripts/ci/browser-process-cache.mjs';
import { explicitBrowserFiles } from './browser-file-selection';
import { playwrightWithBackgroundPages } from './vitest-browser-provider';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const selected = explicitBrowserFiles(rootDir);
const include = selected?.every((file) => hostFiles.includes(file)) ? selected : hostFiles;

// These contracts use native DOM, WebSocket and Web Audio, without a Renderer.
// Keep Chromium and its interaction/audio policies; do not prepare shader/Pack
// publications or initialize a physical graphics device for this exact roster.
const project = defineProject({
  root: rootDir,
  cacheDir: resolve(browserProcessCacheDir(rootDir, process.pid), 'host'),
  plugins: [pcmRangeFixture()],
  server: {
    watch: { ignored: ['**/.forgeax-harness/**'] },
    fs: { allow: [rootDir] },
  },
  test: {
    name: 'browser',
    globals: false,
    passWithNoTests: false,
    teardownTimeout: 500,
    include,
    setupFiles: ['config/browser-host-guard.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    deps: { optimizer: { client: { enabled: false } } },
    browser: {
      enabled: true,
      ui: false,
      commands: websocketListenerCommands,
      provider: playwrightWithBackgroundPages({
        launchOptions: { ...browserLaunch, args: [...browserLaunch.args, '--disable-gpu'] },
      }),
      instances: [{ browser: 'chromium' }],
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
    },
  },
});

// The coordinator and Browser Vite servers both run dependency optimizers.
// Sharing their directory can leave framework module requests waiting forever.
export default defineConfig({
  root: rootDir,
  cacheDir: resolve(browserProcessCacheDir(rootDir, process.pid), 'coordinator'),
  test: {
    globals: false,
    passWithNoTests: false,
    teardownTimeout: 500,
    projects: [project],
  },
});
