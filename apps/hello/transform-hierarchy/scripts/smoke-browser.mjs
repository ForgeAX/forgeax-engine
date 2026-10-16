#!/usr/bin/env node
// M23 real Chrome journey: use the app's test-owned internal fixture to stage
// malformed ChildOf edges, observe structured diagnostics, repair them in the
// same World, and compare rendered frames. Public World.set remains closed to
// malformed relationship writes.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createReceipt } from './dataflow-receipt.mjs';

if (process.argv.includes('--receipt')) {
  console.log(JSON.stringify(createReceipt({
    workloadId: 'hierarchy-dynamic',
    backend: 'unavailable',
    reasonCode: 'browser-probe-not-run',
    detail: 'Receipt-only mode does not start a dev server or browser.',
    retryHint: 'Run this script without --receipt on a Chrome WebGPU runner.',
  }), null, 2));
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm23-browser'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const vite = spawn('pnpm', ['-F', '@forgeax/hello-transform-hierarchy', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function diagnosticsFor(snapshot, code) {
  return snapshot.diagnostics.filter((item) => item.code === code);
}

try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('Vite did not publish a URL in 30s');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
    });

    await page.goto(`${url}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => typeof globalThis.__forgeaxTransformHierarchy?.beginProbe === 'function',
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(500);

    const baselineState = await page.evaluate(() => globalThis.__forgeaxTransformHierarchy.beginProbe());
    const baselinePath = resolve(ARTIFACT_DIR, 'baseline.png');
    const baselinePng = await page.locator('#app').screenshot({ path: baselinePath });
    assert(baselineState.diagnostics.length === 0, `baseline diagnostics: ${JSON.stringify(baselineState)}`);

    const fault = await page.evaluate(() => globalThis.__forgeaxTransformHierarchy.injectFaults());
    const faultPath = resolve(ARTIFACT_DIR, 'fault.png');
    const faultPng = await page.locator('#app').screenshot({ path: faultPath });
    const broken = diagnosticsFor(fault.snapshot, 'hierarchy-broken');
    const cycles = diagnosticsFor(fault.snapshot, 'hierarchy-cycle');
    const cycleMembers = cycles.map((item) => item.detail.entity).sort((a, b) => a - b);
    const expectedCycleMembers = [fault.snapshot.entities.cycleA, fault.snapshot.entities.cycleB].sort((a, b) => a - b);
    assert(fault.propagation.ok === false, `fault propagation unexpectedly succeeded: ${JSON.stringify(fault)}`);
    assert(broken.length === 1, `expected one stale-edge diagnostic: ${JSON.stringify(fault.snapshot.diagnostics)}`);
    assert(broken[0].detail.entity === fault.snapshot.entities.child, 'stale diagnostic named the wrong entity');
    assert(broken[0].expected.length > 0 && broken[0].hint.length > 0, 'stale diagnostic lost recovery fields');
    assert(cycles.length === 2, `expected two cycle diagnostics: ${JSON.stringify(fault.snapshot.diagnostics)}`);
    assert(JSON.stringify(cycleMembers) === JSON.stringify(expectedCycleMembers), 'cycle membership is not deterministic');
    assert(cycles.every((item) => item.expected.length > 0 && item.hint.length > 0 && item.detail.parent !== undefined), 'cycle diagnostic is incomplete');
    assert(fault.snapshot.projectionId !== baselineState.projectionId, 'fault projection reused the healthy cache');

    const repair = await page.evaluate(() => globalThis.__forgeaxTransformHierarchy.repairFaults());
    const repairedPath = resolve(ARTIFACT_DIR, 'repaired.png');
    const repairedPng = await page.locator('#app').screenshot({ path: repairedPath });
    assert(repair.propagation.ok === true, `repair propagation failed: ${JSON.stringify(repair)}`);
    assert(repair.snapshot.diagnostics.length === 0, `repair left diagnostics: ${JSON.stringify(repair)}`);
    assert(repair.snapshot.projectionId !== fault.snapshot.projectionId, 'repair reused the fault projection');
    assert(repair.snapshot.child?.world?.every((value, index) => Math.abs(value - (baselineState.child?.world?.[index] ?? NaN)) < 1e-6), 'child world did not recover');
    assert(repair.snapshot.staticSphere?.world?.every((value, index) => Math.abs(value - (baselineState.staticSphere?.world?.[index] ?? NaN)) < 1e-6), 'static sibling world was contaminated');

    const cleanup = await page.evaluate(() => globalThis.__forgeaxTransformHierarchy.cleanup());
    assert(cleanup.propagation.ok === true && cleanup.snapshot.diagnostics.length === 0, `repeated cleanup failed: ${JSON.stringify(cleanup)}`);
    assert(cleanup.repairs.every((item) => item.changed === false), `cleanup was not idempotent: ${JSON.stringify(cleanup.repairs)}`);
    assert(cleanup.snapshot.projectionId === repair.snapshot.projectionId, 'idempotent cleanup changed the projection');

    const baselineHash = hash(baselinePng);
    const faultHash = hash(faultPng);
    const repairedHash = hash(repairedPng);
    assert(faultHash !== baselineHash, 'fault frame did not change the rendered child');
    assert(repairedHash === baselineHash, 'same-process repair did not restore the baseline pixels');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    const expectedConsoleDiagnostics = consoleErrors.filter((line) => line.includes('[SceneError hierarchy-broken]'));
    const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('[SceneError hierarchy-broken]'));
    assert(expectedConsoleDiagnostics.length >= 1, 'fault render did not surface its structured SceneError through the host error channel');
    assert(unexpectedConsoleErrors.length === 0, `unexpected console errors: ${unexpectedConsoleErrors.join(' | ')}`);

    const evidence = {
      baseline: baselineState,
      fault,
      repair,
      cleanup,
      pixels: {
        baseline: { path: baselinePath, sha256: baselineHash },
        fault: { path: faultPath, sha256: faultHash },
        repaired: { path: repairedPath, sha256: repairedHash },
      },
      pageErrors,
      consoleErrors,
      expectedConsoleDiagnostics,
    };
    writeFileSync(resolve(ARTIFACT_DIR, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`[m23] Browser structured hierarchy recovery: PASS baseline=${baselineHash} fault=${faultHash} repaired=${repairedHash}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[m23] Browser structured hierarchy recovery: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  vite.kill('SIGTERM');
  await sleep(300);
}
