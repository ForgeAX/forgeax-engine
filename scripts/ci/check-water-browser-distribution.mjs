import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import browserLaunch from './browser-launch.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../packages/engine/', import.meta.url));
const entryPath = '/__water_distribution_entry.js';
const entryId = '\0water-distribution-entry';
const htmlPath = '/__water_distribution.html';
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'water-distribution-entry',
      resolveId(id) {
        if (id === entryPath) return entryId;
      },
      load(id) {
        if (id !== entryId) return;
        return `
        import * as publicWater from '@forgeax/engine-water';
        import * as internalWater from '@forgeax/engine-water/internal';
        globalThis.__waterDistribution = {
          publicWaterSystem: typeof publicWater.WaterSystem,
          internalSchema: internalWater.WATER_MESH_INSTANCE_SCHEMA_VERSION,
        };
      `;
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url?.split('?')[0] !== htmlPath) return next();
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(`<!doctype html><script type="module" src="${entryPath}"></script>`);
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== 'string', 'Vite did not expose a local port');
  browser = await chromium.launch({ ...browserLaunch, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}${htmlPath}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => globalThis.__waterDistribution !== undefined, null, {
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(`Water dist browser import failed: ${errors.join(' | ') || error.message}`);
  }
  assert.deepEqual(await page.evaluate(() => globalThis.__waterDistribution), {
    publicWaterSystem: 'function',
    internalSchema: 8,
  });
  assert.deepEqual(errors, []);
  console.log(
    '[water-browser-distribution] PASS public and internal dist entries under Vite noDiscovery',
  );
} finally {
  await browser?.close();
  await server.close();
}
