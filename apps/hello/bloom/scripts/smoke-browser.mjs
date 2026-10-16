#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { PNG } from 'pngjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const evidenceDir = resolve(appRoot, 'evidence');
const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const serverStartTimeoutMs = Number.parseInt(
  process.env.FORGEAX_BLOOM_SERVER_START_TIMEOUT_MS ?? '120000',
  10,
);
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

mkdirSync(evidenceDir, { recursive: true });

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SCENE_ROI = Object.freeze({ left: 0.15, top: 0.15, right: 0.85, bottom: 0.85 });
const ROI_EPSILON = 0.05;
const ROI_MIN_DIFF_PIXELS = 1000;
const ROI_MIN_MAX_DELTA = 0.25;
const ROI_MIN_MEAN_DELTA = 0.01;

function readImage(path) {
  return PNG.sync.read(readFileSync(path));
}

function roiBounds(image) {
  return {
    x: Math.floor(image.width * SCENE_ROI.left),
    y: Math.floor(image.height * SCENE_ROI.top),
    width: Math.max(1, Math.ceil(image.width * (SCENE_ROI.right - SCENE_ROI.left))),
    height: Math.max(1, Math.ceil(image.height * (SCENE_ROI.bottom - SCENE_ROI.top))),
  };
}

function rgbDiff(firstPath, secondPath) {
  const first = readImage(firstPath);
  const second = readImage(secondPath);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error(`scene ROI dimensions differ: ${first.width}x${first.height} vs ${second.width}x${second.height}`);
  }
  const roi = roiBounds(first);
  let diffPixelCount = 0;
  let maxDelta = 0;
  let totalDelta = 0;
  const pixelCount = roi.width * roi.height;
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const offset = (y * first.width + x) * 4;
      const delta = Math.max(
        Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)),
        Math.abs((first.data[offset + 1] ?? 0) - (second.data[offset + 1] ?? 0)),
        Math.abs((first.data[offset + 2] ?? 0) - (second.data[offset + 2] ?? 0)),
      ) / 255;
      if (delta > ROI_EPSILON) diffPixelCount += 1;
      maxDelta = Math.max(maxDelta, delta);
      totalDelta += delta;
    }
  }
  return { roi, epsilon: ROI_EPSILON, diffPixelCount, maxDelta, meanDelta: totalDelta / pixelCount };
}

function imageStats(path) {
  const image = readImage(path);
  let nonBlackPixels = 0;
  let maxLuma = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (luma > 0.02) nonBlackPixels += 1;
    maxLuma = Math.max(maxLuma, luma);
  }
  const roi = roiBounds(image);
  return { width: image.width, height: image.height, sha256: sha256File(path), nonBlackPixels, maxLuma, sceneRoi: roi };
}

function resultShape(result) {
  if (result?.ok === true) return { ok: true };
  return { ok: false, error: result?.error ?? { code: 'unknown' } };
}

const evidence = {
  schemaVersion: 'hello-bloom-browser-evidence/1',
  sourceRevision,
  source: {
    path: 'apps/hello/bloom/src/main.ts',
    sha256: sha256File(resolve(appRoot, 'src/main.ts')),
  },
  build: {
    path: 'apps/hello/bloom/dist/shaders/manifest.json',
    sha256: sha256File(resolve(appRoot, 'dist/shaders/manifest.json')),
  },
  backend: 'browser-webgpu',
  runner: {
    kind: 'playwright',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
  },
  requestedFrames: frames,
  successfulSubmittedFrames: 0,
  stages: [],
  structuredErrors: [],
  verdict: 'fail',
};

let server;
let browser;
let serverUrl;
let serverOutput = '';
let cleanupStarted = false;

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForServer() {
  const serverDeadline = Date.now() + serverStartTimeoutMs;
  while (Date.now() < serverDeadline) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(serverUrl);
      if (response.ok) return;
    } catch {
      // Vite may still be compiling before it accepts HTTP connections.
    }
    await delay(100);
  }
  throw new Error(`Bloom Vite server did not become reachable at ${serverUrl}: ${serverOutput}`);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await browser?.close().catch(() => undefined);
  if (server?.pid !== undefined) await createOwnedProcessGroupStopper(server)();
}

try {
  const configuredPort = process.env.FORGEAX_BLOOM_PORT;
  const port = configuredPort !== undefined && configuredPort !== '0' ? configuredPort : String(await reservePort());
  serverUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: appRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );
  const observeServer = (chunk) => {
    serverOutput += String(chunk);
  };
  server.stdout.on('data', observeServer);
  server.stderr.on('data', observeServer);
  await waitForServer();

  browser = await chromium.launch({
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    args: process.platform === 'win32' ? resolveBrowserWebGpuLaunch().args : process.env.CI && process.platform === 'linux'
      ? [...browserLaunch.args, '--use-angle=swiftshader']
      : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 225 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // HTTP readiness precedes Vite's shader-heavy entry transform. Keep the
  // existing 30-second runtime assertions below after navigation completes.
  await page.goto(`${serverUrl}/`, { waitUntil: 'domcontentloaded', timeout: serverStartTimeoutMs });
  await page.waitForFunction(
    () => typeof globalThis.__bloomCarrierProbe?.ready === 'function' && globalThis.__bloomCarrierProbe.ready(),
    undefined,
    { timeout: 30_000 },
  );

  let targetSubmitted = 0;
  async function waitForSubmitted(additional) {
    targetSubmitted += additional;
    await page.waitForFunction(
      (target) => (globalThis.__bloomCarrierProbe?.inspect()?.submittedFrames ?? 0) >= target,
      targetSubmitted,
      { timeout: 30_000 },
    );
  }

  async function captureStage(label, action, record = true) {
    const actionResult = action === undefined ? undefined : await page.evaluate(action);
    await page.waitForTimeout(100);
    const compositorPath = resolve(evidenceDir, `browser-${label}-compositor.png`);
    await page.screenshot({ path: compositorPath });
    const pngPath = resolve(evidenceDir, `browser-${label}.png`);
    await page.locator('#app').screenshot({ path: pngPath });
    const scenePath = resolve(evidenceDir, `browser-${label}-scene.png`);
    const hudState = await page.evaluate(() => {
      const hud = document.getElementById('bloom-hud');
      if (hud === null) return undefined;
      const visibility = hud.style.visibility;
      hud.style.visibility = 'hidden';
      return visibility;
    });
    try {
      await page.locator('#app').screenshot({ path: scenePath });
    } finally {
      await page.evaluate((visibility) => {
        const hud = document.getElementById('bloom-hud');
        if (hud !== null) hud.style.visibility = visibility ?? '';
      }, hudState);
    }
    const observation = await page.evaluate(() => globalThis.__bloomCarrierProbe.inspect());
    const stage = {
      label,
      action: actionResult === undefined ? undefined : resultShape(actionResult),
      inspection: observation,
      readback: { path: `apps/hello/bloom/evidence/browser-${label}.png`, sha256: sha256File(pngPath), ...imageStats(pngPath) },
      sceneReadback: { path: `apps/hello/bloom/evidence/browser-${label}-scene.png`, ...imageStats(scenePath) },
      compositorReadback: { path: `apps/hello/bloom/evidence/browser-${label}-compositor.png`, ...imageStats(compositorPath) },
    };
    if (record) evidence.stages.push(stage);
    evidence.successfulSubmittedFrames = observation.submittedFrames;
    console.log(`[bloom-browser] stage=${label} evidence=${JSON.stringify(stage)}`);
    return stage;
  }

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('on'));
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(true));
  await waitForSubmitted(frames);
  const onStage = await captureStage('on');
  await waitForSubmitted(3);
  const baselineRepeat = await captureStage('on-repeat', undefined, false);

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('scatter-low'));
  const scatterLowValue = 0.25;
  const scatterLowSet = await page.evaluate((value) => globalThis.__bloomCarrierProbe.setBloomScatter(value), scatterLowValue);
  await waitForSubmitted(3);
  const scatterLow = await captureStage('scatter-low');
  scatterLow.action = { ok: scatterLowSet, scatter: scatterLowValue };

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('scatter-high'));
  const scatterHighValue = 0.95;
  const scatterHighSet = await page.evaluate((value) => globalThis.__bloomCarrierProbe.setBloomScatter(value), scatterHighValue);
  await waitForSubmitted(3);
  const scatterHigh = await captureStage('scatter-high');
  scatterHigh.action = { ok: scatterHighSet, scatter: scatterHighValue };
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloomScatter(0.7));
  await waitForSubmitted(3);

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('off'));
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(false));
  await waitForSubmitted(3);
  await captureStage('off');

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('intensity-zero'));
  const intensityZeroSet = await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(true) && globalThis.__bloomCarrierProbe.setBloomIntensity(0));
  await waitForSubmitted(3);
  const intensityZero = await captureStage('intensity-zero', undefined, false);
  intensityZero.action = { ok: intensityZeroSet };
  evidence.intensityZero = intensityZero;

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(false));
  await waitForSubmitted(3);

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('resize'));
  await page.evaluate(() => globalThis.__bloomCarrierProbe.resize(200, 112));
  await waitForSubmitted(process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60);
  await captureStage('resize');

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('re-enabled'));
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(true) && globalThis.__bloomCarrierProbe.setBloomIntensity(1));
  await waitForSubmitted(3);
  await captureStage('re-enabled');

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('surface-reconfigure'));
  const recovery = await page.evaluate(() => globalThis.__bloomCarrierProbe.reconfigureSurface());
  await waitForSubmitted(3);
  const recoveryStage = await captureStage('surface-reconfigure');
  recoveryStage.recovery = { release: resultShape(recovery.release), restore: resultShape(recovery.restore) };

  const finalObservation = await page.evaluate(() => globalThis.__bloomCarrierProbe.inspect());
  evidence.successfulSubmittedFrames = finalObservation.submittedFrames;
  evidence.structuredErrors = [...finalObservation.errors, ...pageErrors.map((message) => ({ code: 'pageerror', message })), ...consoleErrors.map((message) => ({ code: 'console-error', message }))];
  const recordedOnStage = evidence.stages.find((stage) => stage.label === 'on');
  const offStage = evidence.stages.find((stage) => stage.label === 'off');
  const resizeStage = evidence.stages.find((stage) => stage.label === 'resize');
  const reenabledStage = evidence.stages.find((stage) => stage.label === 're-enabled');
  const recoveryStageEvidence = evidence.stages.find((stage) => stage.label === 'surface-reconfigure');
  if (recordedOnStage === undefined || offStage === undefined || resizeStage === undefined || reenabledStage === undefined || recoveryStageEvidence === undefined) {
    throw new Error('Bloom lifecycle stages are incomplete');
  }
  const validBloomStage = (stage) => stage.inspection.bloom.enabled === true && stage.inspection.bloom.graphStatus === 'valid' && stage.inspection.bloom.passCount === 10;
  const assertContribution = (label, diff) => {
    if (diff.diffPixelCount < ROI_MIN_DIFF_PIXELS || diff.maxDelta < ROI_MIN_MAX_DELTA || diff.meanDelta < ROI_MIN_MEAN_DELTA) {
      throw new Error(`Bloom ${label} scene ROI did not meet predeclared RGB thresholds: ${JSON.stringify(diff)}`);
    }
  };
  const baselineDiff = rgbDiff(resolve(repoRoot, onStage.sceneReadback.path), resolve(repoRoot, baselineRepeat.sceneReadback.path));
  const onVsOff = rgbDiff(resolve(repoRoot, recordedOnStage.sceneReadback.path), resolve(repoRoot, offStage.sceneReadback.path));
  const resizeOffVsReenabled = rgbDiff(resolve(repoRoot, resizeStage.sceneReadback.path), resolve(repoRoot, reenabledStage.sceneReadback.path));
  const reenabledVsRecovery = rgbDiff(resolve(repoRoot, reenabledStage.sceneReadback.path), resolve(repoRoot, recoveryStageEvidence.sceneReadback.path));
  evidence.contribution = {
    roi: SCENE_ROI,
    baselineRepeat: baselineDiff,
    onVsOff,
    resizeOffVsReenabled,
    reenabledVsRecovery,
    scatterLowVsHigh: rgbDiff(resolve(repoRoot, scatterLow.sceneReadback.path), resolve(repoRoot, scatterHigh.sceneReadback.path)),
    thresholds: { minDiffPixelCount: ROI_MIN_DIFF_PIXELS, minMaxDelta: ROI_MIN_MAX_DELTA, minMeanDelta: ROI_MIN_MEAN_DELTA },
  };
  evidence.baselineRepeat = {
    inspection: baselineRepeat.inspection,
    readback: baselineRepeat.readback,
    sceneReadback: baselineRepeat.sceneReadback,
    compositorReadback: baselineRepeat.compositorReadback,
  };
  const visibleStages = evidence.stages.filter((stage) => stage.readback.nonBlackPixels > 0);
  const bloomOnStages = evidence.stages.filter((stage) => stage.inspection.bloom.enabled);
  const zeroBloomFields = ['targetCount', 'resourceCount', 'targetBytes', 'passCount', 'encodeCount', 'bindGroupCount', 'uploadCount', 'residentChildBytes'];
  const isZeroBloom = (stage) => zeroBloomFields.every((field) => stage.inspection.bloom[field] === 0);
  if (evidence.successfulSubmittedFrames < frames) throw new Error(`successful Renderer submits=${evidence.successfulSubmittedFrames} < ${frames}`);
  if (evidence.structuredErrors.length > 0) throw new Error(`browser renderer errors: ${JSON.stringify(evidence.structuredErrors)}`);
  if (visibleStages.length < 4) throw new Error(`expected visible readback in four stages, got ${visibleStages.length}`);
  if (bloomOnStages.length < 3) throw new Error('Bloom was not enabled in on, re-enabled, and surface-reconfigure stages');
  if (!validBloomStage(recordedOnStage) || !validBloomStage(reenabledStage) || !validBloomStage(recoveryStageEvidence)) throw new Error('Bloom enabled stages did not report a valid ten-pass graph');
  if (!isZeroBloom(offStage) || !isZeroBloom(resizeStage)) throw new Error('Bloom off stages retained non-zero graph or resource counters');
  if (!isZeroBloom(intensityZero) || intensityZero.action?.ok !== true) throw new Error('Bloom intensity-zero stage retained non-zero graph or failed to apply the update');
  if (recordedOnStage.inspection.hud !== 'Bloom: ON' || offStage.inspection.hud !== 'Bloom: OFF' || intensityZero.inspection.hud !== 'Bloom: OFF' || reenabledStage.inspection.hud !== 'Bloom: ON' || recoveryStageEvidence.inspection.hud !== 'Bloom: ON') throw new Error('Bloom HUD did not match renderer inspection state');
  if (evidence.stages.length !== 7) throw new Error(`expected exactly seven lifecycle/quality stages, got ${evidence.stages.length}`);
  if (!validBloomStage(baselineRepeat)) throw new Error('Bloom baseline repeat did not retain a valid ten-pass graph');
  if (resizeStage.sceneReadback.width === recordedOnStage.sceneReadback.width && resizeStage.sceneReadback.height === recordedOnStage.sceneReadback.height) throw new Error('resize stage PNG dimensions did not change');
  if (reenabledStage.inspection.bloom.targetBytes === recordedOnStage.inspection.bloom.targetBytes) throw new Error('re-enabled Bloom targetBytes did not reflect the resized presentation extent');
  if (recoveryStageEvidence.recovery?.release?.ok !== true || recoveryStageEvidence.recovery?.restore?.ok !== true) throw new Error('Bloom surface release/restore reconfiguration was not successful');
  if (baselineDiff.diffPixelCount !== 0 || baselineDiff.maxDelta !== 0 || baselineDiff.meanDelta !== 0) throw new Error(`Bloom baseline repeat was not stable in the scene ROI: ${JSON.stringify(baselineDiff)}`);
  assertContribution('on/off contribution', onVsOff);
  assertContribution('resize off/re-enabled contribution', resizeOffVsReenabled);
  if (!scatterLowSet || !scatterHighSet) throw new Error('scatter quality stages did not apply their camera updates');
  assertContribution('scatter quality contribution', evidence.contribution.scatterLowVsHigh);
  if (reenabledVsRecovery.diffPixelCount !== 0 || reenabledVsRecovery.maxDelta !== 0 || reenabledVsRecovery.meanDelta !== 0) throw new Error(`Bloom surface reconfiguration changed the scene ROI: ${JSON.stringify(reenabledVsRecovery)}`);
  if (evidence.stages.some((stage) => stage.inspection.bloom.graphStatus === 'invalid')) throw new Error('Bloom graph inspection was invalid');
  evidence.verdict = 'pass';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  evidence.serverOutput = serverOutput;
} finally {
  await cleanup();
}

const evidencePath = resolve(evidenceDir, 'browser-result.json');
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[bloom-browser] evidence=${evidencePath} status=${evidence.verdict} frames=${evidence.successfulSubmittedFrames}`);
if (evidence.verdict !== 'pass') process.exit(1);
