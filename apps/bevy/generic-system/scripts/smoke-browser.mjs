#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const errors = [];
let vite;
let browser;
let appUrl;
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`[smoke] timed out waiting for ${label}`);
};

try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-generic-system', 'dev'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    appUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  await waitFor(() => appUrl !== undefined, 'Vite dev server');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname !== '/favicon.ico') errors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => Boolean(globalThis.__bevyGenericSystemReady)), 'generic system app');
  await sleep(2_500);
  const state = await page.evaluate(() => globalThis.__bevyGenericSystemState?.());
  if (errors.length > 0) console.log(`[smoke] browser diagnostics=${JSON.stringify(errors)}`);
  if (errors.length > 0) throw new Error(`[smoke] browser errors:\n${errors.join('\n')}`);
  if (!state || state.cleanupLog.join(',') !== 'menu-close,level-unload' || state.remaining !== 1) {
    throw new Error(`[smoke] invalid state: ${JSON.stringify(state)}`);
  }
  console.log(`[smoke] PASS - browser generic cleanup order=${state.cleanupLog.join(' -> ')}, remaining=${state.remaining}`);
} finally {
  await browser?.close();
  vite?.kill();
}
