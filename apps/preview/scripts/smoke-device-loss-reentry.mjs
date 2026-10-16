#!/usr/bin/env node
// P7 recovery proof through the real Preview host. Browser.crashGpuProcess is
// the deterministic Chrome control; the game projection remains the semantic
// witness before and after Renderer.recover().
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_DEVICE_LOSS_DIR ?? resolve(ROOT, '.forgeax-debug/device-loss-reentry'));
const PORT = Number.parseInt(process.env.FORGEAX_DEVICE_LOSS_PORT ?? '5200', 10);
const production = process.env.FORGEAX_DEVICE_LOSS_MODE === 'production';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const serverArgs = production
  ? ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(PORT)]
  : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)];
const server = spawn('pnpm', serverArgs, {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
});

const readHealth = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.renderer.health());
const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const runAction = (id) => page.evaluate((actionId) => globalThis.__forgeaxPreviewInspection?.run(actionId), id);
const visualStats = (path) => {
  const png = PNG.sync.read(readFileSync(path));
  let nonBlack = 0;
  let brightness = 0;
  const top = Math.min(45, png.height);
  const bottom = Math.max(top, png.height - 60);
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4;
      const value = (png.data[index] ?? 0) + (png.data[index + 1] ?? 0) + (png.data[index + 2] ?? 0);
      brightness += value;
      if (value > 24) nonBlack += 1;
    }
  }
  const samplePixels = png.width * Math.max(0, bottom - top);
  return {
    width: png.width,
    height: png.height,
    nonBlack,
    nonBlackRatio: samplePixels === 0 ? 0 : nonBlack / samplePixels,
    meanRgb: samplePixels === 0 ? 0 : brightness / (samplePixels * 3),
  };
};
const visualDiff = (referencePath, candidatePath) => {
  const reference = PNG.sync.read(readFileSync(referencePath));
  const candidate = PNG.sync.read(readFileSync(candidatePath));
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return { meanAbsRgb: Number.POSITIVE_INFINITY, highDeltaRatio: 1 };
  }
  const top = Math.min(45, reference.height);
  const bottom = Math.max(top, reference.height - 60);
  let totalDelta = 0;
  let highDelta = 0;
  let samplePixels = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const index = (y * reference.width + x) * 4;
      const delta =
        (Math.abs((reference.data[index] ?? 0) - (candidate.data[index] ?? 0)) +
          Math.abs((reference.data[index + 1] ?? 0) - (candidate.data[index + 1] ?? 0)) +
          Math.abs((reference.data[index + 2] ?? 0) - (candidate.data[index + 2] ?? 0))) /
        3;
      totalDelta += delta;
      if (delta > 20) highDelta += 1;
      samplePixels += 1;
    }
  }
  return {
    meanAbsRgb: samplePixels === 0 ? Number.POSITIVE_INFINITY : totalDelta / samplePixels,
    highDeltaRatio: samplePixels === 0 ? 1 : highDelta / samplePixels,
  };
};

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForTimeout(1_500);
  const before = await readSnapshot();
  const aliveBefore = await readHealth();
  if (!before?.ok || before.value.state.phase !== 'Play' || aliveBefore?.reason !== 'alive') {
    throw new Error(`baseline missing: ${JSON.stringify({ before, aliveBefore })}`);
  }

  // Pressure the already-public charge VFX owner before the GPU loss. This is
  // intentionally an inspection action, not a World mutation: the recovery
  // claim must cover the same user-facing path a first-game debugger can take.
  const chargeAction = await runAction('game-default.trigger-vfx-charge');
  await page.waitForTimeout(400);
  const chargeBeforeLoss = await readSnapshot();
  const charge = chargeBeforeLoss?.value?.vfxHit;
  const chargeKinds = charge?.batchKinds ?? [];
  if (!chargeAction?.ok || !chargeBeforeLoss?.ok || charge?.mode !== 'charge' || charge?.guid !== 'e696463c-b254-5efb-95df-5a44ebe3b508' || charge?.playing !== true || charge?.emitterCount !== 2 || charge?.emitterStatuses?.some((status) => status !== 'ready') || !chargeKinds.includes('billboard') || !chargeKinds.includes('mesh') || charge?.alive <= 0 || charge?.bucketCount !== 2 || charge?.readiness !== 'ready' || charge?.errorCode !== null) {
    throw new Error(`charge VFX before loss failed: ${JSON.stringify({ chargeAction, chargeBeforeLoss })}`);
  }
  const beforePath = resolve(ARTIFACT_DIR, 'before-loss.png');
  await page.screenshot({ path: beforePath });
  const beforeVisual = visualStats(beforePath);
  if (beforeVisual.nonBlack < 1_000 || beforeVisual.meanRgb < 1) throw new Error(`baseline frame is not visible: ${JSON.stringify(beforeVisual)}`);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Browser.crashGpuProcess');
  const lossDeadline = Date.now() + 15_000;
  let deviceLost;
  while (Date.now() < lossDeadline) {
    deviceLost = await readHealth();
    if (deviceLost?.reason === 'device-lost') break;
    await sleep(100);
  }
  if (deviceLost?.reason !== 'device-lost') throw new Error(`device loss was not observed: ${JSON.stringify(deviceLost)}`);

  const recovered = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.renderer.recover());
  const recoveryDeadline = Date.now() + 15_000;
  let aliveAfter;
  while (Date.now() < recoveryDeadline) {
    aliveAfter = await readHealth();
    if (aliveAfter?.reason === 'alive') break;
    await sleep(100);
  }
  if (!recovered.ok || aliveAfter?.reason !== 'alive') throw new Error(`recovery failed: ${JSON.stringify({ recovered, aliveAfter })}`);

  await page.waitForTimeout(600);
  const after = await readSnapshot();
  if (!after?.ok || after.value.state.phase !== 'Play' || after.value.state.fixedTicks <= before.value.state.fixedTicks) {
    throw new Error(`game projection did not continue after recovery: ${JSON.stringify({ before, after })}`);
  }
  const recoveredVfx = after.value.vfxHit;
  const recoveredKinds = recoveredVfx?.batchKinds ?? [];
  if (recoveredVfx?.mode !== 'charge' || recoveredVfx.guid !== 'e696463c-b254-5efb-95df-5a44ebe3b508' || recoveredVfx.playing !== true || recoveredVfx.emitterCount !== 2 || recoveredVfx.emitterStatuses.some((status) => status !== 'ready') || !recoveredKinds.includes('billboard') || !recoveredKinds.includes('mesh') || recoveredVfx.alive <= 0 || recoveredVfx.bucketCount !== 2 || recoveredVfx.readiness !== 'ready' || recoveredVfx.errorCode !== null) {
    throw new Error(`charge VFX did not recover: ${JSON.stringify({ chargeBeforeLoss, after })}`);
  }
  const afterPath = resolve(ARTIFACT_DIR, 'after-recover.png');
  await page.screenshot({ path: afterPath });
  const resetAction = await runAction('game-default.reset');
  await page.waitForTimeout(250);
  const afterReset = await readSnapshot();
  const resetVfx = afterReset?.value?.vfxHit;
  if (!resetAction?.ok || !afterReset?.ok || resetVfx?.playing !== false || resetVfx.mode !== 'hit' || resetVfx.alive !== 0) {
    throw new Error(`charge VFX reset after recovery failed: ${JSON.stringify({ resetAction, afterReset })}`);
  }
  const afterResetPath = resolve(ARTIFACT_DIR, 'after-reset.png');
  await page.screenshot({ path: afterResetPath });
  const afterVisual = visualStats(afterPath);
  const afterDiff = visualDiff(beforePath, afterPath);
  const rendererEvidence = await page.evaluate(() => {
    const renderer = globalThis.__forgeaxPreviewInspection?.renderer;
    return {
      health: renderer?.health(),
      inspectionKeys: renderer === undefined ? [] : Object.keys(renderer),
    };
  });
  const report = { mode: production ? 'production' : 'dev', before, aliveBefore, chargeAction, chargeBeforeLoss, beforeVisual, deviceLost, recovered, aliveAfter, after, recoveredVfx, afterVisual, afterDiff, resetAction, afterReset, resetVfx, rendererEvidence, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (afterVisual.nonBlack < 1_000 || afterVisual.meanRgb < 1) throw new Error(`recovered frame is not visible: ${JSON.stringify({ beforeVisual, afterVisual, aliveAfter })}`);
  if (afterVisual.nonBlackRatio < beforeVisual.nonBlackRatio * 0.8 || afterDiff.meanAbsRgb > 45 || afterDiff.highDeltaRatio > 0.25) {
    throw new Error(`recovered frame diverged from baseline: ${JSON.stringify({ beforeVisual, afterVisual, afterDiff, aliveAfter })}`);
  }
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource') && !line.includes('device-lost'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[device-loss-reentry] PASS mode=${production ? 'production' : 'dev'} before=${aliveBefore.reason} lost=${deviceLost.reason} after=${aliveAfter.reason} vfx=${recoveredVfx.mode}/${recoveredVfx.alive} fixedTicks=${before.value.state.fixedTicks}->${after.value.state.fixedTicks}`);
  console.log(`[device-loss-reentry] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  try {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await sleep(300);
}
