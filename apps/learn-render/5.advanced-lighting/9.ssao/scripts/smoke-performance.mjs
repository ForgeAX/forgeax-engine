#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { resolveBrowserWebGpuLaunch } from '../../../../shared/scripts/rhi-debug-verify.mjs';
import { createOwnedProcessGroupStopper } from '../../../../shared/scripts/rhi-debug-process.mjs';

// GPU query observations are measured live. Pixel capture/replay has its own gate.
const appDir = resolve(import.meta.dirname, '..');
const vite = spawn('pnpm', ['dev'], {
  cwd: appDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '0' },
});
const stop = createOwnedProcessGroupStopper(vite);
let output = '', url, spawnError;
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', chunk => {
  output = (output + chunk).slice(-8000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  url ??= output.match(/Local:\s+(https?:\/\/[^\s]+)/)?.[1];
});
vite.on('error', error => { spawnError = error; });
let browser;
try {
  const deadline = Date.now() + 180_000;
  while (!url && !spawnError && vite.exitCode === null && Date.now() < deadline) await sleep(100);
  if (!url) throw new Error(`Vite startup failed: ${spawnError ?? output}`);
  const launch = resolveBrowserWebGpuLaunch();
  browser = await chromium.launch({ headless: true, args: launch.args, chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('response', response => { if (response.status() >= 400) console.error(`HTTP ${response.status()} ${response.url()}`); });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.goto(`${url}?timings`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForFunction(() => typeof globalThis.__measureSsao === 'function', undefined, { timeout: 90_000 });
  const report = await page.evaluate(async () => {
    globalThis.__learnRenderErrors = [];
    const report = await globalThis.__measureSsao();
    if (globalThis.__learnRenderErrors.length) throw new Error(JSON.stringify(globalThis.__learnRenderErrors));
    return report;
  });
  if (errors.length) throw new Error(JSON.stringify(errors));
  const directory = resolve(appDir, '.forgeax-debug');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'ssao-performance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ssaoPerformance: report }));
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await browser?.close();
  await stop();
}
