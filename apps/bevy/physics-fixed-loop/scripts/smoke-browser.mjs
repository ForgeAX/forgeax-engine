#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(new URL('../../../../', import.meta.url).pathname);
const artifactDir = resolve(new URL('../artifacts/', import.meta.url).pathname);
mkdirSync(artifactDir, { recursive: true });
let vite;
let browser;
let url;
let stopping = false;
const errors = [];
try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-physics-fixed-loop', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  vite.stderr.on('data', (chunk) => { if (!stopping) process.stderr.write(`[vite-err] ${chunk}`); });
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(100);
  if (!url) throw new Error('Vite did not announce a local URL');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', (message) => {
    const location = message.location();
    if (message.type() === 'error' && !location.url.includes('favicon.ico')) errors.push(message.text());
  });
  page.on('pageerror', (error) => { if (!error.message.includes('favicon.ico')) errors.push(error.message); });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      const failure = `HTTP ${response.status()} ${response.url()}`;
      errors.push(failure);
      console.error(`[browser] ${failure}`);
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor();
  await sleep(2_000);
  await page.screenshot({ path: resolve(artifactDir, 'browser.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[smoke] PASS - browser app rendered without console errors');
} finally {
  await browser?.close();
  stopping = true;
  if (vite && vite.exitCode === null) {
    await new Promise((resolveExit) => {
      vite.once('exit', resolveExit);
      vite.once('error', resolveExit);
      vite.kill();
    });
  }
}
