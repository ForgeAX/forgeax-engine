#!/usr/bin/env node
// Real Chrome/Web Audio smoke for play_sound_effect.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifactDir = resolve(root, 'apps', 'bevy', 'play-sound-effect', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-play-sound-effect', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const beforePath = resolve(artifactDir, 'play-sound-effect-before.png');
    const afterPath = resolve(artifactDir, 'play-sound-effect-after.png');
    await page.screenshot({ path: beforePath });

    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.waitForTimeout(200);
    await page.waitForFunction(() => {
      const audio = document.querySelector('#audio-status')?.textContent ?? '';
      const trigger = document.querySelector('#trigger-status')?.textContent ?? '';
      return audio.includes('audio=running') && audio.includes('active=1') && trigger.includes('triggers=1');
    }, undefined, { timeout: 10_000 });
    const firstPlaying = await page.locator('#audio-status').textContent();
    await page.screenshot({ path: afterPath });
    await page.waitForTimeout(1_500);

    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.waitForTimeout(200);
    await page.waitForFunction(() => {
      const audio = document.querySelector('#audio-status')?.textContent ?? '';
      const trigger = document.querySelector('#trigger-status')?.textContent ?? '';
      const active = Number(audio.match(/active=(\d+)/)?.[1] ?? 0);
      return active >= 1 && trigger.includes('triggers=2');
    }, undefined, { timeout: 10_000 });
    const secondPlaying = await page.locator('#audio-status').textContent();
    const stoppedState = await page.evaluate(() => window.__playSoundEffectStop?.());
    if (!stoppedState || stoppedState.contextState !== 'closed' || stoppedState.activeSourceCount !== 0) throw new Error(`app.stop did not reclaim audio: ${JSON.stringify(stoppedState)}`);
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[smoke-browser] first=${firstPlaying}`);
    console.log(`[smoke-browser] second=${secondPlaying}`);
    console.log(`[smoke-browser] stopped=${JSON.stringify(stoppedState)}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log('[smoke-browser] PASS - Chrome gesture resumed AudioContext, two Space events played real one-shot audio, and ended sources were reclaimed.');
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
