#!/usr/bin/env node
import { decodeCatalogWire } from '@forgeax/engine-pack';
// game-default production material-edit smoke: authored sidecar -> build pack -> runtime.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FIXTURE = resolve(ROOT, 'apps/game-capability-lab/assets/base-material.pack.json');
const GUID = 'eb5bf6e6-2e47-4d9a-99fd-81843228c9b3';
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_PRODUCTION_MATERIAL_EDIT_DIR ?? resolve(ROOT, '.forgeax-debug/production-material-edit'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });
const targetColor = [0.12, 0.82, 0.24, 1];

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a TCP port');
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    probe.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

function run(command, args, logPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      writeFileSync(logPath, output);
      if (code === 0) resolvePromise({ output, code, signal });
      else reject(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}\n${output}`));
    });
  });
}

async function build(label) {
  return run('pnpm', ['--dir', ROOT, 'build:app', 'preview'], resolve(ARTIFACT_DIR, `build-${label}.log`));
}

async function stopProduction(server) {
  if (server?.pid === undefined) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await sleep(300);
}

async function stableScreenshot(page, path) {
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
    await page.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => resolvePromise())));
  }
  throw new Error(`production screenshot did not stabilize: ${path}`);
}

async function capture(label, browser) {
  const port = await availablePort();
  const server = spawn(
    'pnpm',
    ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) break;
      } catch {
        // The preview process is still starting.
      }
      await sleep(250);
    }
    if (Date.now() >= deadline) throw new Error(`production Preview did not start: ${serverOutput}`);
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
    });
    const origin = `http://127.0.0.1:${port}`;
    await page.goto(`${origin}/?game=game-default&asset-evidence=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => globalThis.__forgeaxGameDefaultAssetEvidence !== undefined, null, { timeout: 30_000 });
    await page.waitForFunction(() => globalThis.__forgeaxGameDefaultAssetEvidence?.snapshot().load.ok ?? false, null, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const listed = globalThis.__forgeaxPreviewInspection?.list();
      return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
    }, null, { timeout: 30_000 });
    const indexWire = await page.evaluate(async () => {
      const indexResponse = await fetch('/pack-index.json');
      if (!indexResponse.ok) throw new Error(`pack-index status=${indexResponse.status}`);
      return indexResponse.json();
    });
    const row = decodeCatalogWire(indexWire).unwrap().find((entry) => entry.guid === GUID);
    if (!row) throw new Error(`material GUID ${GUID} missing from production pack-index`);
    const pack = await page.evaluate(async ({ guid, row }) => {
      const packageResponse = await fetch(row.packageUrl);
      if (!packageResponse.ok) throw new Error(`material package status=${packageResponse.status}`);
      const packageJson = await packageResponse.json();
      const asset = (packageJson.assets ?? []).find((entry) => entry.guid === guid) ?? packageJson;
      const values = asset.payload?.values ?? asset.values;
      return { guid: row.guid, name: row.name, packageUrl: row.packageUrl, baseColor: values?.baseColor ?? null };
    }, { guid: GUID, row: { guid: row.guid, name: row.name, packageUrl: row.packageUrl } });
    const game = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
    if (!game?.ok || game.value.state.phase !== 'Play') throw new Error(`game snapshot is not Play: ${JSON.stringify(game)}`);
    const screenshot = await stableScreenshot(page, resolve(ARTIFACT_DIR, `${label}.png`));
    await page.close();
    return { label, pack, game, screenshot, pageErrors, consoleErrors, badResponses, serverOutput };
  } finally {
    await stopProduction(server);
  }
}

const original = await readFile(FIXTURE, 'utf8');
let browser;
try {
  await build('baseline');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const baseline = await capture('baseline', browser);
  await browser.close();
  browser = undefined;

  const marker = /("baseColor"\s*:\s*\[)[^\]]+(\])/;
  if (!marker.test(original)) throw new Error('production material fixture marker is absent');
  await writeFile(FIXTURE, original.replace(marker, (_match, prefix, suffix) => `${prefix}${targetColor.join(', ')}${suffix}`));
  await build('changed');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const changed = await capture('changed', browser);
  const pixelDelta = pixelmatch(
    baseline.screenshot.data,
    changed.screenshot.data,
    undefined,
    baseline.screenshot.width,
    baseline.screenshot.height,
    { threshold: 0.1 },
  );
  const report = {
    oracle: 'authored base-material sidecar edit changes the production Pack v2 payload and visible game-default runtime',
    source: FIXTURE,
    baseline: { pack: baseline.pack, game: baseline.game, errors: { page: baseline.pageErrors, console: baseline.consoleErrors, responses: baseline.badResponses }, screenshot: baseline.screenshot.path },
    changed: { pack: changed.pack, game: changed.game, errors: { page: changed.pageErrors, console: changed.consoleErrors, responses: changed.badResponses }, screenshot: changed.screenshot.path },
    pixelDelta,
    targetColor,
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const run of [baseline, changed]) {
    if (run.pageErrors.length > 0) throw new Error(`${run.label} page errors: ${run.pageErrors.join(' | ')}`);
    if (run.consoleErrors.length > 0) throw new Error(`${run.label} console errors: ${run.consoleErrors.join(' | ')}`);
    if (run.badResponses.length > 0) throw new Error(`${run.label} bad responses: ${run.badResponses.join(' | ')}`);
    if (run.pack.guid !== GUID || run.pack.name !== 'base-material.pack.json') throw new Error(`${run.label} material identity failed: ${JSON.stringify(run.pack)}`);
  }
  if (JSON.stringify(baseline.pack.baseColor) === JSON.stringify(changed.pack.baseColor)) throw new Error(`production pack payload stayed unchanged: ${JSON.stringify(changed.pack)}`);
  if (JSON.stringify(changed.pack.baseColor) !== JSON.stringify(targetColor)) throw new Error(`changed production payload is wrong: ${JSON.stringify(changed.pack)}`);
  if (pixelDelta < 10) throw new Error(`material edit changed only ${pixelDelta} pixels`);
  console.log(`[production-material-edit] PASS payloadChanged=true pixelDelta=${pixelDelta} pageErrors=0`);
  console.log(`[production-material-edit] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser?.close();
  await writeFile(FIXTURE, original);
  try {
    await build('restore');
  } catch (error) {
    writeFileSync(resolve(ARTIFACT_DIR, 'restore-build-error.txt'), String(error));
    throw error;
  }
}
