import { once } from 'node:events';
// Real Vite + browser proof for the preview host's opted-in asset refresh.
//
// This intentionally does not use Vitest's browser dev server: the assertion
// needs to mutate a watched on-disk sidecar and observe Vite's full-reload
// websocket crossing into the actual preview document.

import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixture = resolve(root, 'apps/game-capability-lab/assets/base-material.pack.json');
const artifactDir = resolve(process.env.FORGEAX_CATALOG_REFRESH_DIR ?? resolve(root, '.forgeax-debug/catalog-refresh'));
const marker = /("baseColor"\s*:\s*\[\s*)0\.6/;
mkdirSync(artifactDir, { recursive: true });

async function availablePort() {
  const probe = createNetServer();
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a TCP port');
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

const port = await availablePort();
const server = spawn(
  'pnpm',
  ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const original = await readFile(fixture, 'utf8');
let browser;

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`preview Vite server did not start: ${serverOutput}`);
  const origin = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
    ],
    chromiumSandbox: true,
  });
  const page = await browser.newPage();
  const errors = [];
  const lifecycle = [];
  page.on('crash', () => lifecycle.push('page-crash'));
  page.on('close', () => lifecycle.push('page-close'));
  browser.on('disconnected', () => lifecycle.push('browser-disconnected'));
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const url = message.location().url;
    if (message.type() === 'error' && !url.endsWith('/favicon.ico')) {
      errors.push(`console: ${message.text()} (${url})`);
    }
  });

  await page.goto(`${origin}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#app', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    return canvas !== null && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0;
  });
  await page.waitForFunction(() => {
    const listed = globalThis.__forgeaxPreviewInspection?.list();
    return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
  });

  const before = await page.evaluate(async () => {
    const response = await fetch('/__pack/lookup/eb5bf6e6-2e47-4d9a-99fd-81843228c9b3');
    return { ok: response.ok, row: await response.json() };
  });
  if (!before.ok || before.row.guid !== 'eb5bf6e6-2e47-4d9a-99fd-81843228c9b3') {
    throw new Error('pre-mutation asset catalog lookup failed');
  }
  const beforeGame = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  if (!beforeGame?.ok || beforeGame.value.state.phase !== 'Play') {
    throw new Error(`pre-mutation game snapshot failed: ${JSON.stringify(beforeGame)}`);
  }
  await page.screenshot({ path: resolve(artifactDir, 'before.png') });

  const navigation = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame() && frame.url().startsWith(origin),
    timeout: 30_000,
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  if (!marker.test(original)) throw new Error('preview asset fixture drifted; refresh mutation marker is absent');
  await writeFile(fixture, original.replace(marker, (_match, prefix) => `${prefix}0.61`));
  const navigationResult = await navigation;
  if (!navigationResult.ok) {
    throw new Error(`preview refresh lifecycle failed: ${JSON.stringify({ error: String(navigationResult.error), lifecycle, errors })}`);
  }

  await page.waitForSelector('#app', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const listed = globalThis.__forgeaxPreviewInspection?.list();
    return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
  });
  const afterGame = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  const health = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect();
    return {
      canvasLive: canvas instanceof HTMLCanvasElement && (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
      errorOverlay: document.querySelector('[role="alert"], [data-error-overlay]') !== null,
    };
  });
  if (!health.canvasLive) throw new Error('post-refresh preview canvas is absent or zero-sized');
  if (health.errorOverlay) throw new Error('post-refresh preview displayed an error overlay');
  if (!afterGame?.ok || afterGame.value.state.phase !== 'Play') {
    throw new Error(`post-refresh game snapshot failed: ${JSON.stringify(afterGame)}`);
  }
  if (errors.length > 0 || lifecycle.length > 0) {
    throw new Error(`preview reported browser lifecycle/errors after Vite refresh: ${JSON.stringify({ errors, lifecycle })}`);
  }
  await page.screenshot({ path: resolve(artifactDir, 'after.png') });
  await writeFile(
    resolve(artifactDir, 'report.json'),
    `${JSON.stringify({
      oracle: 'watched game-default material sidecar triggers a real Vite reload while the canvas and Play inspection snapshot recover',
      source: fixture,
      before,
      beforeGame,
      afterGame,
      health,
      errors,
      lifecycle,
      serverOutput,
    }, null, 2)}\n`,
  );

  console.log(`[catalog-refresh] PASS canvasLive=${health.canvasLive} phase=${afterGame.value.state.phase} pageErrors=0 artifacts=${artifactDir}`);
} finally {
  await writeFile(fixture, original);
  await browser?.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await sleep(300);
}
