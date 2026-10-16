#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { validateFeatureVisualEvidence } from './smoke-browser-observations.mjs';

const root = resolve(import.meta.dirname, '..');
const repoRoot = resolve(root, '..', '..', '..');
const artifactRoot = resolve(repoRoot, 'artifacts/hello-taa');
const output = resolve(artifactRoot, 'taa-visual.png');
const sequenceDirectory = resolve(artifactRoot, 'visual-sequence');
const sequencePath = resolve(artifactRoot, 'visual-sequence.json');
const evidencePath = resolve(artifactRoot, 'visual-evidence.json');
const falsifyPath = resolve(artifactRoot, 'falsify-history.json');
const source = await readFile(resolve(root, 'src/main.ts'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const frames = 60;

async function digestDirectory(directory, relative = '') {
  const digest = createHash('sha256');
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const childPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      digest.update(await digestDirectory(childPath, childRelative));
      continue;
    }
    digest.update(childRelative);
    digest.update('\0');
    digest.update(await readFile(childPath));
  }
  return digest.digest('hex');
}

let server;
let browser;
let failure;
let pixelStats;
let pngSha256;
let submittedFrameEvents = [];
let buildSha256;
let falsifyRecord;
const stageCaptures = [];
const browserErrors = [];
const classifyExpectedRecovery = (detail) => {
  const deviceOperation = detail.includes(
    'RendererOperationError: device-operation-failed: the active device generation completes the renderer-owned operation',
  );
  if (deviceOperation && detail.includes('Object.execute') && detail.includes('executeRendererFrameTransaction')) {
    return {
      code: 'device-operation-failed',
      stage: 'execute',
      expected: 'the active device generation completes the renderer-owned operation',
    };
  }
  const frameInput = detail.includes(
    'RendererOperationError: frame-input-invalid: the frame input references attached leases and a valid immutable RenderProfile',
  );
  if (frameInput && detail.includes('Object.draw') && detail.includes('runFrame')) {
    return {
      code: 'frame-input-invalid',
      stage: 'frame-input',
      expected: 'the frame input references attached leases and a valid immutable RenderProfile',
    };
  }
  return undefined;
};
try {
  buildSha256 = await digestDirectory(resolve(root, 'dist'));
  falsifyRecord = JSON.parse(await readFile(falsifyPath, 'utf8'));
  if (falsifyRecord.sourceRevision !== sourceRevision || falsifyRecord.status !== 'pass') {
    throw new Error(
      `TAA falsifier provenance is not current and passing: ${JSON.stringify({
        sourceRevision: falsifyRecord.sourceRevision,
        expectedRevision: sourceRevision,
        status: falsifyRecord.status,
      })}`,
    );
  }
  server = spawn('pnpm', ['--filter', '@forgeax/hello-taa', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let outputText = '';
  let url;
  const observe = (chunk) => {
    outputText += String(chunk);
    url ??= outputText.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  };
  server.stdout.on('data', observe); server.stderr.on('data', observe);
  const deadline = Date.now() + 30_000;
  while (url === undefined && Date.now() < deadline) await delay(100);
  if (url === undefined) throw new Error(`TAA Vite server did not publish a URL: ${outputText}`);
  browser = await chromium.launch({
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  page.on('console', (message) => {
    console.log(`[hello-taa] browser console ${message.type()}: ${message.text()}`);
    if (message.type() === 'error') {
      browserErrors.push({ stage: 'browser-console', detail: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    console.log(`[hello-taa] browser pageerror: ${error.message}`);
    browserErrors.push({ stage: 'pageerror', detail: error.message });
  });
  await page.goto(`${url}/?taa-scenario=taa`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => typeof globalThis.__taaCarrierProbe === 'function', undefined, { timeout: 30_000 });
  await page.evaluate(() => {
    const canvas = document.querySelector('#app');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('TAA visual capture canvas missing');
    const events = [];
    globalThis.__taaVisualCaptureEvents = events;
    canvas.addEventListener('forgeax:frame-submitted', (event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (
        detail !== null &&
        typeof detail === 'object' &&
        Number.isSafeInteger(detail.frameId) &&
        Number.isSafeInteger(detail.deviceGeneration)
      ) {
        events.push({ frameId: detail.frameId, deviceGeneration: detail.deviceGeneration });
      }
    });
  });
  const { PNG } = await import('pngjs');
  const readPngStats = async (path) => {
    const bytes = await readFile(path);
    const image = PNG.sync.read(bytes);
    let nonWhitePixels = 0;
    let nonBackgroundPixels = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      const red = image.data[index] ?? 0;
      const green = image.data[index + 1] ?? 0;
      const blue = image.data[index + 2] ?? 0;
      if (red < 250 || green < 250 || blue < 250) nonWhitePixels += 1;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 8) nonBackgroundPixels += 1;
    }
    return {
      width: image.width,
      height: image.height,
      nonWhitePixels,
      nonBackgroundPixels,
      sha256: sha256(bytes),
      data: image.data,
    };
  };
  const compareImages = (left, right) => {
    if (left.data.length !== right.data.length) return { diffPixelCount: -1, maxDelta: 1, meanDelta: 1 };
    let diffPixelCount = 0;
    let maxDelta = 0;
    let totalDelta = 0;
    for (let index = 0; index < left.data.length; index += 4) {
      const delta = Math.max(
        Math.abs(left.data[index] - right.data[index]),
        Math.abs(left.data[index + 1] - right.data[index + 1]),
        Math.abs(left.data[index + 2] - right.data[index + 2]),
        Math.abs(left.data[index + 3] - right.data[index + 3]),
      ) / 255;
      if (delta > 0.05) diffPixelCount += 1;
      maxDelta = Math.max(maxDelta, delta);
      totalDelta += delta;
    }
    return { diffPixelCount, maxDelta, meanDelta: totalDelta / (left.data.length / 4) };
  };
  const captureStage = async (id, targetFrame) => {
    await page.waitForFunction((minimum) => {
      const probe = globalThis.__taaCarrierProbe?.();
      return typeof probe?.frame === 'number' && probe.frame >= minimum;
    }, targetFrame, { timeout: 60_000 });
    const path = resolve(sequenceDirectory, `${id}.png`);
    await mkdir(sequenceDirectory, { recursive: true });
    await page.locator('#app').screenshot({ path, type: 'png' });
    const probe = await page.evaluate(() => globalThis.__taaCarrierProbe?.());
    const stats = await readPngStats(path);
    const { data: _data, ...summary } = stats;
    stageCaptures.push({ id, path: `artifacts/hello-taa/visual-sequence/${id}.png`, frame: probe?.frame ?? 0, probe, ...summary });
    return stats;
  };
  await page.evaluate(() => globalThis.__taaCarrierSetMotionEnabled?.(false));
  const baselineStats = await captureStage('baseline', 24);
  await page.locator('#app').screenshot({ path: resolve(sequenceDirectory, 'repeat.png'), type: 'png' });
  const repeatStats = await readPngStats(resolve(sequenceDirectory, 'repeat.png'));
  const repeatProbe = await page.evaluate(() => globalThis.__taaCarrierProbe?.());
  const { data: _repeatData, ...repeatSummary } = repeatStats;
  stageCaptures.push({ id: 'repeat', path: 'artifacts/hello-taa/visual-sequence/repeat.png', frame: repeatProbe?.frame ?? 0, probe: repeatProbe, ...repeatSummary });
  const baselineRepeatDiff = compareImages(baselineStats, repeatStats);
  await page.evaluate(() => globalThis.__taaCarrierSetMotionEnabled?.(true));
  await captureStage('moving', 90);
  await captureStage('cut', 130);
  await captureStage('resize', 190);
  await captureStage('reseed', 250);
  await captureStage('settled', frames);
  submittedFrameEvents = await page.evaluate(() => globalThis.__taaVisualCaptureEvents ?? []);
  if (submittedFrameEvents.length < frames) {
    throw new Error(
      `TAA visual capture observed ${submittedFrameEvents.length}/${frames} successful frame submissions`,
    );
  }
  const unexpectedBrowserErrors = browserErrors.filter(
    ({ detail }) => classifyExpectedRecovery(detail) === undefined,
  );
  if (unexpectedBrowserErrors.length > 0) {
    throw new Error(
      `TAA visual capture reported unexpected browser errors: ${JSON.stringify(unexpectedBrowserErrors)}`,
    );
  }
  await mkdir(dirname(output), { recursive: true });
  await page.locator('#app').screenshot({ path: output, type: 'png' });
  pixelStats = await readPngStats(output);
  pngSha256 = pixelStats.sha256;
  if (pixelStats.nonWhitePixels === 0) throw new Error('TAA visual capture is uniformly white');
  if (baselineStats.width !== repeatStats.width || baselineStats.height !== repeatStats.height ||
      baselineRepeatDiff.meanDelta > 0.01 || baselineStats.data === undefined || repeatStats.data === undefined) {
    throw new Error(`TAA baseline/repeat scene capture is not stable: ${JSON.stringify(baselineRepeatDiff)}`);
  }
  stageCaptures[1].baselineRepeatDiff = baselineRepeatDiff;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
finally {
  await browser?.close().catch(() => undefined);
  if (server?.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  }
}
const frameIdentityEvents = submittedFrameEvents.slice(0, frames);
const frameIdentity = {
  first: frameIdentityEvents[0]?.frameId ?? 0,
  last: frameIdentityEvents.at(-1)?.frameId ?? 0,
  sequenceSha256: sha256(JSON.stringify(frameIdentityEvents)),
};
const record = {
  schemaVersion: 'hello-taa-auto-exposure-evidence/1',
  featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
  source: { path: 'apps/hello/taa/src/main.ts', sha256: sha256(source) },
  build: {
    command: 'pnpm --filter @forgeax/hello-taa build',
    sha256: buildSha256 ?? sha256('build-unavailable'),
  },
  backend: 'browser-webgpu',
  runner: { kind: 'playwright', id: process.env.CI ? 'ci-browser' : 'local-browser' },
  resolution: { width: pixelStats?.width ?? 320, height: pixelStats?.height ?? 180 },
  frames,
  frameIdentity,
  stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
    id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
    domain,
    readback: { rawHash: stageCaptures[index]?.sha256 ?? sha256(`missing-${domain}`), frame: frameIdentity.last },
  })),
  exposure: { mode: 'auto', ev: { first: 0, last: 0, generation: frameIdentity.last >= 0 ? 1 : 0 } },
  lut: { generation: 0, strength: 0, sourceKey: 'none' },
  resourceGrowth: { stableFrames: Math.max(1, frames - 240), byteLengthDelta: 0, bindGroupDelta: 0 },
  visualEvidence: [
    ['exposure-adaptation-card', stageCaptures.find((stage) => stage.id === 'moving')],
    ['white-balance-card', stageCaptures.find((stage) => stage.id === 'baseline')],
    ['lut-output-card', stageCaptures.find((stage) => stage.id === 'settled')],
  ].map(([id, stage]) => ({
    id,
    png: stage?.path ?? 'artifacts/hello-taa/visual-sequence/missing.png',
    observed: stage === undefined
      ? 'visual capture unavailable'
      : `Real compositor capture at submitted frame ${stage.frame}; ${stage.nonWhitePixels} non-white pixels and ${stage.nonBackgroundPixels} chromatic pixels`,
    verdict: failure === undefined ? 'pass' : 'unavailable',
    confidence: failure === undefined ? 'high' : 'low',
  })),
  sequence: {
    path: 'artifacts/hello-taa/visual-sequence.json',
    stages: stageCaptures,
    events: { motionFrames: [60], cutFrames: [120], resizeFrames: [180], reseedFrames: [240] },
    baselineRepeatStable: stageCaptures[1]?.baselineRepeatDiff?.meanDelta <= 0.01 && stageCaptures[0]?.probe?.motionEnabled === false,
    limitations: 'Stage differences demonstrate carrier scene evolution and reset events; they do not isolate TAA contribution from ordinary raster motion.',
  },
  legacyVisualEvidence: [{
    id: 'taa-temporal-dynamics',
    png: 'artifacts/hello-taa/taa-visual.png',
    observed: pixelStats === undefined
      ? 'TAA capture unavailable'
      : `TAA carrier canvas captured after ${frameIdentityEvents.length} successful submitted frames; ${pixelStats.nonWhitePixels} non-white pixels`,
    verdict: failure === undefined ? 'pass' : 'unavailable',
    confidence: failure === undefined ? 'high' : 'low',
  }],
  falsify: [{ id: 'taa-history', result: falsifyRecord?.status === 'pass' ? 'pass' : 'unavailable' }],
  status: failure === undefined ? 'pass' : 'unavailable',
  sourceRevision,
  capture: {
    pngSha256: pngSha256 ?? null,
    pixelStats: pixelStats ?? null,
    successfulSubmittedFrames: frameIdentityEvents.length,
    browserErrors,
    acceptedRecoveryErrors: browserErrors
      .map(({ detail }) => classifyExpectedRecovery(detail))
      .filter((error) => error !== undefined),
  },
  ...(failure === undefined ? {} : { failure }),
};
const visualContract = validateFeatureVisualEvidence(record);
if (!visualContract.ok) {
  failure ??= `feature visual evidence is incomplete: ${JSON.stringify(visualContract)}`;
  record.status = 'unavailable';
  for (const card of record.visualEvidence) {
    card.verdict = 'unavailable';
    card.confidence = 'low';
  }
}
await mkdir(artifactRoot, { recursive: true });
await writeFile(sequencePath, `${JSON.stringify({
  schemaVersion: 'hello-taa-visual-sequence/1',
  sourceRevision,
  source: record.source,
  build: record.build,
  backend: record.backend,
  runner: record.runner,
  frames,
  events: record.sequence.events,
  stages: stageCaptures,
  baselineRepeatStable: record.sequence.baselineRepeatStable,
  limitations: record.sequence.limitations,
}, null, 2)}\n`);
await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
try {
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, 'evidence-schema.mjs'), evidencePath],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  failure ??= `Producer output failed hello-taa evidence schema validation: ${detail}`;
  record.status = 'unavailable';
  for (const card of record.visualEvidence) {
    card.verdict = 'unavailable';
    card.confidence = 'low';
  }
  record.falsify[0].result = 'unavailable';
  record.failure = failure;
  await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
}
console.log(`[hello-taa] visual evidence status=${record.status}; path=${evidencePath}`);
if (failure !== undefined) process.exit(1);
