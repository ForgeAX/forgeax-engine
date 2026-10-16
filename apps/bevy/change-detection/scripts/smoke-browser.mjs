#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const appDir = resolve(repoRoot, 'apps/bevy/change-detection');
const errors = [];
let vite;
let browser;
let appUrl;
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(`[smoke] timed out waiting for ${label}`);
};

if (process.env.CHANGE_DETECTION_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: '@forgeax/bevy-change-detection',
    label: 'bevy change_detection public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareChangeDetectionCapture',
    appDir,
    assertTape: ({ tape }) => assertChangeDetectionTape(tape.events),
  });
  process.exit(0);
}

try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-change-detection', 'dev'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', (chunk) => { const text = String(chunk); process.stdout.write(`[vite] ${text}`); appUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]; });
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  await waitFor(() => appUrl !== undefined, 'Vite dev server');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage();
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { const url = new URL(response.url()); if (response.status() >= 400 && url.pathname !== '/favicon.ico') errors.push(`HTTP ${response.status()} ${response.url()}`); });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => Boolean(globalThis.__bevyChangeDetectionReady)), 'change detection app');
  await sleep(1_500);
  const state = await page.evaluate(() => globalThis.__bevyChangeDetectionState?.());
  if (errors.length > 0) throw new Error(`[smoke] browser errors:\n${errors.join('\n')}`);
  if (!state || state.addedHits !== 1 || state.changedHits === 0 || state.resourceChanged === 0) throw new Error(`[smoke] invalid state: ${JSON.stringify(state)}`);
  console.log(`[smoke] PASS - browser ready, addedHits=${state.addedHits}, changedHits=${state.changedHits}, resourceChanged=${state.resourceChanged}`);
} finally {
  await browser?.close();
  vite?.kill();
}

const publicExit = await runPublicCaptureFrame();
if (publicExit !== 0) process.exit(publicExit);

await runRhiDebugBrowserAdmission({
  pkg: '@forgeax/bevy-change-detection',
  label: 'bevy change_detection',
  readyHook: '__bevyChangeDetectionReady',
  capturePrepareHook: '__prepareChangeDetectionCapture',
  screenshotPath: resolve(appDir, 'artifacts/change-detection-rhi-debug.png'),
  triggerLabel: 'change-detection-public-trigger',
  assertTape: ({ events }) => assertChangeDetectionTape(events),
  formatCapture: ({ capture, selected, inspected }) =>
    String(capture.runId ?? 'remote') +
    ' drawOrdinal=' + String(selected.drawOrdinal) +
    ' indexCount=' + String(inspected.drawCall.indexCount) +
    ' markerDraws=' + String(selected.markerDraws),
});

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: repoRoot,
      env: { ...process.env, CHANGE_DETECTION_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertChangeDetectionTape(events) {
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
    throw new Error('expected two change-detection marker draws, got ' + markerDraws.length + ' of ' + draws.length + ' draws');
  }
  const drawOrdinal = draws.indexOf(markerDraws[0]);
  console.log('[bevy change_detection] semantic selector markerDraws=2 drawOrdinal=' + drawOrdinal);
  return { drawOrdinal, markerDraws: markerDraws.length };
}
