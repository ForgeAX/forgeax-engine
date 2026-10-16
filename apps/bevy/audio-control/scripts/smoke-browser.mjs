#!/usr/bin/env node
// Real Chrome/Web Audio smoke for audio_control.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = new URL('../../../..', import.meta.url).pathname;
const artifactDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-audio-control', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let url;
vite.stdout.on('data', (chunk) => { const text = chunk.toString(); process.stdout.write(`[vite] ${text}`); url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]; });
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('vite did not become ready in 30s');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist', '--autoplay-policy=user-gesture-required'],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text()); });
    await page.goto(`${url.replace(/\/$/, '')}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('loaded=1'), undefined, { timeout: 15_000 });
    const beforePath = resolve(artifactDir, 'audio-control-before.png');
    const afterPath = resolve(artifactDir, 'audio-control-after.png');
    await page.screenshot({ path: beforePath });
    const printStatus = async (label) => console.log(`[smoke-browser] ${label} audio=${await page.locator('#audio-status').textContent()} control=${await page.locator('#control-status').textContent()}`);
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await printStatus('after-first-space');
    await page.waitForFunction(() => {
      const audio = document.querySelector('#audio-status')?.textContent ?? '';
      const control = document.querySelector('#control-status')?.textContent ?? '';
      return audio.includes('audio=running') && audio.includes('active=1') && control.includes('playing=1');
    }, undefined, { timeout: 10_000 });
    const playing = await page.locator('#control-status').textContent();

    await page.keyboard.down('m');
    await page.waitForTimeout(250);
    await page.keyboard.up('m');
    await printStatus('after-mute');
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.includes('muted=1'), undefined, { timeout: 5_000 });
    const muted = await page.locator('#control-status').textContent();

    await page.keyboard.down('-');
    await page.waitForTimeout(250);
    await page.keyboard.up('-');
    await printStatus('after-volume-down');
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.includes('volume=0.70'), undefined, { timeout: 5_000 });
    const volume = await page.locator('#control-status').textContent();

    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await printStatus('after-stop-space');
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('active=0'), undefined, { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await printStatus('after-restart-space');
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('active=1'), undefined, { timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: afterPath });
    const restarted = await page.locator('#control-status').textContent();

    const stopped = await page.evaluate(() => window.__audioControlStop?.());
    if (!stopped || stopped.contextState !== 'closed' || stopped.activeSourceCount !== 0) throw new Error(`app.stop did not reclaim audio: ${JSON.stringify(stopped)}`);
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[smoke-browser] playing=${playing}`);
    console.log(`[smoke-browser] muted=${muted}`);
    console.log(`[smoke-browser] volume=${volume}`);
    console.log(`[smoke-browser] restarted=${restarted}`);
    console.log(`[smoke-browser] stopped=${JSON.stringify(stopped)}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log('[smoke-browser] PASS - Chrome played a real loop, toggled music mute and volume, stopped/restarted playback, and reclaimed the source.');
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
