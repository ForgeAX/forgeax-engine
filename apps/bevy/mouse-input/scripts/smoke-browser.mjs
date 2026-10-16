#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'mouse-input', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-mouse-input', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let url;
vite.stdout.on('data', (chunk) => { const text = chunk.toString(); process.stdout.write(`[vite] ${text}`); url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]; });
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('vite did not become ready in 30s');
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text()); });
    await page.goto(`${url.replace(/\/$/, '')}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(() => globalThis.__bevyMouseInputReady === true, undefined, { timeout: 20_000 });
    const canvasBox = await page.locator('#app').boundingBox();
    if (!canvasBox) throw new Error('canvas has no browser bounding box');
    const x = canvasBox.x + canvasBox.width / 2;
    const y = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForFunction(() => globalThis.__bevyMouseInputState.justPressedPrimary >= 1 && globalThis.__bevyMouseInputState.heldPrimary === true, undefined, { timeout: 5_000 });
    await page.mouse.move(x + Math.min(40, canvasBox.width / 4), y + Math.min(20, canvasBox.height / 4));
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => globalThis.__bevyMouseInputState.movementFrames >= 1 && globalThis.__bevyMouseInputState.wheelPositive >= 1, undefined, { timeout: 5_000 });
    await page.mouse.up();
    await page.waitForFunction(() => globalThis.__bevyMouseInputState.justReleasedPrimary >= 1 && globalThis.__bevyMouseInputState.heldPrimary === false, undefined, { timeout: 5_000 });
    await page.screenshot({ path: resolve(artifactDir, 'mouse-input-browser.png') });
    const state = await page.evaluate(() => ({ ...globalThis.__bevyMouseInputState }));
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (state.justPressedPrimary < 1 || state.justReleasedPrimary < 1 || state.movementFrames < 1 || state.wheelPositive < 1) throw new Error(`mouse state incomplete: ${JSON.stringify(state)}`);
    console.log(`[smoke-browser] state=${JSON.stringify(state)}`);
    console.log('[smoke-browser] PASS - Chrome proved mouse button edges, movement, and scroll');
  } finally { await browser.close(); }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { vite.kill('SIGTERM'); await sleep(300); }
