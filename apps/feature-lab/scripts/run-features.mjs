#!/usr/bin/env node
// Feature Lab runner: boots every feature (or those matching FEATURE_LAB_FILTER)
// in a fresh page, then
//   - visual: screenshots ON and OFF after FEATURE_LAB_FRAMES frames and requires
//     a mean per-pixel difference above FEATURE_LAB_MIN_DIFF (the falsifier: a
//     toggle that changes nothing fails);
//   - probe / headless: requires every structured check to pass;
//   - knownIssue: requires the feature to still fail (verdict 'known-issue') and
//     fails once it passes, so the engine fix removes the flag.
// Writes artifacts/feature-lab/report.json plus ON/OFF PNGs per visual feature.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(appRoot, 'artifacts', 'feature-lab');
const frames = Number(process.env.FEATURE_LAB_FRAMES ?? 60);
const minDiff = Number(process.env.FEATURE_LAB_MIN_DIFF ?? 0.004);
const filter = process.env.FEATURE_LAB_FILTER ?? '';
const bootTimeout = Number(process.env.FEATURE_LAB_BOOT_TIMEOUT_MS ?? 180_000);
const loadTimeout = Number(process.env.FEATURE_LAB_LOAD_TIMEOUT_MS ?? 60_000);

mkdirSync(outDir, { recursive: true });

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolvePort(String(address.port)));
    });
  });
}

async function waitForServer(url, server) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited with ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite dev server did not start within 300s');
}

function meanDiff(a, b) {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  if (left.width !== right.width || left.height !== right.height) return 1;
  let sum = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    sum += Math.abs(left.data[i] - right.data[i]);
    sum += Math.abs(left.data[i + 1] - right.data[i + 1]);
    sum += Math.abs(left.data[i + 2] - right.data[i + 2]);
  }
  return sum / ((left.data.length / 4) * 3 * 255);
}

async function waitFrames(page, count) {
  await page.waitForFunction((target) => (window.__featureLab?.frame ?? 0) >= target, (await page.evaluate(() => window.__featureLab?.frame ?? 0)) + count, {
    timeout: bootTimeout,
  });
}

async function runFeature(browser, baseUrl, feature) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 720 } });
  // A feature run must not be reloaded by unrelated source edits on a shared dev server.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (String(protocols).includes('vite-hmr')) {
        return { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
      }
      return new Native(url, protocols);
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  const result = { id: feature.id, kind: feature.kind, catalog: feature.catalog, verdict: 'fail', checks: [], errors: pageErrors };
  try {
    await page.goto(`${baseUrl}/?f=${feature.id}`, { waitUntil: 'domcontentloaded', timeout: loadTimeout });
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__featureLab?.state), undefined, { timeout: bootTimeout });
    const state = await page.evaluate(() => ({ state: window.__featureLab.state, error: window.__featureLab.error }));
    if (state.state === 'failed') throw new Error(state.error ?? 'setup failed');
    const failures = [];
    if (feature.kind === 'visual') {
      const canvas = page.locator('#app');
      await waitFrames(page, frames);
      const on = await canvas.screenshot();
      const toggled = await page.evaluate(() => window.__featureLab.toggle(false));
      if (!toggled) failures.push('visual feature has no toggle');
      await waitFrames(page, Math.max(10, Math.floor(frames / 3)));
      const off = await canvas.screenshot();
      await page.evaluate(() => window.__featureLab.toggle(true));
      await waitFrames(page, 3);
      const slug = feature.id.replace('/', '__');
      writeFileSync(resolve(outDir, `${slug}.on.png`), on);
      writeFileSync(resolve(outDir, `${slug}.off.png`), off);
      result.diff = meanDiff(on, off);
      if (result.diff < minDiff) failures.push(`toggle diff ${result.diff.toFixed(5)} < ${minDiff}`);
    } else if (feature.kind === 'probe') {
      await waitFrames(page, Math.min(frames, 10));
    }
    result.checks = await page.evaluate(() => window.__featureLab.checks());
    for (const check of result.checks) if (!check.ok) failures.push(`check '${check.name}' failed: ${check.detail ?? ''}`);
    if (feature.kind !== 'visual' && result.checks.length === 0) failures.push('probe recorded no checks');
    const labError = await page.evaluate(() => window.__featureLab.error);
    if (labError !== null && !feature.expectsAppError) failures.push(`app error: ${labError}`);
    if (labError === null && feature.expectsAppError) failures.push('feature expects an app error but none was reported');
    result.failures = failures;
    if (feature.knownIssue === null) result.verdict = failures.length === 0 ? 'pass' : 'fail';
    else if (failures.length > 0) result.verdict = 'known-issue';
    else result.failures = ['known issue no longer reproduces; remove knownIssue'];
  } catch (error) {
    result.failures = [error instanceof Error ? error.message : String(error)];
  } finally {
    await page.close();
  }
  return result;
}

// FEATURE_LAB_URL reuses an already running `pnpm dev` server (cold vite start
// compiles the engine shader set, which takes about a minute).
const external = process.env.FEATURE_LAB_URL;
const port = process.env.FEATURE_LAB_PORT ?? (await reservePort());
const baseUrl = external ?? `http://127.0.0.1:${port}`;
const server =
  external === undefined
    ? spawn(process.execPath, [resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], {
        cwd: appRoot,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : { exitCode: null, pid: undefined };
let serverLog = '';
server.stdout?.on('data', (chunk) => (serverLog += chunk));
server.stderr?.on('data', (chunk) => (serverLog += chunk));

let browser;
let exitCode = 1;
try {
  await waitForServer(baseUrl, server);
  // Chromium buckets SwiftShader's adapter limits down to 16 sampled textures;
  // the untiered adapter exposes 48, so the lab exercises the full topologies
  // (transmission needs 21) the way a desktop GPU does.
  browser = await chromium.launch({
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    args:
      process.env.CI && process.platform === 'linux'
        ? [
            ...browserLaunch.args.map((arg) =>
              arg.startsWith('--disable-dawn-features=') ? `${arg},tiered_adapter_limits` : arg,
            ),
            '--use-angle=swiftshader',
          ]
        : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const indexPage = await browser.newPage();
  await indexPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await indexPage.waitForFunction(() => window.__featureLab !== undefined, undefined, { timeout: bootTimeout });
  const all = await indexPage.evaluate(() => window.__featureLab.list());
  await indexPage.close();
  const selected = all.filter((feature) => filter === '' || feature.id.includes(filter));
  const results = [];
  for (const feature of selected) {
    const result = await runFeature(browser, baseUrl, feature);
    results.push(result);
    const extra = result.diff === undefined ? `${result.checks.length} checks` : `diff=${result.diff.toFixed(4)}`;
    const label = { pass: 'PASS', fail: 'FAIL', 'known-issue': 'KNOWN' }[result.verdict];
    const why = result.verdict === 'known-issue' ? [`known issue: ${feature.knownIssue}`, ...result.failures] : result.failures;
    console.log(`${label} ${feature.id} (${feature.kind}, ${extra})${result.verdict === 'pass' ? '' : `\n     ${why.join('\n     ')}`}`);
  }
  const passed = results.filter((result) => result.verdict === 'pass').length;
  const known = results.filter((result) => result.verdict === 'known-issue').length;
  const failed = results.length - passed - known;
  writeFileSync(resolve(outDir, 'report.json'), `${JSON.stringify({ frames, minDiff, passed, known, failed, total: results.length, results }, null, 2)}\n`);
  console.log(`\nfeature-lab: ${passed} passed, ${known} known engine issues, ${failed} failed of ${results.length} -> ${resolve(outDir, 'report.json')}`);
  exitCode = failed === 0 && results.length > 0 ? 0 : 1;
} catch (error) {
  console.error('[feature-lab] runner failed:', error, `\n--- vite ---\n${serverLog}`);
} finally {
  await browser?.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}
process.exit(exitCode);
