#!/usr/bin/env node
import { once } from 'node:events';
import { decodeCatalogWire } from '@forgeax/engine-pack';
// game-default production UI edit smoke: authored pack -> build cache -> Pack v2 -> DOM.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FIXTURE = resolve(ROOT, 'apps/game-capability-lab/assets/ui/hud.pack.json');
const GUID = '019f8354-6386-4386-849d-f2ab4b96229c';
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_PRODUCTION_UI_EDIT_DIR ?? resolve(ROOT, '.forgeax-debug/production-ui-edit'),
);
const ORIGINAL_TEXT = 'Settings';
const CHANGED_TEXT = 'Options';
mkdirSync(ARTIFACT_DIR, { recursive: true });

async function availablePort() {
  const probe = createNetServer();
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a TCP port');
  const port = address.port;
  await new Promise((resolvePromise, reject) => probe.close((error) => (error ? reject(error) : resolvePromise())));
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
  throw new Error(`production UI screenshot did not stabilize: ${path}`);
}

async function capture(label, expectedScore, browser) {
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
        // The production server is still starting.
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
    await page.goto(`${origin}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const listed = globalThis.__forgeaxPreviewInspection?.list();
      const root = document.querySelector('[data-forgeax-ui-root]');
      const hud = root?.querySelector('[data-ui-asset="019f8354-6386-4386-849d-f2ab4b96229c"]');
      return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2 && hud?.shadowRoot !== null;
    }, null, { timeout: 30_000 });
    const indexWire = await page.evaluate(async () => (await fetch('/pack-index.json')).json());
    const row = decodeCatalogWire(indexWire).unwrap().find((entry) => entry.guid === GUID && entry.kind === 'ui');
    if (!row) throw new Error(`HUD UI row ${GUID} missing from production pack-index`);
    const pack = await page.evaluate(async ({ guid, row }) => {
      const packageResponse = await fetch(row.packageUrl);
      if (!packageResponse.ok) throw new Error(`HUD package status=${packageResponse.status}`);
      const packageJson = await packageResponse.json();
      const asset = (packageJson.assets ?? []).find((entry) => entry.guid === guid);
      if (!asset?.payload || asset.kind !== 'ui') throw new Error('HUD Pack v2 payload is not a UiAsset');
      return {
        guid: row.guid,
        name: row.name,
        packageUrl: row.packageUrl,
        lifecycle: row.lifecycle,
        html: asset.payload.html,
        cssBytes: asset.payload.css.length,
      };
    }, { guid: GUID, row: { guid: row.guid, name: row.name, packageUrl: row.packageUrl, lifecycle: row.lifecycle } });
    const settingsLabel = await page.evaluate(() => {
      const root = document.querySelector('[data-forgeax-ui-root]');
      const hud = root?.querySelector('[data-ui-asset="019f8354-6386-4386-849d-f2ab4b96229c"]');
      return hud?.shadowRoot?.querySelector('[data-ui-action="open-settings"]')?.textContent ?? '';
    });
    if (!settingsLabel.includes(expectedScore)) {
      throw new Error(`HUD runtime label drifted: expected=${expectedScore} actual=${settingsLabel}`);
    }
    const game = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
    if (!game?.ok || game.value.state.phase !== 'Play') throw new Error(`game snapshot is not Play: ${JSON.stringify(game)}`);
    const screenshot = await stableScreenshot(page, resolve(ARTIFACT_DIR, `${label}.png`));
    await page.close();
    return { label, pack, settingsLabel, game, screenshot, pageErrors, consoleErrors, badResponses, serverOutput };
  } finally {
    await stopProduction(server);
  }
}

const original = await readFile(FIXTURE, 'utf8');
if (!original.includes(ORIGINAL_TEXT)) throw new Error('HUD source settings marker is absent');
let browser;
let changed = false;
let restoreCompleted = false;
try {
  const buildResults = [];
  buildResults.push({ label: 'baseline', ...(await build('baseline')) });
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const baseline = await capture('baseline', ORIGINAL_TEXT, browser);
  await browser.close();
  browser = undefined;

  changed = true;
  const edited = original.replace(ORIGINAL_TEXT, CHANGED_TEXT);
  await writeFile(FIXTURE, edited);
  buildResults.push({ label: 'changed', ...(await build('changed')) });
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const changedRun = await capture('changed', CHANGED_TEXT, browser);
  await browser.close();
  browser = undefined;

  const pixelDelta = pixelmatch(
    baseline.screenshot.data,
    changedRun.screenshot.data,
    undefined,
    baseline.screenshot.width,
    baseline.screenshot.height,
    { threshold: 0.1 },
  );
  await writeFile(FIXTURE, original);
  buildResults.push({ label: 'restore', ...(await build('restore')) });
  restoreCompleted = true;
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const restored = await capture('restore', ORIGINAL_TEXT, browser);
  await browser.close();
  browser = undefined;
  const report = {
    oracle: 'authored HUD UiAsset edit changes the production Pack v2 payload, URL, and visible game-default DOM',
    source: FIXTURE,
    baseline: { pack: { ...baseline.pack, html: undefined }, settingsLabel: baseline.settingsLabel, screenshot: baseline.screenshot.path },
    changed: { pack: { ...changedRun.pack, html: undefined }, settingsLabel: changedRun.settingsLabel, screenshot: changedRun.screenshot.path },
    restored: { pack: { ...restored.pack, html: undefined }, settingsLabel: restored.settingsLabel, screenshot: restored.screenshot.path },
    pixelDelta,
    builds: buildResults.map(({ label, output }) => ({ label, rebuilt: /\[build-apps\] 1 built, 0 skipped/.test(output) })),
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const run of [baseline, changedRun, restored]) {
    if (run.pageErrors.length > 0) throw new Error(`${run.label} page errors: ${run.pageErrors.join(' | ')}`);
    if (run.consoleErrors.length > 0) throw new Error(`${run.label} console errors: ${run.consoleErrors.join(' | ')}`);
    if (run.badResponses.length > 0) throw new Error(`${run.label} bad responses: ${run.badResponses.join(' | ')}`);
    if (run.pack.guid !== GUID || run.pack.name !== 'hud.pack.json' || run.pack.lifecycle !== 'current') throw new Error(`${run.label} HUD identity failed: ${JSON.stringify(run.pack)}`);
  }
  if (baseline.pack.html === changedRun.pack.html) throw new Error('production HUD Pack payload stayed unchanged');
  if (!changedRun.pack.html.includes(CHANGED_TEXT)) throw new Error('changed production HUD payload missed edited label');
  if (baseline.pack.packageUrl === changedRun.pack.packageUrl) throw new Error('production HUD package URL stayed unchanged');
  if (restored.pack.html !== baseline.pack.html || restored.pack.packageUrl !== baseline.pack.packageUrl || restored.settingsLabel !== baseline.settingsLabel) {
    throw new Error('restored production HUD did not return to the baseline payload/runtime');
  }
  if (pixelDelta < 1) throw new Error(`HUD edit changed only ${pixelDelta} pixels`);
  const changedBuild = buildResults.find(({ label }) => label === 'changed');
  if (changedBuild === undefined || !/\[build-apps\] 1 built, 0 skipped/.test(changedBuild.output)) {
    throw new Error('changed UI edit build was a cache hit');
  }
  console.log(`[production-ui-edit] PASS payloadChanged=true packageChanged=true pixelDelta=${pixelDelta} pageErrors=0`);
  console.log(`[production-ui-edit] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser?.close();
  await writeFile(FIXTURE, original);
  if (changed && !restoreCompleted) {
    try {
      await build('restore');
    } catch (error) {
      writeFileSync(resolve(ARTIFACT_DIR, 'restore-build-error.txt'), String(error));
      throw error;
    }
  }
  writeFileSync(resolve(ARTIFACT_DIR, 'source-restored.txt'), `${(await readFile(FIXTURE, 'utf8')) === original}\n`);
}
