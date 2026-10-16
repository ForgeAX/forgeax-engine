#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'keyboard-modifiers', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-keyboard-modifiers', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.waitForFunction(() => globalThis.__bevyKeyboardModifiersReady === true, undefined, { timeout: 20_000 });
    await page.keyboard.down('a');
    await page.waitForFunction(() => globalThis.__bevyKeyboardModifiersState.rejectedPresses >= 1, undefined, { timeout: 5_000 });
    await page.keyboard.up('a');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Control');
    await page.waitForFunction(() => globalThis.__bevyKeyboardModifiersState.modifierFrames >= 1, undefined, { timeout: 5_000 });
    await page.keyboard.down('a');
    await page.waitForFunction(() => globalThis.__bevyKeyboardModifiersState.chordPresses >= 1 && globalThis.__bevyKeyboardModifiersState.heldShift && globalThis.__bevyKeyboardModifiersState.heldCtrl, undefined, { timeout: 5_000 });
    await page.keyboard.up('a');
    await page.keyboard.up('Control');
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => globalThis.__bevyKeyboardModifiersState.heldShift === false && globalThis.__bevyKeyboardModifiersState.heldCtrl === false && globalThis.__bevyKeyboardModifiersState.heldA === false, undefined, { timeout: 5_000 });
    await page.screenshot({ path: resolve(artifactDir, 'keyboard-modifiers-browser.png') });
    const state = await page.evaluate(() => ({ ...globalThis.__bevyKeyboardModifiersState }));
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (state.chordPresses !== 1 || state.rejectedPresses !== 1 || state.modifierFrames < 1) throw new Error(`modifier state incomplete: ${JSON.stringify(state)}`);
    console.log(`[smoke-browser] state=${JSON.stringify(state)}`);
    console.log('[smoke-browser] PASS - Chrome proved Ctrl+Shift+A and rejected unmodified A');
  } finally { await browser.close(); }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { vite.kill('SIGTERM'); await sleep(300); }
