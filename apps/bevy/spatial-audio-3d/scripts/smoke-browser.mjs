#!/usr/bin/env node
// Real Chrome/WebGPU/Web Audio smoke for spatial_audio_3d.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'spatial-audio-3d', 'artifacts');
mkdirSync(artifactDir, { recursive: true });

const vite = spawn('pnpm', ['-F', '@forgeax/bevy-spatial-audio-3d', 'dev'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('vite did not become ready in 30s');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
    });

    await page.goto(`${url.replace(/\/$/, '')}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('loaded='), undefined, { timeout: 15_000 });
    const beforePath = resolve(artifactDir, 'spatial-audio-before.png');
    const afterPath = resolve(artifactDir, 'spatial-audio-listener-left.png');
    await page.screenshot({ path: beforePath });

    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.waitForFunction(() => {
      const text = document.querySelector('#audio-status')?.textContent ?? '';
      return text.includes('audio=running') && text.includes('active=1') && text.includes('playing=1');
    }, undefined, { timeout: 10_000 });
    const playingStatus = await page.locator('#audio-status').textContent();

    await page.keyboard.down('a');
    await page.waitForTimeout(550);
    await page.keyboard.up('a');
    await page.waitForFunction(() => document.querySelector('#spatial-status')?.textContent?.includes('pan=R'), undefined, { timeout: 10_000 });
    const movedStatus = await page.locator('#spatial-status').textContent();
    await page.screenshot({ path: afterPath });

    await page.keyboard.down('m');
    await page.waitForTimeout(100);
    await page.keyboard.up('m');
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('mute=1'), undefined, { timeout: 5_000 });
    const muteStatus = await page.locator('#audio-status').textContent();

    const stoppedState = await page.evaluate(() => window.__spatialAudioStop?.());
    if (!stoppedState || stoppedState.contextState !== 'closed' || stoppedState.activeSourceCount !== 0) {
      throw new Error(`app.stop did not reclaim audio: ${JSON.stringify(stoppedState)}`);
    }

    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[smoke-browser] playing=${playingStatus}`);
    console.log(`[smoke-browser] moved=${movedStatus}`);
    console.log(`[smoke-browser] muted=${muteStatus}`);
    console.log(`[smoke-browser] stopped=${JSON.stringify(stoppedState)}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log('[smoke-browser] PASS - Chrome gesture resumed AudioContext, loop source is active, listener pan moved right, and SFX mute toggled.');
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  vite.kill('SIGTERM');
  await sleep(300);
}
