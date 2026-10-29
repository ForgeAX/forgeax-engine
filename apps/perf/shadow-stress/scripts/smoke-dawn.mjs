#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
// Dawn smoke for the built shadow stress consumer. The imported entry is the
// same Vite bundle served by the browser path. Only requestAnimationFrame
// receives a synthetic timestamp; performance.now stays real so the profiler
// records actual CPU phase durations.

import { bindSmokeCanvasWindow } from '../../../../scripts/smoke-platform.mjs';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const TAG = '[perf-shadow-stress/dawn]';
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const distRoot = resolve(appRoot, 'dist');
const width = 320;
const height = 180;
const query = process.env.PERF_QUERY ?? '';
const outputPath = process.env.PERF_DAWN_OUTPUT ?? resolve(appRoot, 'artifacts', 'dawn.json');
const screenshotPath = process.env.PERF_DAWN_SCREENSHOT ?? `${outputPath}.png`;
const BASE_VIEW_COUNT = 8;
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(screenshotPath), { recursive: true });

function fail(message) {
  console.error(`${TAG} FAIL ${message}`);
  process.exit(1);
}

const entryName = readdirSync(resolve(distRoot, 'assets')).find((name) => /^index-.*\.js$/u.test(name));
if (entryName === undefined) fail('dist entry missing; run the app build first');
const entryPath = resolve(distRoot, 'assets', entryName);
const manifestBody = readFileSync(resolve(distRoot, 'shaders', 'manifest.json'), 'utf8');

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  fail(`webgpu import failed: ${error instanceof Error ? error.message : String(error)}`);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Hold real scene pipeline completion during startup to exercise readiness.
// Startup preparation must not consume the workload's 60 measured frames.
const PIPELINE_RELEASE_CALLBACK = 32;
let releasePipelines;
const pipelineRelease = new Promise((resolve) => { releasePipelines = resolve; });
let sharedDevice;
// Diagnostic A/B: comma-separated device features to refuse, e.g. to run the
// capability-less path (`indirect-first-instance`) on a capable adapter.
const withheldFeatures = new Set((process.env.PERF_WITHHOLD_FEATURES ?? '').split(',').filter(Boolean));
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (...args) => {
  const adapter = await originalRequestAdapter(...args);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor, ...rest) => {
    const requiredFeatures = descriptor?.requiredFeatures?.filter((feature) => !withheldFeatures.has(feature));
    const device = await originalRequestDevice(
      descriptor === undefined ? descriptor : { ...descriptor, requiredFeatures },
      ...rest,
    );
    const createPipeline = device.createRenderPipelineAsync.bind(device);
    device.createRenderPipelineAsync = async (...args) => {
      const pipeline = await createPipeline(...args);
      if (globalThis.__forgeaxShadowStress !== undefined) await pipelineRelease;
      return pipeline;
    };
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (renderTarget === undefined && sharedDevice === undefined) {
          throw new Error('Dawn render target requested before device capture');
        }
        return ensureRenderTarget(sharedDevice, 'rgba8unorm');
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let rafQueue = [];
let rafId = 0;
let rafNow = 0;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};
globalThis.window = { location: { search: query } };
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.document = {
  querySelector: () => mockCanvas,
  querySelectorAll: () => [],
};
bindSmokeCanvasWindow(mockCanvas, globalThis.window, globalThis.document);
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/shaders/manifest.json')) {
    return new Response(manifestBody, { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected fetch in Dawn smoke: ${url}`);
};

await import(`${pathToFileURL(entryPath).href}?dawnSmoke=${Date.now()}`);

const waitDeadline = Date.now() + 60_000;
while (globalThis.__forgeaxShadowStress === undefined && Date.now() < waitDeadline) await delay(10);
if (globalThis.__forgeaxShadowStress === undefined) fail('app did not finish bootstrap within 60s');
const evidence = globalThis.__forgeaxShadowStress;
const { warmupFrames, profileFrames, sampleFrames } = evidence;
const targetFrames = warmupFrames + profileFrames + sampleFrames + 1;

let drivenRafCallbacks = 0;
const frameDeadline = Date.now() + 600_000;
while (evidence.completedFrames < targetFrames && Date.now() < frameDeadline) {
  if (evidence.appRendererErrors.length > 0) {
    fail(`renderer/app error at frame ${evidence.frameProgress}: ${JSON.stringify(evidence.appRendererErrors[0])}`);
  }
  const frame = rafQueue.shift();
  if (frame === undefined) {
    await delay(1);
    continue;
  }
  rafNow += 1000 / 60;
  frame.callback(rafNow);
  drivenRafCallbacks += 1;
  if (drivenRafCallbacks === PIPELINE_RELEASE_CALLBACK) releasePipelines();
  if (drivenRafCallbacks % 4 === 0) await sharedDevice?.queue.onSubmittedWorkDone();
}
if (evidence.completedFrames < targetFrames) {
  fail(`only observed ${evidence.completedFrames}/${targetFrames} completed frames after ${drivenRafCallbacks} RAF callbacks`);
}

// Frame wall time including queue completion: on a software adapter this
// folds shadow rasterization into the number that CPU phases alone omit.
// Opt-in so the default smoke stays within the 60-frame gate.
const timedFrames = Number(process.env.PERF_TIMED_FRAMES ?? 0);
const syncedFrameMicros = [];
while (syncedFrameMicros.length < timedFrames) {
  const frame = rafQueue.shift();
  if (frame === undefined) {
    await delay(1);
    continue;
  }
  const started = performance.now();
  rafNow += 1000 / 60;
  frame.callback(rafNow);
  drivenRafCallbacks += 1;
  while (rafQueue.length === 0) await delay(0);
  await sharedDevice?.queue.onSubmittedWorkDone();
  syncedFrameMicros.push(Math.round((performance.now() - started) * 1000));
}
if (evidence.appRendererErrors.length > 0) {
  fail(`renderer/app error during timed frames: ${JSON.stringify(evidence.appRendererErrors[0])}`);
}

// Opt-in steady-state RHI tape (requires FORGEAX_ENGINE_RHI_DEBUG=1). The
// capture owns one App frame, so RAF keeps running until it settles.
const rhiCapturePath = process.env.PERF_RHI_CAPTURE;
let rhiCapture;
if (rhiCapturePath !== undefined) {
  const captureFrame = globalThis.__forgeax?.captureFrame;
  if (captureFrame === undefined) fail('PERF_RHI_CAPTURE needs FORGEAX_ENGINE_RHI_DEBUG=1');
  let settled;
  const captureStartFrame = evidence.frameProgress;
  const captureStarted = performance.now();
  void captureFrame().then(
    (value) => {
      settled = { value };
    },
    (error) => {
      settled = { error };
    },
  );
  const captureDeadline = Date.now() + 120_000;
  while (settled === undefined && Date.now() < captureDeadline) {
    const frame = rafQueue.shift();
    if (frame === undefined) {
      await delay(1);
      continue;
    }
    rafNow += 1000 / 60;
    frame.callback(rafNow);
    await sharedDevice?.queue.onSubmittedWorkDone();
  }
  const captureMs = Math.round(performance.now() - captureStarted);
  if (settled === undefined) fail('RHI capture did not settle within 120s');
  if (settled.error !== undefined) fail(`RHI capture threw: ${String(settled.error)}`);
  if (!settled.value.ok) fail(`RHI capture ${settled.value.error.code}: ${settled.value.error.hint}`);
  // One more frame lets Update sample the renderer inspection of the captured frame.
  const settledAtFrame = evidence.frameProgress;
  const sampleDeadline = Date.now() + 30_000;
  for (let pending = rafQueue.shift(); evidence.frameProgress === settledAtFrame; pending = rafQueue.shift()) {
    if (Date.now() > sampleDeadline) fail('no frame ran after the RHI capture settled');
    if (pending === undefined) {
      await delay(1);
      continue;
    }
    rafNow += 1000 / 60;
    pending.callback(rafNow);
    await sharedDevice?.queue.onSubmittedWorkDone();
  }
  mkdirSync(dirname(rhiCapturePath), { recursive: true });
  writeFileSync(rhiCapturePath, settled.value.value.bytes);
  rhiCapture = {
    path: rhiCapturePath,
    kind: settled.value.value.kind,
    digest: settled.value.value.digest,
    byteLength: settled.value.value.bytes.byteLength,
    // Wall time from captureFrame() to settled tape, including the captured frame.
    captureMs,
    // Renderer inspection of the frames rendered while the capture was pending;
    // the captured frame is one of them.
    frames: [captureStartFrame, settledAtFrame],
    trailingSamples: evidence.trailingSamples.filter(
      ({ raster }) => raster.frame >= captureStartFrame && raster.frame <= settledAtFrame,
    ),
  };
}

async function readback() {
  if (sharedDevice === undefined || renderTarget === undefined) fail('render target/device unavailable');
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  return pixels;
}
const pixels = await readback();

function pixelStats(values) {
  let nonClearPixels = 0;
  // Only the skinned characters (base color 0.85, 0.4, 0.2) shade this orange.
  let characterPixels = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 4) {
    const r = values[index] ?? 0;
    const g = values[index + 1] ?? 0;
    const b = values[index + 2] ?? 0;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += luma;
    sumSquares += luma * luma;
    if (Math.abs(r - 10) > 8 || Math.abs(g - 13) > 8 || Math.abs(b - 20) > 8) nonClearPixels += 1;
    if (r > 100 && r > 2 * g && g > 1.3 * b) characterPixels += 1;
  }
  const count = values.length / 4;
  const meanLuma = sum / count;
  return { nonClearPixels, characterPixels, meanLuma, lumaVariance: sumSquares / count - meanLuma * meanLuma };
}

function distribution(values) {
  if (values.length === 0) return { count: 0, mean: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const rank = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, mean, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1] };
}

const profile = evidence.profileCapture;
const profileComplete = profile?.completeness?.status === 'complete' && profile.completeness.droppedEventCount === 0;
const phaseDurations = new Map();
const frameDurations = new Map();
for (const record of profile?.records ?? []) {
  if (record.kind !== 'phase') continue;
  const key = `${record.source}/${record.parentPhase === undefined ? '' : `${record.parentPhase}>`}${record.phase}`;
  const list = phaseDurations.get(key) ?? [];
  list.push(record.durationMicros);
  phaseDurations.set(key, list);
  if (record.parentPhase === undefined) {
    frameDurations.set(record.frameId, (frameDurations.get(record.frameId) ?? 0) + record.durationMicros);
  }
}
const cpuPhasesMicros = Object.fromEntries(
  [...phaseDurations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, distribution(values)]),
);
const samples = evidence.shadowRasterSamples;
const expectedViewCount = BASE_VIEW_COUNT + 6 * (evidence.options.pointCount ?? 0);
const reasons = {};
for (const sample of samples) {
  for (const miss of sample.misses) {
    const reason = miss.split(':')[2];
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
}
// The first post-warmup frame owns bootstrap production when there is no warmup,
// so steady-state counters start one frame later.
const gpuDrivenSamples = evidence.gpuDrivenSamples.filter((sample) => sample.frame >= warmupFrames + 2);
const GPU_DRIVEN_COUNTERS = [
  'planRebuildBatches',
  'planRebuildCandidates',
  'filteredPlanBuilds',
  'preparedBatchBuilds',
  'filteredBatchBuilds',
  'sceneTableUploadBytes',
  'sharedInputUploadBytes',
  'batchUploadBytes',
  'paletteUploadBytes',
  'shadowCasterFlips',
  'shadowCasterPendingPromotions',
];
const gpuDriven = {
  frames: gpuDrivenSamples.length,
  planRebuildFrames: gpuDrivenSamples.filter((sample) => sample.planRebuildBatches > 0).length,
  ...Object.fromEntries(
    GPU_DRIVEN_COUNTERS.map((counter) => [counter, distribution(gpuDrivenSamples.map((sample) => sample[counter]))]),
  ),
};
// Lifetime counters: the steady-state window rate is the delta between its
// first and last samples. Lookup units differ per cache (see
// RenderFrameCacheInspection); rate is null when the window made no lookup.
const FRAME_CACHES = ['visibilityProjection', 'temporalSnapshots', 'transparentSort', 'renderBundles', 'residencyValidation'];
const firstCaches = gpuDrivenSamples[0]?.frameCaches;
const lastCaches = gpuDrivenSamples.at(-1)?.frameCaches;
const frameCacheHitRates = Object.fromEntries(
  FRAME_CACHES.map((cache) => {
    const hits = (lastCaches?.[cache]?.hits ?? 0) - (firstCaches?.[cache]?.hits ?? 0);
    const misses = (lastCaches?.[cache]?.misses ?? 0) - (firstCaches?.[cache]?.misses ?? 0);
    const lookups = hits + misses;
    return [cache, { hits, misses, rate: lookups === 0 ? null : hits / lookups }];
  }),
);
const quietScene =
  evidence.options.moverCount === 0 &&
  evidence.options.characterCount === 0 &&
  evidence.options.occasionalCount === 0 &&
  evidence.options.spawnStormCount === 0 &&
  !evidence.options.lodOscillate;
// Bundle admission needs a second matching frame after bootstrap, and TAA
// history segments first appear on frame 2, so admission settles by frame 3.
const admittedCaches = gpuDrivenSamples.find((sample) => sample.frame >= 4)?.frameCaches;
const admittedBundles = {
  hits: (lastCaches?.renderBundles.hits ?? 0) - (admittedCaches?.renderBundles.hits ?? 0),
  misses: (lastCaches?.renderBundles.misses ?? 0) - (admittedCaches?.renderBundles.misses ?? 0),
};
const stats = pixelStats(pixels);
const summary = {
  fingerprint: evidence.workloadFingerprint,
  cpuFrameMicros: distribution([...frameDurations.values()]),
  syncedFrameMicros: distribution(syncedFrameMicros),
  shadowRasterPassCount: distribution(samples.map((sample) => sample.passCount)),
  shadowRasterDrawCount: distribution(samples.map((sample) => sample.drawCount)),
  shadowTexelCulled: distribution(samples.map((sample) => sample.texelCulled)),
  shadowCameraCulled: distribution(samples.map((sample) => sample.cameraCulled)),
  shadowStaticMissCount: distribution(samples.map((sample) => sample.staticMissCount)),
  shadowStaticPartialCount: distribution(samples.map((sample) => sample.staticPartialCount ?? 0)),
  shadowMissCount: distribution(samples.map((sample) => sample.misses.length)),
  shadowMissReasons: reasons,
  capsuleShadow: evidence.capsuleShadow,
  gpuDriven,
  frameCacheHitRates,
  gpuPassMicros: Object.fromEntries(
    Object.entries(evidence.gpuPassNanos ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pass, nanos]) => [pass, distribution(nanos.map((value) => value / 1000))]),
  ),
};
const result = {
  backend: 'webgpu',
  observedFrames: evidence.completedFrames,
  drivenRafCallbacks,
  profileComplete,
  summary,
  cpuPhasesMicros,
  readback: { width, height, ...stats },
  ...(rhiCapture === undefined ? {} : { rhiCapture }),
  ...(withheldFeatures.size === 0 ? {} : { withheldFeatures: [...withheldFeatures] }),
  evidence: { ...evidence, profileCapture: undefined, gpuPassNanos: undefined },
  assertions: {
    completedReadyWindow:
      evidence.readyFrameId !== null &&
      evidence.completedFrames >= targetFrames &&
      evidence.pendingMeasuredFrames === 0,
    exactPostSpawn:
      evidence.postSpawn.staticCasterCount === evidence.options.staticCasterCount &&
      evidence.postSpawn.spotShadowCount === 4 &&
      evidence.postSpawn.directionalCascadeCount === 4,
    sampledEveryFrame: samples.length === sampleFrames,
    gpuDrivenSampledEveryFrame: evidence.gpuDrivenSamples.length === profileFrames + sampleFrames - 1,
    everyShadowViewReported: samples.every(
      (sample) =>
        sample.viewCount === expectedViewCount &&
        sample.staticLayerViewCount === expectedViewCount,
    ),
    texelCullingObserved:
      evidence.options.debrisCount === 0 || samples.some((sample) => sample.texelCulled > 0),
    // Only a Deferred frame orders shadows after the camera pyramid; the
    // low eye-height orbit hides casters whose receivers are all occluded.
    cameraCullingObserved:
      evidence.options.renderPath !== 'deferred' ||
      evidence.options.camera !== 'low' ||
      !evidence.options.gpuOcclusion ||
      samples.some((sample) => sample.cameraCulled > 0),
    forwardNeverCameraCulls:
      evidence.options.renderPath === 'deferred' ||
      samples.every((sample) => sample.cameraCulled === 0),
    passCountMatchesMisses: samples.every((sample) => sample.passCount === sample.misses.length),
    notClearOnly: stats.nonClearPixels > width * height * 0.2 && stats.lumaVariance > 0.00001,
    // A skinned draw bound to a stand-in palette collapses every character
    // onto the origin, where the static casters hide it. The low eye-height
    // view looks across the city, whose buildings hide the central characters.
    charactersVisible:
      evidence.options.characterCount === 0 ||
      evidence.options.camera === 'low' ||
      stats.characterPixels > 0,
    completeProfileNoDrops: profileComplete,
    noAppRendererErrors: evidence.appRendererErrors.length === 0,
    // A quiet scene changes no batch, so once every segment has been admitted
    // it must replay its retained bundle (a per-frame bind group would miss here).
    quietSceneReusesBundles:
      !quietScene || (admittedBundles.misses === 0 && admittedBundles.hits > 0),
    capsuleShadowsAdmitted:
      !evidence.options.capsuleShadow ||
      evidence.options.renderPath !== 'deferred' ||
      evidence.capsuleShadow?.admitted === evidence.options.characterCount,
  },
};
writeFileSync(outputPath, JSON.stringify(result, null, 2));
writeFileSync(screenshotPath, encodePng(width, height, pixels));

const failed = Object.entries(result.assertions).filter(([, value]) => value !== true);
if (failed.length > 0) fail(`assertions failed: ${JSON.stringify(Object.fromEntries(failed))}`);
console.log(`${TAG} PASS ${JSON.stringify({ observedFrames: result.observedFrames, profileComplete, summary, readback: result.readback })}`);
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
emitSmokeReceipt('perf-shadow-stress/smoke', result.observedFrames);
process.exit(0);
