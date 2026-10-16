#!/usr/bin/env node
// Real Chrome/Web Audio smoke for soundtrack.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = new URL('../../../..', import.meta.url).pathname;
const artifactDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const vite = spawn('pnpm', ['-F', '@forgeax/bevy-soundtrack', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.waitForFunction(() => document.querySelector('#audio-status')?.textContent?.includes('loaded=2/2'), undefined, { timeout: 15_000 });
    const beforePath = resolve(artifactDir, 'soundtrack-before.png');
    const afterPath = resolve(artifactDir, 'soundtrack-after.png');
    await page.screenshot({ path: beforePath });
    const printStatus = async (label) => console.log(`[smoke-browser] ${label} audio=${await page.locator('#audio-status').textContent()} control=${await page.locator('#control-status').textContent()}`);
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.waitForFunction(() => {
      const audio = document.querySelector('#audio-status')?.textContent ?? '';
      const control = document.querySelector('#control-status')?.textContent ?? '';
      return audio.includes('audio=running') && audio.includes('active=1') && control.includes('state=peaceful') && control.includes('peaceful=1.00');
    }, undefined, { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await printStatus('after-battle');
    await page.waitForFunction(() => {
      const audio = document.querySelector('#audio-status')?.textContent ?? '';
      const control = document.querySelector('#control-status')?.textContent ?? '';
      return audio.includes('audio=running') && audio.includes('active=1') && control.includes('state=battle') && control.includes('battle=1.00') && control.includes('peaceful=0.00');
    }, undefined, { timeout: 10_000 });
    const battle = await page.locator('#control-status').textContent();
    await page.waitForTimeout(500);
    await page.screenshot({ path: afterPath });

    const stopped = await page.evaluate(() => window.__soundtrackStop?.());
    if (!stopped || stopped.contextState !== 'closed' || stopped.activeSourceCount !== 0) throw new Error(`app.stop did not reclaim soundtrack audio: ${JSON.stringify(stopped)}`);
    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[smoke-browser] battle=${battle}`);
    console.log(`[smoke-browser] stopped=${JSON.stringify(stopped)}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log('[smoke-browser] PASS - Chrome played real soundtrack clips, crossed from peaceful to battle, and reclaimed both sources.');
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
