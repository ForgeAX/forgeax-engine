#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'gamepad-input', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-gamepad-input', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.addInitScript(() => {
      let current = { south: false, trigger: 0, stick: 0 };
      const makeButton = (value) => ({ pressed: value > 0.5, touched: value > 0, value });
      const makePad = () => ({ id: 'ForgeAX Mock Standard Gamepad', index: 0, connected: true, mapping: 'standard', buttons: [makeButton(current.south ? 1 : 0), ...Array.from({ length: 6 }, () => makeButton(0)), makeButton(current.trigger)], axes: [current.stick, 0, 0, 0], timestamp: performance.now() });
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [makePad()] });
      globalThis.__setMockGamepad = (next) => { current = { ...current, ...next }; };
    });
    await page.goto(`${url.replace(/\/$/, '')}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(() => globalThis.__bevyGamepadInputReady === true, undefined, { timeout: 20_000 });
    await page.evaluate(() => globalThis.__setMockGamepad({ south: true, trigger: 0.75, stick: 0.8 }));
    await page.waitForFunction(() => globalThis.__bevyGamepadInputState.justPressedSouth >= 1 && globalThis.__bevyGamepadInputState.heldSouth === true && globalThis.__bevyGamepadInputState.maxRightTrigger2 >= 0.75, undefined, { timeout: 5_000 });
    await page.evaluate(() => globalThis.__setMockGamepad({ south: true, trigger: 0.5, stick: -0.6 }));
    await page.waitForFunction(() => globalThis.__bevyGamepadInputState.minLeftStickX <= -0.6, undefined, { timeout: 5_000 });
    await page.evaluate(() => globalThis.__setMockGamepad({ south: false, trigger: 0, stick: 0 }));
    await page.waitForFunction(() => globalThis.__bevyGamepadInputState.justReleasedSouth >= 1 && globalThis.__bevyGamepadInputState.heldSouth === false, undefined, { timeout: 5_000 });
    await page.screenshot({ path: resolve(artifactDir, 'gamepad-input-browser.png') });
    const state = await page.evaluate(() => ({ ...globalThis.__bevyGamepadInputState }));
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (state.justPressedSouth < 1 || state.justReleasedSouth < 1 || state.maxRightTrigger2 < 0.75 || state.minLeftStickX > -0.6) throw new Error(`gamepad state incomplete: ${JSON.stringify(state)}`);
    console.log(`[smoke-browser] state=${JSON.stringify(state)}`);
    console.log('[smoke-browser] PASS - Chrome proved standard gamepad button, trigger, and stick state');
  } finally { await browser.close(); }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { vite.kill('SIGTERM'); await sleep(300); }
