#!/usr/bin/env node
// Browser proof for the query-gated game-default local-coordinate axes overlay.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_AXES_EVIDENCE_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/axes'));
const PORT = Number.parseInt(process.env.FORGEAX_AXES_EVIDENCE_PORT ?? '5188', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
process.on('exit', () => server.kill('SIGTERM'));

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?debug-axes=1`, { waitUntil: 'networkidle', timeout: 2_000 });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
    await sleep(250);
  }
}
await page.waitForTimeout(2_000);

await page.goto(`http://127.0.0.1:${PORT}/?debug-axes=0`, { waitUntil: 'networkidle', timeout: 5_000 });
await page.waitForTimeout(500);
const disabled = await page.evaluate(() => globalThis.__forgeaxGameDefaultAxesEvidence === undefined);
if (!disabled) throw new Error('debug-axes overlay ignored its query gate');
await page.goto(`http://127.0.0.1:${PORT}/?debug-axes=1`, { waitUntil: 'networkidle', timeout: 5_000 });
await page.waitForTimeout(2_000);

const beforeReset = await page.evaluate(() => {
  const evidence = globalThis.__forgeaxGameDefaultAxesEvidence;
  if (!evidence) throw new Error('debug-axes evidence handle was not installed');
  return evidence.snapshot();
});
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));
await page.waitForTimeout(100);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r', bubbles: true })));
await page.waitForFunction(() => globalThis.__forgeaxGameDefaultAxesEvidence?.snapshot().resetCount >= 1, undefined, { timeout: 2_000 });
await page.waitForTimeout(100);
const afterReset = await page.evaluate(() => globalThis.__forgeaxGameDefaultAxesEvidence.snapshot());
const screenshot = resolve(ARTIFACT_DIR, 'axes-overlay.png');
await page.screenshot({ path: screenshot });
const report = { beforeReset, afterReset, screenshot, pageErrors, consoleErrors: consoleErrors.filter((line) => !line.includes('favicon')) };
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

try {
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (report.consoleErrors.length > 0) throw new Error(`console errors: ${report.consoleErrors.join(' | ')}`);
  if (!beforeReset.enabled || !beforeReset.available || beforeReset.axesCalls < beforeReset.liveTargets || beforeReset.aabbCalls < beforeReset.liveTargets || beforeReset.frustumCalls < 1 || !beforeReset.cameraReady) {
    throw new Error(`axes overlay did not draw live targets: ${JSON.stringify({ beforeReset })}`);
  }
  if (afterReset.resetCount < 1 || afterReset.axesCalls < afterReset.liveTargets || afterReset.aabbCalls < afterReset.liveTargets || afterReset.frustumCalls < 1) {
    throw new Error(`axes overlay did not recover after reset: ${JSON.stringify({ afterReset })}`);
  }
  console.log(`[debug-axes] PASS enabled=${beforeReset.enabled} calls=${beforeReset.axesCalls} resetCount=${afterReset.resetCount} recoveredCalls=${afterReset.axesCalls}`);
  console.log(`[debug-axes] screenshot=${screenshot}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
