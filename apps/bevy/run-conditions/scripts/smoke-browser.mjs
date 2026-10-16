#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const errors = [];
const appDir = resolve(repoRoot, 'apps/bevy/run-conditions');

if (process.env.RUN_CONDITIONS_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: '@forgeax/bevy-run-conditions',
    label: 'bevy run_conditions public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareRunConditionsCapture',
    appDir,
    assertTape: ({ tape }) => assertRunConditionsTape(tape.events),
  });
  process.exit(0);
}

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
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-run-conditions', 'dev'], {
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
    const line = `[browser] ${message.type()}: ${message.text()}`;
    process.stdout.write(`${line}\n`);
    if (message.type() === 'error' && !line.includes('favicon.ico')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname !== '/favicon.ico') {
      errors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor();
  await waitFor(
    async () => await page.evaluate(() => Boolean(globalThis.__bevyRunConditionsReady)),
    'ForgeaX run-conditions app',
    30_000,
  );
  await sleep(2_500);
  const state = await page.evaluate(() => globalThis.__bevyRunConditionsState?.());
  if (errors.length > 0) throw new Error(`[smoke] browser errors:\n${errors.join('\n')}`);
  if (!state || !state.unlocked || state.gatedRuns === 0 || state.pulseRuns !== 1) {
    throw new Error(`[smoke] run-condition state invalid: ${JSON.stringify(state)}`);
  }
  console.log(`[smoke] PASS - browser ready, gate opened, gatedRuns=${state.gatedRuns}, pulseRuns=1, no console errors`);
} finally {
  await browser?.close();
  stopping = true;
  vite?.kill();
}

const publicExit = await runPublicCaptureFrame();
if (publicExit !== 0) process.exit(publicExit);

await runRhiDebugBrowserAdmission({
  pkg: '@forgeax/bevy-run-conditions',
  label: 'bevy run_conditions',
  readyHook: '__bevyRunConditionsReady',
  capturePrepareHook: '__prepareRunConditionsCapture',
  screenshotPath: resolve(appDir, 'artifacts/run-conditions-rhi-debug.png'),
  triggerLabel: 'run-conditions-public-trigger',
  assertTape: ({ events }) => assertRunConditionsTape(events),
  formatCapture: ({ capture, selected, inspected }) =>
    `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} ` +
    `indexCount=${inspected.drawCall.indexCount} markerDraws=${selected.markerDraws}`,
});

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: repoRoot,
      env: { ...process.env, RUN_CONDITIONS_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertRunConditionsTape(events) {
  const { draws } = collectRhiDebugDraws(events);
  const markerDraws = draws.filter(
    ({ event, pass, pipeline }) =>
      event.kind === 'drawIndexed' &&
      event.indexCount === 36 &&
      event.instanceCount > 0 &&
      pass?.colorAttachmentViewHandleIds?.length === 1 &&
      pipeline?.desc?.primitive?.topology === 'triangle-list',
  );
  if (markerDraws.length !== 2) {
    throw new Error(`expected two run-condition marker draws, got ${markerDraws.length} of ${draws.length} draws`);
  }
  const drawOrdinal = draws.indexOf(markerDraws[0]);
  console.log(`[bevy run_conditions] semantic selector markerDraws=2 drawOrdinal=${drawOrdinal}`);
  return { drawOrdinal, markerDraws: markerDraws.length };
}
