#!/usr/bin/env node
// P7 backend-truth proof: capture the real game-default Preview frame through
// the documented inspection front door, then replay that exact tape on Dawn for
// pixel readback and on structural rhi-null. This keeps the game world and
// renderer owner in Preview while exercising the cross-backend transport boundary.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_CROSS_BACKEND_DIR ?? resolve(ROOT, '.forgeax-debug/cross-backend-replay'),
);
const PORT = Number.parseInt(process.env.FORGEAX_CROSS_BACKEND_PORT ?? '5202', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn(
  'pnpm',
  ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

async function boot() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, {
        waitUntil: 'networkidle',
        timeout: 2_000,
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForTimeout(1_500);
}

try {
  await boot();
  const before = await page.evaluate(async () => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (!inspection) throw new Error('Preview inspection global is unavailable');
    return {
      listed: inspection.list(),
      snapshot: await inspection.read('game-default.snapshot'),
      health: inspection.renderer.health(),
    };
  });
  if (before.listed.actions.length < 4 || before.listed.reads.length < 2) {
    throw new Error(`inspection surface drifted: ${JSON.stringify(before.listed)}`);
  }
  if (!before.snapshot.ok || before.snapshot.value.state.phase !== 'Play' || before.health.reason !== 'alive') {
    throw new Error(`Preview baseline failed: ${JSON.stringify(before)}`);
  }

  const capture = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.captureFrame(1));
  if (
    !capture.ok ||
    capture.value?.kind !== 'rhi-tape' ||
    typeof capture.value.path !== 'string' ||
    typeof capture.value.digest !== 'string'
  ) {
    throw new Error(`Preview capture failed: ${JSON.stringify(capture)}`);
  }
  const tapeSource = [capture.value.path, resolve(ROOT, capture.value.path)].find((path) => existsSync(path));
  if (tapeSource === undefined) throw new Error(`single Preview tape artifact is missing: ${capture.value.path}`);
  const artifactPath = resolve(ARTIFACT_DIR, 'frame.rhitape');
  copyFileSync(tapeSource, artifactPath);
  const livePngPath = resolve(ARTIFACT_DIR, 'live.png');
  const liveCanvasPng = await page.evaluate(() => {
    const canvas = document.querySelector('#app');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Preview canvas is unavailable');
    return canvas.toDataURL('image/png');
  });
  writeFileSync(livePngPath, Buffer.from(liveCanvasPng.split(',')[1] ?? '', 'base64'));

  const replay = spawnSync(
    'pnpm',
    [
      'exec',
      'node',
      'apps/hello/m7-backend-recovery/scripts/cross-backend-replay.mjs',
      artifactPath,
      livePngPath,
    ],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, INIT_CWD: ROOT } },
  );
  const replayOutput = `${replay.stdout ?? ''}${replay.stderr ?? ''}`;
  writeFileSync(resolve(ARTIFACT_DIR, 'null-replay.txt'), replayOutput);
  if (replay.status !== 0 || !replayOutput.includes('same-scene cross-backend replay: PASS')) {
    throw new Error(`rhi-null replay failed (status=${replay.status}): ${replayOutput}`);
  }

  const after = await page.evaluate(async () => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  const captureMode = 'pixel';
  const report = { mode: 'pixel', before, capture, artifactPath, after, replayOutput, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter(
    (line) => !line.includes('favicon') && !line.includes('Failed to load resource'),
  );
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[cross-backend-replay] PASS mode=${captureMode} backend=${before.health.reason} artifact=${artifactPath} dawnPixelReplay=true nullReplay=true pageErrors=0 badResponses=0`);
  console.log(`[cross-backend-replay] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
