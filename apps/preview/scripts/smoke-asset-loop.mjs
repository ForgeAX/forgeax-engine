#!/usr/bin/env node
// game-default asset loop smoke: GUID -> importer -> pack -> runtime -> IBL.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_ASSET_LOOP_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/asset-loop'),
);
const PORT = Number.parseInt(process.env.FORGEAX_ASSET_LOOP_PORT ?? '5194', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const production = process.env.FORGEAX_ASSET_LOOP_MODE === 'production';
const server = spawn(
  'pnpm',
  production
    ? ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
    : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
let browser;
let page;
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];

async function snapshot(name) {
  const path = resolve(ARTIFACT_DIR, `${name}.png`);
  let previous;
  let stableFrames = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const buffer = await page.screenshot();
    const png = PNG.sync.read(buffer);
    const changed = previous === undefined
      ? Number.POSITIVE_INFINITY
      : pixelmatch(previous.data, png.data, undefined, png.width, png.height, { threshold: 0.1 });
    stableFrames = changed <= 8 ? stableFrames + 1 : 0;
    if (stableFrames >= 2) {
      writeFileSync(path, buffer);
      return { path, width: png.width, height: png.height, data: png.data };
    }
    previous = png;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  }
  throw new Error(`render did not stabilize before ${name}`);
}

try {
  const serverDeadline = Date.now() + 30_000;
  while (Date.now() < serverDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= serverDeadline) throw new Error(`Preview server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&asset-evidence=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => globalThis.__forgeaxGameDefaultAssetEvidence !== undefined,
    null,
    { timeout: 30_000, polling: 100 },
  );
  await page.waitForFunction(
    () => globalThis.__forgeaxGameDefaultAssetEvidence?.snapshot().load.ok ?? false,
    null,
    { timeout: 30_000, polling: 100 },
  );
  const read = () => page.evaluate(async () => {
    const evidence = globalThis.__forgeaxGameDefaultAssetEvidence;
    if (!evidence) throw new Error('asset evidence handle was not installed');
    await evidence.ready;
    return evidence.snapshot();
  });
  const baselineState = await read();
  const baseline = await snapshot('baseline');

  const brightState = await page.evaluate(() => {
    const evidence = globalThis.__forgeaxGameDefaultAssetEvidence;
    evidence.setIntensity(1.4);
    return evidence.snapshot();
  });
  const bright = await snapshot('bright-environment');

  const reloadState = await page.evaluate(async () => {
    const evidence = globalThis.__forgeaxGameDefaultAssetEvidence;
    const reloaded = await evidence.reload();
    const missing = await evidence.probeMissing();
    return { reloaded, missing, snapshot: evidence.snapshot() };
  });
  const reloaded = await snapshot('reloaded-environment');

  const resetState = await page.evaluate(() => {
    const evidence = globalThis.__forgeaxGameDefaultAssetEvidence;
    evidence.reset();
    return evidence.snapshot();
  });
  const reset = await snapshot('reset-environment');

  const changedPixels = (a, b) => pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  const expectedMissingResponses = badResponses.filter((line) => line.includes('/__import/00000000-0000-4000-8000-000000000000'));
  const unexpectedBadResponses = badResponses.filter((line) => !line.includes('/__import/00000000-0000-4000-8000-000000000000'));
  const expectedMissingConsoleErrors = consoleErrors.filter((line) => line.includes('Failed to load resource'));
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('Failed to load resource'));
  const report = {
    oracle: 'HDR equirect payload is loaded by GUID, intensity changes the IBL frame, invalidate+reload restores the payload, and a missing GUID returns a structured error in the same process',
    artifacts: {
      baseline: baseline.path,
      bright: bright.path,
      reloaded: reloaded.path,
      reset: reset.path,
    },
    semantic: { baselineState, brightState, reloadState, resetState },
    pixel: {
      brightDelta: changedPixels(baseline, bright),
      reloadDelta: changedPixels(baseline, reloaded),
      resetDelta: changedPixels(baseline, reset),
    },
    rhi: { features: baselineState.features },
    mode: production ? 'production' : 'dev',
    pageErrors,
    consoleErrors: unexpectedConsoleErrors,
    badResponses: unexpectedBadResponses,
    expectedMissing: { consoleErrors: expectedMissingConsoleErrors, responses: expectedMissingResponses },
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (unexpectedConsoleErrors.length > 0) throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  if (unexpectedBadResponses.length > 0) throw new Error(`bad responses: ${unexpectedBadResponses.join(' | ')}`);
  if (!baselineState.load.ok || baselineState.load.kind !== 'equirect' || baselineState.load.format !== 'rgba16float') throw new Error(`HDR payload witness failed: ${JSON.stringify(baselineState)}`);
  if (baselineState.name !== 'sky.hdr' || !Array.isArray(baselineState.features)) throw new Error(`HDR identity/inspection witness failed: ${JSON.stringify(baselineState)}`);
  if (!reloadState.reloaded.ok || reloadState.snapshot.reloads !== 1) throw new Error(`reload failed: ${JSON.stringify(reloadState)}`);
  if (reloadState.missing.ok || typeof reloadState.missing.code !== 'string') throw new Error(`missing-asset recovery failed: ${JSON.stringify(reloadState)}`);
  if (report.pixel.brightDelta < 20) throw new Error(`environment intensity changed only ${report.pixel.brightDelta} pixels`);
  if (report.pixel.resetDelta > 500) throw new Error(`reset drifted ${report.pixel.resetDelta} pixels from baseline`);
  console.log(`[asset-loop] PASS mode=${production ? 'production' : 'dev'} brightDelta=${report.pixel.brightDelta} reloadDelta=${report.pixel.reloadDelta} resetDelta=${report.pixel.resetDelta} missing=${reloadState.missing.code}`);
  console.log(`[asset-loop] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser?.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await sleep(300);
}
