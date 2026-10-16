#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5183);
const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
try {
  const timeoutMs = Number(process.env.SMOKE_BROWSER_SERVER_TIMEOUT ?? 30000);
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Vite is still starting; keep polling until the bounded timeout.
    }
    await delay(100);
  }
  if (!ready) throw new Error(`Vite did not become ready within ${timeoutMs}ms`);
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.url()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__bevyMesh2dArcsReady === true, null, { timeout: Number(process.env.SMOKE_BROWSER_TIMEOUT ?? 30000) });
  await page.screenshot({ path: 'artifacts/mesh2d-arcs-browser.png' });
  console.log(`[smoke-browser] ready=1 canvas=${await page.locator('canvas').getAttribute('width')}x${await page.locator('canvas').getAttribute('height')}`);
  if (errors.length > 0) throw new Error(errors.join(' | '));
  console.log('[smoke-browser] PASS - Chrome loaded mesh2d_arcs and reached the running-system ready marker');
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
