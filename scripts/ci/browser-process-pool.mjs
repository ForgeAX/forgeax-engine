import { browserGpuLaunchOptions } from './browser-executable.mjs';
import browserLaunch from './browser-launch.json' with { type: 'json' };

const maxGroupsPerProcess = 3;

export function createBrowserProcessPool(capacity, launch = launchBrowser) {
  const slots = Array(capacity).fill(undefined);

  async function retire(index) {
    const entry = slots[index];
    slots[index] = undefined;
    if (!entry) return;
    try {
      await entry.server.close();
    } catch {
      await entry.server.kill();
    }
  }

  return {
    retire,
    close: () => Promise.all(slots.map((_entry, index) => retire(index))),
    async run(index, execute) {
      let entry = slots[index];
      if (!entry) {
        try {
          entry = { server: await launch(), groups: 0 };
          slots[index] = entry;
          console.error('[browser-process-pool] Chromium started');
        } catch {
          // No test has started. Keep the existing standalone launch path.
          return execute();
        }
      } else console.error('[browser-process-pool] Chromium reused');
      let result;
      try {
        result = await execute(entry.server.wsEndpoint());
      } catch (error) {
        await retire(index).catch(() =>
          console.error('[browser-process-pool] Chromium shutdown failed'),
        );
        throw error;
      }
      if (++entry.groups >= maxGroupsPerProcess) await retire(index);
      return result;
    },
  };
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launchServer({
    ...browserGpuLaunchOptions(browserLaunch),
    host: '127.0.0.1',
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
    timeout: 15_000,
    chromiumSandbox: true,
  });
}
