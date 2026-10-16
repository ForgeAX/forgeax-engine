#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'touch-input', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-touch-input', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.waitForFunction(() => globalThis.__bevyTouchInputReady === true, undefined, { timeout: 20_000 });
    const canvasBox = await page.locator('#app').boundingBox();
    if (!canvasBox) throw new Error('canvas has no browser bounding box');
    const point = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    const emit = async (type, pointerId, x, y) => page.evaluate(({ type, pointerId, x, y }) => {
      document.querySelector('#app').dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        button: type === 'pointerdown' ? 0 : -1,
        pressure: type === 'pointerup' || type === 'pointercancel' ? 0 : 0.5,
      }));
    }, { type, pointerId, x, y });
    await emit('pointerdown', 9, point.x - 80, point.y - 40);
    await page.waitForFunction(() => globalThis.__bevyTouchInputState.justPressedTouches >= 1 && globalThis.__bevyTouchInputState.activeContactFrames >= 1, undefined, { timeout: 5_000 });
    await emit('pointermove', 9, point.x + 40, point.y + 20);
    await page.waitForFunction(() => globalThis.__bevyTouchInputState.lastActiveX > 0 && globalThis.__bevyTouchInputState.activeContactFrames >= 2, undefined, { timeout: 5_000 });
    await emit('pointerup', 9, point.x + 70, point.y + 30);
    await page.waitForFunction(() => globalThis.__bevyTouchInputState.justReleasedTouches >= 1, undefined, { timeout: 5_000 });
    await emit('pointerdown', 10, point.x + 80, point.y + 40);
    await page.waitForFunction(() => globalThis.__bevyTouchInputState.justPressedTouches >= 2, undefined, { timeout: 5_000 });
    await emit('pointercancel', 10, point.x + 80, point.y + 40);
    await page.waitForFunction(() => globalThis.__bevyTouchInputState.canceledTouches >= 1, undefined, { timeout: 5_000 });
    await page.screenshot({ path: resolve(artifactDir, 'touch-input-browser.png') });
    const state = await page.evaluate(() => ({ ...globalThis.__bevyTouchInputState }));
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (state.justPressedTouches !== 2 || state.justReleasedTouches !== 1 || state.canceledTouches !== 1 || state.activeContactFrames < 2) throw new Error(`touch state incomplete: ${JSON.stringify(state)}`);
    console.log(`[smoke-browser] state=${JSON.stringify(state)}`);
    console.log('[smoke-browser] PASS - Chrome proved touch down, release, cancel, and active contact state');
  } finally { await browser.close(); }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { vite.kill('SIGTERM'); await sleep(300); }
