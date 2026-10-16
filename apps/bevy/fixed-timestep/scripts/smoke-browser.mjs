#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const consoleErrors = [];
let vite;
let browser;
let stopping = false;
let appUrl;

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`[smoke] timed out waiting for ${label}`);
}

try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-fixed-timestep', 'dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stdout.on('data', (chunk) => {
    if (stopping) return;
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
    if (match?.[1] !== undefined) appUrl = match[1];
  });
  vite.stderr.on('data', (chunk) => {
    if (!stopping) process.stderr.write(`[vite-err] ${chunk}`);
  });

  await waitFor(() => appUrl !== undefined, 'Vite dev server');
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    const location = message.location();
    const line = `[browser] ${message.type()}: ${message.text()} ${location.url}`;
    process.stdout.write(`${line}\n`);
    if (message.type() === 'error' && !line.includes('favicon.ico')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      consoleErrors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor();
  await sleep(2_000);
  if (consoleErrors.length > 0) throw new Error(`[smoke] browser errors:\n${consoleErrors.join('\n')}`);
  console.log('[smoke] PASS - browser app started with no console errors');
} finally {
  await browser?.close();
  stopping = true;
  vite?.kill();
}
