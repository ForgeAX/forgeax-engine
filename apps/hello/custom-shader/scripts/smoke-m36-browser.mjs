#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { pnpmCommand } from '../../../../scripts/lib/pnpm-command.mjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';

const execFileAsync = promisify(execFile);
const APP = '@forgeax/hello-custom-shader';
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PATH = resolve(APP_ROOT, 'assets/pulse-material.pack.json');
const RECOOK_SCRIPT = resolve(APP_ROOT, 'scripts/recook-material-pack.mjs');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_MATERIAL_ARTIFACT_DIR ?? resolve(ROOT, '.forgeax-m36-artifacts'),
);

function waitForServer(server) {
  return new Promise((resolveServer, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (match) resolveServer(match[1]);
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${output}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function compareRegion(before, after, left, right, top, bottom) {
  assert(before.width === after.width && before.height === after.height, 'PNG dimensions changed');
  let changedPixels = 0;
  let absoluteDelta = 0;
  let pixels = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * before.width + x) * 4;
      const redDelta = Math.abs(before.data[offset] - after.data[offset]);
      const greenDelta = Math.abs(before.data[offset + 1] - after.data[offset + 1]);
      const blueDelta = Math.abs(before.data[offset + 2] - after.data[offset + 2]);
      if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels += 1;
      absoluteDelta += redDelta + greenDelta + blueDelta;
      pixels += 1;
    }
  }
  return {
    changedPixels,
    changedFraction: changedPixels / pixels,
    meanRgbDelta: absoluteDelta / (pixels * 3 * 255),
  };
}

mkdirSync(ARTIFACT_DIR, { recursive: true });
const originalFixture = readFileSync(FIXTURE_PATH);
const [manager, ...managerArgs] = pnpmCommand();
const vite = spawn(manager, [...managerArgs, '-F', APP, 'dev', '--', '--host', '127.0.0.1'], {
  cwd: ROOT,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopVite = createOwnedProcessGroupStopper(vite);
let browser;
try {
  const url = await waitForServer(vite);
  browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? undefined : 'chrome',
    args: process.platform === 'win32' ? resolveBrowserWebGpuLaunch().args : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const targetUrl = `${url}?m36=stale-recook`;
  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      globalThis.__forgeaxMaterialEvidence?.ready === true &&
      globalThis.__forgeaxMaterialEvidence.materialGeneration !== undefined,
    null,
    { timeout: 30000 },
  );
  await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.frameCount >= 4, null, {
    timeout: 30000,
  });
  const beforeEvidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
  const beforePath = resolve(ARTIFACT_DIR, 'm36-browser-before.png');
  await page.screenshot({ path: beforePath, fullPage: false });

  const stale = await page.evaluate(async () => {
    const control = globalThis.__forgeaxMaterialEvidence?.materialGeneration;
    if (control === undefined) throw new Error('M36 material generation control is unavailable');
    return control.runStale();
  });
  assert(stale.status === 'stale', `expected stale result, got ${stale.status}`);
  assert(stale.published === false, 'stale cooked material was published');
  assert(stale.sameWorld === true && stale.sameRenderer === true, 'stale path rebuilt live state');
  assert(stale.error?.code === 'material-specialization-stale-generation', 'stale code changed');
  assert(stale.error?.detail?.code === stale.error.code, 'stale detail code changed');
  assert(stale.error.detail.dependencies.length === 2, 'stale dependency set is incomplete');
  assert(
    JSON.stringify(stale.error.detail.observed) !== JSON.stringify(stale.error.detail.current),
    'stale observed/current vectors were equal',
  );
  writeFileSync(resolve(ARTIFACT_DIR, 'm36-browser-stale.json'), `${JSON.stringify(stale, null, 2)}\n`);
  const stalePath = resolve(ARTIFACT_DIR, 'm36-browser-stale.png');
  await page.screenshot({ path: stalePath, fullPage: false });

  const recook = await execFileAsync(process.execPath, [RECOOK_SCRIPT, '--write'], {
    cwd: ROOT,
    env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(
    resolve(ARTIFACT_DIR, 'm36-browser-producer.log'),
    `${recook.stdout}${recook.stderr}`,
  );
  const recookedFixture = readFileSync(FIXTURE_PATH);
  writeFileSync(resolve(ARTIFACT_DIR, 'm36-browser-recooked.pack.json'), recookedFixture);

  const fresh = await page.evaluate(async () => {
    const control = globalThis.__forgeaxMaterialEvidence?.materialGeneration;
    if (control === undefined) throw new Error('M36 material generation control is unavailable');
    return control.publishRecooked();
  });
  assert(fresh.status === 'fresh', `expected fresh result, got ${fresh.status}`);
  assert(fresh.published === true, 'fresh cooked material was not published');
  assert(fresh.oldArtifactDigest === stale.staleArtifactDigest, 'LKG identity changed before recook');
  assert(fresh.artifactDigest !== fresh.oldArtifactDigest, 'recook did not produce a fresh digest');
  assert(fresh.diagnostic === undefined, 'stale diagnostic survived a stable recook');
  assert(fresh.generation?.dependencies !== undefined, 'fresh generation vector was not reported');
  assert(fresh.sameWorld === true && fresh.sameRenderer === true, 'recook rebuilt live state');
  assert(fresh.allocationRelease?.ok === true, 'fresh shared-ref allocation was not released');
  const freshAgain = await page.evaluate(async () => {
    const control = globalThis.__forgeaxMaterialEvidence?.materialGeneration;
    if (control === undefined) throw new Error('M36 material generation control is unavailable');
    return control.publishRecooked();
  });
  assert(JSON.stringify(freshAgain) === JSON.stringify(fresh), 'recook cleanup was not idempotent');
  await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.frameCount >= 8, null, {
    timeout: 30000,
  });
  const afterPath = resolve(ARTIFACT_DIR, 'm36-browser-after.png');
  await page.screenshot({ path: afterPath, fullPage: false });
  writeFileSync(
    resolve(ARTIFACT_DIR, 'm36-browser-summary.json'),
    `${JSON.stringify({ beforeEvidence, stale, fresh, freshAgain, consoleErrors }, null, 2)}\n`,
  );

  const before = readPng(beforePath);
  const stalePng = readPng(stalePath);
  const after = readPng(afterPath);
  const siblingLkg = compareRegion(before, stalePng, 0, Math.floor(before.width / 2), 0, before.height);
  const siblingAfter = compareRegion(before, after, 0, Math.floor(before.width / 2), 0, before.height);
  const fullLkg = compareRegion(before, stalePng, 0, before.width, 0, before.height);
  const fullFresh = compareRegion(before, after, 0, before.width, 0, before.height);
  assert(siblingLkg.changedPixels === 0, `sibling LKG changed during stale refusal: ${JSON.stringify(siblingLkg)}`);
  assert(siblingAfter.meanRgbDelta <= 0.01, `sibling changed after recook: ${JSON.stringify(siblingAfter)}`);
  assert(fullLkg.meanRgbDelta <= 0.01, `LKG pixels changed during stale refusal: ${JSON.stringify(fullLkg)}`);
  assert(fullFresh.meanRgbDelta <= 0.01, `fresh recook pixels left semantic range: ${JSON.stringify(fullFresh)}`);
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`);
  console.log(
    JSON.stringify({
      status: 'pass',
      frontDoor: 'custom-shader same-page MaterialGenerationCache recook',
      url: targetUrl,
      stale,
      fresh,
      pixels: { siblingLkg, siblingAfter, fullLkg, fullFresh },
      screenshots: { beforePath, stalePath, afterPath },
    }),
  );
} catch (error) {
  console.error(`custom-shader M36 browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(FIXTURE_PATH, originalFixture);
  await browser?.close();
  await stopVite();
}
