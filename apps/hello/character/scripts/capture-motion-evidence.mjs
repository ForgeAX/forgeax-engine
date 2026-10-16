#!/usr/bin/env node

import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const APP_ROOT = resolve(HERE, '..');
const VITE_BIN = resolve(APP_ROOT, 'node_modules/.bin/vite');
const SCREENSHOT_DIR = process.env.CHARACTER_SCREENSHOT_DIR
  ? resolve(process.env.CHARACTER_SCREENSHOT_DIR)
  : resolve(
      REPO_ROOT,
      'artifacts/feat-20260716-ecs-time-and-scheduling/screenshots',
    );
const FIRST_SCREENSHOT = resolve(SCREENSHOT_DIR, 'character-a.png');
const SECOND_SCREENSHOT = resolve(SCREENSHOT_DIR, 'character-b.png');
const VITE_BOOT_DEADLINE_MS = 30_000;
const MOTION_SETTLE_MS = 2_000;

mkdirSync(SCREENSHOT_DIR, { recursive: true });
rmSync(FIRST_SCREENSHOT, { force: true });
rmSync(SECOND_SCREENSHOT, { force: true });

const viteProc = spawn(VITE_BIN, ['--port', '5187', '--strictPort'], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
viteProc.on('error', (error) => process.stderr.write(`[vite] ${error.message}\n`));
let serverUrl;
viteProc.stdout.on('data', (chunk) => {
  const output = chunk.toString();
  process.stdout.write(`[vite] ${output}`);
  const plainOutput = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const match = plainOutput.match(/http:\/\/localhost:\d+\//);
  if (match) serverUrl = match[0];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

function fail(message) {
  throw new Error(`[capture-motion-evidence] ${message}`);
}

try {
  viteProc.unref();
  const deadline = Date.now() + VITE_BOOT_DEADLINE_MS;
  while (!serverUrl && Date.now() < deadline) await sleep(200);
  if (!serverUrl) fail('Vite did not become ready within 30 seconds');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) {
        pageErrors.push(message.text());
      }
    });

    await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    await sleep(MOTION_SETTLE_MS);
    if (pageErrors.length > 0) fail(`browser reported errors: ${pageErrors.join(' | ')}`);

    const firstImage = await page.screenshot({ path: FIRST_SCREENSHOT });
    await page.keyboard.down('d');
    await sleep(MOTION_SETTLE_MS);
    await page.keyboard.up('d');
    if (pageErrors.length > 0) fail(`browser reported errors: ${pageErrors.join(' | ')}`);
    const secondImage = await page.screenshot({ path: SECOND_SCREENSHOT });
    if (firstImage.equals(secondImage)) fail('motion freeze detected: screenshots are byte-identical');
    console.log(`[capture-motion-evidence] wrote ${FIRST_SCREENSHOT}`);
    console.log(`[capture-motion-evidence] wrote ${SECOND_SCREENSHOT}`);
  } finally {
    await browser.close();
  }
} finally {
  viteProc.kill('SIGTERM');
}
