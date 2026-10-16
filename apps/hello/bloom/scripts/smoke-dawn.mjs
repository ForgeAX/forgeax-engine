#!/usr/bin/env node
import { driveReadyAppFrames } from '../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-bloom headless smoke (feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w19).
//
// Strategy: createApp, spawn emissive sphere + cube scene with
// bloom-enabled Camera, start the app, run N frames, and assert the
// bloom pipeline compiled and drew without errors.
//
// This smoke verifies the full createApp -> bloom pipeline chain:
//   1. createApp(canvas, opts) succeeds.
//   2. host initialization succeeds (bloom shaders compiled as part of manifest).
//   3. app.start() + N-frame loop + app.stop() succeeds.
//   4. app.onError fires 0 times (covers pipeline compile + draw errors).
//   5. console.error fires 0 times.
//   6. frames >= SMOKE_MIN_FRAMES.
//   7. The per-frame render graph contains the 10 declarative Bloom
//      passes (five downsample / four upsample / bloom-composite)
//      — proves the bloom chain is wired in the compiled graph.
//   8. Camera bloom off -> on -> off transitions prove exact-zero roster
//      removal and re-admission without a second Standard post topology.
//   9. bug-20260622 resize guard (AC-01/AC-02/AC-07): after the original
//      frames, shrink the swap-chain texture and drive more frames without
//      settling. The recompile drains the old-size bloom transient pool while
//      a prior command buffer may still be in flight. Asserts zero NEW
//      app.onError during the resize phase — the immediate-destroy regression
//      raises "Destroyed texture used in a submit" through onuncapturederror.
//      This is the only smoke that walks the resize-then-render bug path.
//
// The carrier verdict combines the structural graph contract with a real
// copyTextureToBuffer readback. Numeric RGB aggregates and the independent
// carrier oracle prove that Bloom contributes to a non-black surface; hashes
// remain diagnostic only. The falsifier removes every scene radiance source
// while leaving the Bloom camera/graph and frame schedule unchanged.
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual error codes and frame count so AI users can self-diagnose.

import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';

const REQUESTED_FRAMES = smokeFrameBudget();
// GPU performance sampling has its own fixed window, independent of fleet soak.
const SMOKE_MIN_FRAMES = 60;
const FALSIFY_BLOOM = process.env.FORGEAX_BLOOM_FALSIFY === '1';
const CAPTURE_GPU_TIMINGS = process.env.FORGEAX_BLOOM_CAPTURE_TIMINGS === '1';
const EXPECTED_BLOOM_TIMING_PASSES = Object.freeze([
  'bloom-downsample-0',
  'bloom-downsample-1',
  'bloom-downsample-2',
  'bloom-downsample-3',
  'bloom-downsample-4',
  'bloom-upsample-3',
  'bloom-upsample-2',
  'bloom-upsample-1',
  'bloom-upsample-0',
  'bloom-composite',
]);

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
const realPerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

const bloomNativeAllocations = new Set();
const bloomNativeTotals = new Map();
const bloomNativePeak = { liveCount: 0, liveBytes: 0 };

function bloomNativeLabel(label) {
  return typeof label === 'string' && label.startsWith('bloom-');
}

function descriptorExtent(size) {
  if (Array.isArray(size)) {
    return { width: size[0] ?? 1, height: size[1] ?? 1, depth: size[2] ?? 1 };
  }
  return {
    width: size?.width ?? 1,
    height: size?.height ?? 1,
    depth: size?.depthOrArrayLayers ?? 1,
  };
}

function descriptorByteLength(kind, descriptor) {
  if (kind === 'texture') {
    const extent = descriptorExtent(descriptor?.size);
    const texelBytes = descriptor?.format === 'rgba16float' ? 8 : 0;
    return texelBytes * extent.width * extent.height * extent.depth * (descriptor?.sampleCount ?? 1);
  }
  if (kind === 'buffer') return descriptor?.size ?? 0;
  return 0;
}

function updateBloomNativePeak() {
  let liveCount = 0;
  let liveBytes = 0;
  for (const record of bloomNativeAllocations) {
    if (record.destroyed) continue;
    liveCount += 1;
    liveBytes += record.bytes;
  }
  bloomNativePeak.liveCount = Math.max(bloomNativePeak.liveCount, liveCount);
  bloomNativePeak.liveBytes = Math.max(bloomNativePeak.liveBytes, liveBytes);
}

function trackBloomNativeAllocation(kind, descriptor, handle) {
  const label = descriptor?.label;
  if (!bloomNativeLabel(label) || handle === null || typeof handle !== 'object') return;
  const record = {
    kind,
    label,
    bytes: descriptorByteLength(kind, descriptor),
    destroyed: false,
  };
  bloomNativeAllocations.add(record);
  // Update at the create boundary, not only at frame-submitted snapshots.
  // A transient can be created and destroyed between two snapshots during a
  // resize/reconfigure, and the sampled peak must not under-report it.
  updateBloomNativePeak();
  const totals = bloomNativeTotals.get(kind) ?? { created: 0, destroyed: 0 };
  totals.created += 1;
  bloomNativeTotals.set(kind, totals);
  const destroy = handle.destroy;
  if (typeof destroy !== 'function') return;
  handle.destroy = function trackedBloomDestroy(...args) {
    if (!record.destroyed) {
      record.destroyed = true;
      totals.destroyed += 1;
    }
    return destroy.apply(this, args);
  };
}

function bloomNativeSnapshot() {
  const byKind = {};
  const liveByKind = {};
  const createdByKind = {};
  const destroyedByKind = {};
  let liveCount = 0;
  let liveBytes = 0;
  for (const [kind, totals] of bloomNativeTotals) {
    createdByKind[kind] = totals.created;
    destroyedByKind[kind] = totals.destroyed;
  }
  for (const record of bloomNativeAllocations) {
    if (record.destroyed) continue;
    liveByKind[record.kind] = (liveByKind[record.kind] ?? 0) + 1;
    liveCount += 1;
    liveBytes += record.bytes;
  }
  byKind.live = liveByKind;
  byKind.created = createdByKind;
  byKind.destroyed = destroyedByKind;
  updateBloomNativePeak();
  return {
    byKind,
    liveCount,
    liveBytes,
    peakLiveCount: bloomNativePeak.liveCount,
    peakLiveBytes: bloomNativePeak.liveBytes,
  };
}

function installBloomNativeAllocationProbe(device) {
  const methods = [
    ['createTexture', 'texture'],
    ['createBuffer', 'buffer'],
    ['createRenderPipeline', 'renderPipeline'],
    ['createComputePipeline', 'computePipeline'],
    ['createBindGroup', 'bindGroup'],
    ['createBindGroupLayout', 'bindGroupLayout'],
    ['createPipelineLayout', 'pipelineLayout'],
    ['createSampler', 'sampler'],
  ];
  for (const [methodName, kind] of methods) {
    const original = device[methodName];
    if (typeof original !== 'function') continue;
    device[methodName] = function probeBloomNativeCreate(descriptor, ...args) {
      const handle = original.call(this, descriptor, ...args);
      trackBloomNativeAllocation(kind, descriptor, handle);
      return handle;
    };
  }
}

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) {
      sharedDevice = dev;
      installBloomNativeAllocationProbe(dev);
    }
    return dev;
  };
  return adapter;
};

// bug-20260622: the swap-chain texture dimensions drive recordFrame's
// targetW/targetH (read off getCurrentTexture().width/height). Switching the
// returned texture to a smaller one mid-run makes the render-graph
// setSwapChainSize() report needsRecompile -> recompile -> drainTransient(),
// which retires the old-size bloom transient pool textures. The deferred-
// destroy fix (pendingDestroy + reclaimRetiredTransients) must keep those
// textures alive until the in-flight command buffer retires; the old buggy
// path destroyed them immediately and the next queue.submit raised
// "Destroyed texture used in a submit", surfaced via onuncapturederror ->
// app.onError. This resize step is the only smoke that walks that path.
let renderTarget;
let renderTargetW = WIDTH;
let renderTargetH = HEIGHT;
let renderTargetFormat = 'rgba8unorm';
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTargetFormat = format;
  renderTarget = device.createTexture({
    size: { width: renderTargetW, height: renderTargetH, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
function resizeRenderTarget(device, width, height) {
  renderTargetW = width;
  renderTargetH = height;
  const next = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: renderTargetFormat,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTarget = next;
  return next;
}
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app/browser');

const renderPkg = await import('@forgeax/engine/render');
const scenePkg = await import('@forgeax/engine-scene');
const {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} = renderPkg;
const { Transform } = scenePkg;
const {
  HANDLE_CUBE,
  HANDLE_SPHERE,
} = await import('@forgeax/engine-assets-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = URL.createObjectURL(new Blob([readFileSync(MANIFEST_PATH)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

const appResult = await createApp(
  mockCanvas,
  { ...(CAPTURE_GPU_TIMINGS
    ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 8, retentionFrames: 8 } }
    : {}), platform: createSmokePlatform(mockCanvas) },
  { shaderManifestUrl: MANIFEST_URL },
).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-bloom] backend=${app.renderer.inspect().capabilities.backendKind}`);

// Register standard PBR material (non-emissive).
const assets = app.assets;
if (assets === null) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const matHandle = app.world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: FALSIFY_BLOOM ? [0.0, 0.0, 0.0] : [0.7, 0.7, 0.7],
    metallic: 0.0,
    roughness: 0.4,
  },
});

// Mint emissive material (emissiveIntensity > 1.0 feeds bloom).
const emissiveHandle = app.world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: FALSIFY_BLOOM ? [0.0, 0.0, 0.0] : [1.0, 0.85, 0.55],
    metallic: 0.0,
    roughness: 0.3,
    emissive: FALSIFY_BLOOM ? [0.0, 0.0, 0.0] : [1.0, 0.7, 0.3],
    emissiveIntensity: FALSIFY_BLOOM ? 0.0 : 2.0,
  },
});

// Spawn emissive sphere (left) and non-emissive cube (right).
app.world.spawn(
  {
    component: Transform,
    data: { pos: [-0.6, 0.2, 0], quat: [0, 0, 0, 1], scale: [0.6, 0.6, 0.6]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [emissiveHandle] } },
);

app.world.spawn(
  {
    component: Transform,
    data: { pos: [0.6, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);

// Directional light.
app.world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.4, -0.6, -0.7],
    color: [1, 1, 1],
    intensity: FALSIFY_BLOOM ? 0 : 1.5,
  },
});

// Camera with bloom ENABLED.
const cameraEntity = app.world.spawn(
  { component: Transform, data: { pos: [0, 0, 5]} },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      tonemap: TONEMAP_REINHARD_EXTENDED,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
    },
  },
).unwrap();

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint, detail: err.detail }));
const submittedFrameEvents = [];
const timingObservations = [];
const timingResourceSamples = [];
const timingErrors = [];
let timingStage = 'on';
const timingObservationPromises = [];
const unsubscribeRenderer = app.renderer.subscribe((event) => {
  if (event.kind !== 'frame-submitted' || event.receipt.presentation !== 'ready') return;
  submittedFrameEvents.push(event);
  if (!CAPTURE_GPU_TIMINGS) return;
  const stage = timingStage;
  const inspection = app.renderer.inspect();
  const stats = inspection.observation.resourceStats;
  timingResourceSamples.push({
    frameId: event.frameId,
    stage,
    bloom: inspection.bloom,
    resourceStats: stats === undefined ? null : {
      liveByteLength: stats.liveByteLength,
      liveCount: stats.liveCount,
      allocationCount: stats.allocationCount,
      peakLiveCount: stats.peakLiveCount,
    },
    nativeBloom: bloomNativeSnapshot(),
  });
  const timingObservation = (async () => {
    const completed = await event.receipt.completed;
    if (!completed.ok) {
      timingErrors.push({ frameId: event.frameId, code: completed.error.code, detail: completed.error.detail });
      return;
    }
    const observed = await app.renderer.observe(event.receipt, { include: ['timings'] });
    if (!observed.ok) {
      timingErrors.push({ frameId: event.frameId, code: observed.error.code, detail: observed.error.detail });
      return;
    }
    const timings = observed.value.timings;
    if (timings === undefined) {
      timingErrors.push({ frameId: event.frameId, code: 'renderer-timing-unavailable' });
      return;
    }
    timingObservations.push({ frameId: event.frameId, stage, timings });
  })().catch((cause) => {
    timingErrors.push({ frameId: event.frameId, code: 'timing-observation-threw', message: cause instanceof Error ? cause.message : String(cause) });
  });
  timingObservationPromises.push(timingObservation);
});


// Override performance.now for deterministic frame timing.
let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

const frameCreditTimeoutMs = Number.parseInt(
  process.env.FORGEAX_SMOKE_FRAME_CREDIT_TIMEOUT_MS ?? '5000',
  10,
);
const FRAME_CREDIT_TIMEOUT_MS =
  Number.isFinite(frameCreditTimeoutMs) && frameCreditTimeoutMs > 0 ? frameCreditTimeoutMs : 5_000;

async function waitForFrameCredit() {
  const deadline = Date.now() + FRAME_CREDIT_TIMEOUT_MS;
  while (app.execution.report().frame.inFlight >= 2) {
    if (Date.now() >= deadline) {
      originalConsoleError(
        `[smoke] frame credit did not settle within ${FRAME_CREDIT_TIMEOUT_MS}ms (inFlight=${app.execution.report().frame.inFlight})`,
      );
      return false;
    }
    // Dawn receipts settle asynchronously. Yield briefly so the completion
    // callback can release the App's two-frame credit before the next tick.
    await delay(1);
  }
  return true;
}

async function driveFrames(count) {
  return driveReadyAppFrames(app.renderer, async () => {
    if (!(await waitForFrameCredit())) return false;
    const due = rafQueue.shift();
    if (!due) return false;
    fakeNow += 16.67;
    due.cb(fakeNow);
  }, count);
}

function bloomPassNames() {
  return app.renderer.inspect().perFramePassNames.filter((name) => name.startsWith('bloom-'));
}

const transitionFailures = [];
function assertBloomRoster(label, expected) {
  const actual = bloomPassNames();
  const expectedNames = expected
    ? ['bloom-downsample-0', 'bloom-downsample-1', 'bloom-downsample-2', 'bloom-downsample-3', 'bloom-downsample-4', 'bloom-upsample-3', 'bloom-upsample-2', 'bloom-upsample-1', 'bloom-upsample-0', 'bloom-composite']
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    transitionFailures.push(`${label}: expected ${JSON.stringify(expectedNames)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`[smoke] bloom=${label} roster=${JSON.stringify(actual)}`);
}

async function readbackSurface(device, texture, width, height) {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = device.createBuffer({
    label: 'hello-bloom-readback',
    size: bytesPerRow * height,
    usage: 0x01 | 0x08,
  });
  const encoder = device.createCommandEncoder({ label: 'hello-bloom-readback-encoder' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  let nonBlackPixels = 0;
  let maxLuma = 0;
  let totalLuma = 0;
  const totalRgb = [0, 0, 0];
  const rgbBytes = new Uint8Array(width * height * 3);
  let rgbOffset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const r = bytes[offset] ?? 0;
      const g = bytes[offset + 1] ?? 0;
      const b = bytes[offset + 2] ?? 0;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (luma > 0.02) nonBlackPixels += 1;
      maxLuma = Math.max(maxLuma, luma);
      totalLuma += luma;
      totalRgb[0] += r / 255;
      totalRgb[1] += g / 255;
      totalRgb[2] += b / 255;
      rgbBytes[rgbOffset++] = r;
      rgbBytes[rgbOffset++] = g;
      rgbBytes[rgbOffset++] = b;
    }
  }
  const centerOffset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
  return {
    width,
    height,
    nonBlackPixels,
    maxLuma,
    meanLuma: totalLuma / (width * height),
    meanRgb: totalRgb.map((value) => value / (width * height)),
    pixelHash: createHash('sha256').update(bytes).digest('hex'),
    rgbHash: createHash('sha256').update(rgbBytes).digest('hex'),
    center: [
      (bytes[centerOffset] ?? 0) / 255,
      (bytes[centerOffset + 1] ?? 0) / 255,
      (bytes[centerOffset + 2] ?? 0) / 255,
      (bytes[centerOffset + 3] ?? 0) / 255,
    ],
  };
}

const evidenceStages = [];
async function captureStage(label, width, height, extra = {}) {
  await sharedDevice?.queue.onSubmittedWorkDone();
  const inspection = app.renderer.inspect();
  let readback;
  let readbackError;
  try {
    readback = await readbackSurface(sharedDevice, renderTarget, width, height);
  } catch (error) {
    readbackError = {
      code: 'readback-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const stage = {
    label,
    submittedFrames: submittedFrameEvents.length,
    roster: [...bloomPassNames()],
    bloom: inspection.bloom,
    readback,
    structuredErrors: [...onErrorEvents],
    ...(readbackError === undefined ? {} : { readbackError }),
    ...extra,
  };
  evidenceStages.push(stage);
  console.log(`[smoke] stage=${label} evidence=${JSON.stringify(stage)}`);
  return stage;
}

// Run frames at the original size and verify the exact on -> off ->
// intensity-zero-with-enum-on -> on roster.
let totalFrames = await driveFrames(CAPTURE_GPU_TIMINGS ? SMOKE_MIN_FRAMES : REQUESTED_FRAMES);
assertBloomRoster('on', true);
await captureStage('on', WIDTH, HEIGHT);

const offResult = app.world.set(cameraEntity, Camera, { bloom: BLOOM_DISABLED });
timingStage = 'off';
if (!offResult.ok) transitionFailures.push(`off toggle failed: ${offResult.error.code}`);
totalFrames += await driveFrames(3);
assertBloomRoster('off', false);
const offStage = await captureStage('off', WIDTH, HEIGHT);
if (
  offStage.bloom?.graphStatus !== 'empty' ||
  offStage.bloom?.targetCount !== 0 ||
  offStage.bloom?.targetBytes !== 0 ||
  offStage.bloom?.residentChildBytes !== 0
) {
  transitionFailures.push(
    `(off) Bloom exact-zero path retained graph resources: ${JSON.stringify(offStage.bloom)}`,
  );
}

const intensityZeroResult = app.world.set(cameraEntity, Camera, {
  bloom: BLOOM_ENABLED,
  bloomIntensity: 0,
});
timingStage = 'intensity-zero';
if (!intensityZeroResult.ok) {
  transitionFailures.push(`intensity-zero toggle failed: ${intensityZeroResult.error.code}`);
}
totalFrames += await driveFrames(3);
assertBloomRoster('intensity-zero', false);
await sharedDevice?.queue.onSubmittedWorkDone();
const intensityZeroInspection = app.renderer.inspect().bloom;
const intensityZeroRoster = bloomPassNames();
if (
  intensityZeroInspection.graphStatus !== 'empty' ||
  intensityZeroInspection.targetCount !== 0 ||
  intensityZeroInspection.targetBytes !== 0 ||
  intensityZeroInspection.residentChildBytes !== 0 ||
  intensityZeroInspection.resourceCount !== 0 ||
  intensityZeroInspection.passCount !== 0 ||
  intensityZeroInspection.encodeCount !== 0 ||
  intensityZeroInspection.bindGroupCount !== 0 ||
  intensityZeroInspection.uploadCount !== 0
) {
  transitionFailures.push(
    `(intensity-zero) Bloom exact-zero path retained graph resources: ${JSON.stringify(intensityZeroInspection)}`,
  );
}

const intensityRestoreResult = app.world.set(cameraEntity, Camera, { bloomIntensity: 1 });
timingStage = 'on';
if (!intensityRestoreResult.ok) {
  transitionFailures.push(`intensity restore failed: ${intensityRestoreResult.error.code}`);
}
totalFrames += await driveFrames(3);
assertBloomRoster('on-recovered', true);
await captureStage('re-enabled', WIDTH, HEIGHT);

// bug-20260622 resize step (AC-01/AC-02/AC-07): shrink the swap-chain texture
// and immediately drive more frames WITHOUT settling. The first post-resize
// frame recompiles the render graph (setSwapChainSize -> drainTransient) while
// the prior frame's command buffer may still be in flight on the GPU. The
// deferred-destroy fix must keep the retired transient textures alive until
// reclaimRetiredTransients() observes onSubmittedWorkDone; the old buggy path
// destroyed them synchronously and the next queue.submit raised
// "Destroyed texture used in a submit", caught here via app.onError.
const RESIZE_W = Math.max(1, Math.floor(WIDTH / 2));
const RESIZE_H = Math.max(1, Math.floor(HEIGHT / 2));
const onErrorBeforeResize = onErrorEvents.length;
if (sharedDevice) {
  timingStage = 'resize';
  resizeRenderTarget(sharedDevice, RESIZE_W, RESIZE_H);
  mockCanvas.width = RESIZE_W;
  mockCanvas.height = RESIZE_H;
}
console.log(`[smoke] resize ${WIDTH}x${HEIGHT} -> ${RESIZE_W}x${RESIZE_H}`);
const RESIZE_FRAMES =
  process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' && !CAPTURE_GPU_TIMINGS ? 8 : 60;
const resizeFrames = await driveFrames(RESIZE_FRAMES);
totalFrames += resizeFrames;
await captureStage('resize', RESIZE_W, RESIZE_H, { resizeFrames });

const releaseResult = app.renderer.releaseSurface();
const restoreResult = app.renderer.restoreSurface();
timingStage = 'surface-reconfigure';
if (!releaseResult.ok) transitionFailures.push(`releaseSurface failed: ${releaseResult.error.code}`);
if (!restoreResult.ok) transitionFailures.push(`restoreSurface failed: ${restoreResult.error.code}`);
totalFrames += await driveFrames(3);
assertBloomRoster('surface-reconfigure', true);
await captureStage('surface-reconfigure', RESIZE_W, RESIZE_H, {
  release: releaseResult.ok ? 'ok' : releaseResult.error,
  restore: restoreResult.ok ? 'ok' : restoreResult.error,
});

// Restore real performance.now and wait for any pending GPU work to settle.
globalThis.performance.now = realPerformanceNow;
await delay(2000);
if (CAPTURE_GPU_TIMINGS) await Promise.all(timingObservationPromises);

function nearestRank(values, rank) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(rank * ordered.length) - 1));
  return ordered[index] ?? null;
}

const stableTimingObservations = timingObservations
  .filter((entry) => entry.stage === 'on' && entry.timings.status === 'complete')
  .slice(0, SMOKE_MIN_FRAMES);
const bloomTimingSamples = new Map();
const frameTimingSamples = [];
const bloomFrameTimingSamples = [];
const timingPassShapeFailures = [];
for (const observation of stableTimingObservations) {
  const frame = observation.timings.frame;
  frameTimingSamples.push(frame.measuredPassNanoseconds);
  const bloomPasses = frame.passes.filter((pass) => pass.passName.startsWith('bloom-'));
  bloomFrameTimingSamples.push(bloomPasses.reduce((sum, pass) => sum + (pass.durationNanoseconds ?? 0), 0));
  const observedPassNames = bloomPasses.map((pass) => pass.passName);
  const missing = EXPECTED_BLOOM_TIMING_PASSES.filter((passName) => !observedPassNames.includes(passName));
  const unexpected = observedPassNames.filter((passName) => !EXPECTED_BLOOM_TIMING_PASSES.includes(passName));
  const duplicate = EXPECTED_BLOOM_TIMING_PASSES.filter((passName) => observedPassNames.filter((name) => name === passName).length !== 1);
  const unmeasured = bloomPasses.filter((pass) => pass.status !== 'measured').map((pass) => ({ passName: pass.passName, status: pass.status }));
  if (missing.length > 0 || unexpected.length > 0 || duplicate.length > 0 || unmeasured.length > 0) {
    timingPassShapeFailures.push({ frameId: observation.frameId, missing, unexpected, duplicate, unmeasured });
  }
  for (const pass of frame.passes) {
    if (pass.status !== 'measured' || !pass.passName.startsWith('bloom-')) continue;
    const samples = bloomTimingSamples.get(pass.passName) ?? [];
    samples.push(pass.durationNanoseconds);
    bloomTimingSamples.set(pass.passName, samples);
  }
}
const stableResourceSamples = timingResourceSamples
  .filter((entry) => entry.stage === 'on')
  .slice(0, SMOKE_MIN_FRAMES);
const stableNativeResourceSamples = stableResourceSamples
  .map((entry) => entry.nativeBloom)
  .filter((entry) => entry !== undefined && entry !== null);
const firstNativeResourceSample = stableNativeResourceSamples[0] ?? null;
const lastNativeResourceSample = stableNativeResourceSamples.at(-1) ?? null;
const nativeResourceSignature = (entry) => {
  if (entry === null) return null;
  return JSON.stringify({
    byKind: entry.byKind,
    liveCount: entry.liveCount,
    liveBytes: entry.liveBytes,
  });
};
const nativeResourceSignatures = stableNativeResourceSamples.map(nativeResourceSignature);
const firstNativeResourceSignature = nativeResourceSignatures[0] ?? null;
const nativeResourceDriftFrames = nativeResourceSignatures.reduce((frames, signature, index) => {
  if (signature !== firstNativeResourceSignature) {
    frames.push(stableResourceSamples[index]?.frameId ?? null);
  }
  return frames;
}, []);
const nativeResourceDelta = (first, last, bucket, kind) =>
  (last?.byKind?.[bucket]?.[kind] ?? 0) - (first?.byKind?.[bucket]?.[kind] ?? 0);
const nativeStableCreatedDelta = Object.fromEntries(
  ['texture', 'buffer', 'renderPipeline', 'computePipeline', 'bindGroup', 'bindGroupLayout', 'pipelineLayout', 'sampler']
    .map((kind) => [kind, nativeResourceDelta(firstNativeResourceSample, lastNativeResourceSample, 'created', kind)]),
);
const nativeStableDestroyedDelta = Object.fromEntries(
  ['texture', 'buffer', 'renderPipeline', 'computePipeline', 'bindGroup', 'bindGroupLayout', 'pipelineLayout', 'sampler']
    .map((kind) => [kind, nativeResourceDelta(firstNativeResourceSample, lastNativeResourceSample, 'destroyed', kind)]),
);
const nativeResourceKindsObserved = ['texture', 'buffer', 'renderPipeline'].every(
  (kind) => (firstNativeResourceSample?.byKind?.created?.[kind] ?? 0) > 0,
);
const nativeResourcesStable =
  stableNativeResourceSamples.length >= SMOKE_MIN_FRAMES &&
  nativeResourceKindsObserved &&
  nativeResourceDriftFrames.length === 0 &&
  Object.values(nativeStableCreatedDelta).every((delta) => delta === 0) &&
  Object.values(nativeStableDestroyedDelta).every((delta) => delta === 0);
const bloomResourceSignature = (entry) => {
  const bloom = entry?.bloom;
  if (bloom === undefined || bloom === null) return null;
  return JSON.stringify({
    levelCount: bloom.levelCount,
    levelDimensions: bloom.levelDimensions,
    targetCount: bloom.targetCount,
    targetBytes: bloom.targetBytes,
    resourceCount: bloom.resourceCount,
    passCount: bloom.passCount,
    encodeCount: bloom.encodeCount,
    bindGroupCount: bloom.bindGroupCount,
    uploadCount: bloom.uploadCount,
    residentChildBytes: bloom.residentChildBytes,
    generation: bloom.generation,
    state: bloom.state,
  });
};
const resourceSignatures = stableResourceSamples.map(bloomResourceSignature);
const firstResourceSignature = resourceSignatures[0] ?? null;
const resourceDriftFrames = resourceSignatures.reduce((frames, signature, index) => {
  if (signature !== firstResourceSignature) frames.push(stableResourceSamples[index]?.frameId ?? null);
  return frames;
}, []);
const passSampleCounts = Object.fromEntries(EXPECTED_BLOOM_TIMING_PASSES.map((passName) => [passName, bloomTimingSamples.get(passName)?.length ?? 0]));
const timingValuesFinite = frameTimingSamples.every(Number.isFinite) && EXPECTED_BLOOM_TIMING_PASSES.every((passName) => (bloomTimingSamples.get(passName) ?? []).every(Number.isFinite));
const timingCompleteness = {
  expectedBloomPasses: EXPECTED_BLOOM_TIMING_PASSES,
  expectedSampleCount: SMOKE_MIN_FRAMES,
  observedStableFrames: stableTimingObservations.length,
  framePassShapeFailures: timingPassShapeFailures,
  bloomPassSampleCounts: passSampleCounts,
  resourceSamples: stableResourceSamples.length,
  resourceSignatureCount: new Set(resourceSignatures).size,
  resourceDriftFrames,
  nativeResourceSamples: stableNativeResourceSamples.length,
  nativeResourceSignatureCount: new Set(nativeResourceSignatures).size,
  nativeResourceDriftFrames,
  nativeResourceKindsObserved,
  nativeStableCreatedDelta,
  nativeStableDestroyedDelta,
  timingValuesFinite,
  passSamplesComplete: EXPECTED_BLOOM_TIMING_PASSES.every((passName) => passSampleCounts[passName] >= SMOKE_MIN_FRAMES),
  resourcesStable:
    stableResourceSamples.length >= SMOKE_MIN_FRAMES &&
    firstResourceSignature !== null &&
    resourceDriftFrames.length === 0 &&
    nativeResourcesStable,
};
const timingComplete = stableTimingObservations.length >= SMOKE_MIN_FRAMES && timingErrors.length === 0 && timingPassShapeFailures.length === 0 && timingValuesFinite && timingCompleteness.passSamplesComplete && timingCompleteness.resourcesStable;
const performanceEvidence = CAPTURE_GPU_TIMINGS
  ? {
      schemaVersion: 'hello-bloom-performance-dawn/2',
      measurement: { status: timingComplete ? 'pass' : 'fail', scope: 'timing completeness and resource stability' },
      budget: { status: 'not-evaluated', reason: 'this carrier declares no elapsed-time budget or physical-adapter admission' },
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      source: {
        path: 'apps/hello/bloom/scripts/smoke-dawn.mjs',
        sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      },
      backend: app.renderer.inspect().capabilities.backendKind,
      runner: { kind: 'dawn-node', id: 'webgpu' },
      requestedStableFrames: SMOKE_MIN_FRAMES,
      observedStableFrames: stableTimingObservations.length,
      status:
        timingComplete
          ? 'complete'
          : timingObservations.some((entry) => entry.timings.status === 'unavailable')
            ? 'unavailable'
            : 'failed',
      capability: stableTimingObservations[0]?.timings.frame === undefined
        ? { timestampQuery: app.renderer.inspect().capabilities.timestampQuery === true, timestampPeriodNanoseconds: app.renderer.inspect().capabilities.timestampPeriodNanoseconds ?? null }
        : { timestampQuery: true, timestampPeriodNanoseconds: stableTimingObservations[0].timings.frame.timestampPeriodNanoseconds },
      frame: {
        measuredPassNanoseconds: {
          median: nearestRank(frameTimingSamples, 0.5),
          p95: nearestRank(frameTimingSamples, 0.95),
          samples: frameTimingSamples.length,
        },
        bloomPassSumNanoseconds: {
          median: nearestRank(bloomFrameTimingSamples, 0.5),
          p95: nearestRank(bloomFrameTimingSamples, 0.95),
          samples: bloomFrameTimingSamples.length,
          definition: 'diagnostic sum of ten Bloom pass intervals, including repeated coverage; never exclusive cost or frame latency',
        },
      },
      bloomPasses: Object.fromEntries(EXPECTED_BLOOM_TIMING_PASSES.map((passName) => {
        const samples = bloomTimingSamples.get(passName) ?? [];
        return [passName, {
          medianNanoseconds: nearestRank(samples, 0.5),
          p95Nanoseconds: nearestRank(samples, 0.95),
          samples: samples.length,
        }];
      })),
      completeness: timingCompleteness,
      resourceStability: {
        sampleCount: timingResourceSamples.filter((entry) => entry.stage === 'on').slice(0, SMOKE_MIN_FRAMES).length,
        first: timingResourceSamples.find((entry) => entry.stage === 'on') ?? null,
        last: timingResourceSamples.filter((entry) => entry.stage === 'on').slice(0, SMOKE_MIN_FRAMES).at(-1) ?? null,
        parameterBytes: 5 * 256 + 4 * 256 + 16,
        parameterBreakdown: { downsample: 5 * 256, upsample: 4 * 256, composite: 16 },
        nativeBloom: {
          firstStable: firstNativeResourceSample,
          lastStable: lastNativeResourceSample,
          peakLiveCount: bloomNativePeak.liveCount,
          peakLiveBytes: bloomNativePeak.liveBytes,
          peakObservation: 'every intercepted Bloom-labeled create boundary plus frame snapshots',
          peakScope: 'API-visible Bloom-labeled GPUDevice resources; descriptor-derived bytes',
          stableCreatedDelta: nativeStableCreatedDelta,
          stableDestroyedDelta: nativeStableDestroyedDelta,
          note: 'Counts are intercepted at the real Dawn GPUDevice create/destroy boundary for labels beginning with bloom-. Peak accounting updates at creation before any transient can be destroyed, then at frame snapshots. Bytes are descriptor-derived allocation payloads; driver alignment and opaque pipeline memory are not exposed by WebGPU.',
        },
        note: 'residentChildBytes is the active logical Bloom texture lease; nativeBloom reports the real labeled WebGPU resource lifecycle, while driver-resident opaque memory remains unavailable by API contract',
      },
      errors: timingErrors,
      raw: timingObservations,
    }
  : undefined;
let timingFailure;
if (performanceEvidence !== undefined) {
  const performancePath = resolve(here, '..', 'evidence', 'performance-dawn-result.json');
  mkdirSync(resolve(here, '..', 'evidence'), { recursive: true });
  writeFileSync(performancePath, `${JSON.stringify(performanceEvidence, null, 2)}\n`);
  console.log(`[smoke] performance evidence=${performancePath}`);
  if (performanceEvidence.measurement.status !== 'pass') {
    timingFailure = `(k) requested GPU timing capture was incomplete: ${JSON.stringify({ status: performanceEvidence.status, observed: performanceEvidence.observedStableFrames, completeness: performanceEvidence.completeness, errors: performanceEvidence.errors.slice(0, 3) })}`;
  }
}

const onErrorAfterResize = onErrorEvents.length;
console.log(
  `[smoke] frames observed=${totalFrames} (resize phase=${resizeFrames}, onError pre-resize=${onErrorBeforeResize}, post-resize=${onErrorAfterResize})`,
);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const failures = [];
failures.push(...transitionFailures);
if (timingFailure !== undefined) failures.push(timingFailure);
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}

// Filter out known smoke-expected noise: the '[smoke]' prefix on our own logs.
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(`(b) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
}

if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}
if (submittedFrameEvents.length < SMOKE_MIN_FRAMES) {
  failures.push(
    `(f) successful Renderer submits=${submittedFrameEvents.length} < ${SMOKE_MIN_FRAMES}`,
  );
}

// bug-20260622 (e): the resize phase must not surface any new GPU validation
// error. A "Destroyed texture used in a submit" (immediate-destroy regression)
// fans out through onuncapturederror -> app.onError, incrementing onErrorEvents
// during the post-resize frames. onErrorBeforeResize === onErrorAfterResize
// proves the deferred-destroy fix keeps retired transients alive across the
// in-flight command buffer. resizeFrames > 0 guards against the resize phase
// silently skipping (an empty rafQueue would make this assertion vacuous).
if (resizeFrames === 0) {
  failures.push('(e) resize phase ran 0 frames; resize smoke is vacuous (rafQueue drained early)');
} else if (onErrorAfterResize !== onErrorBeforeResize) {
  const resizeErrors = onErrorEvents.slice(onErrorBeforeResize);
  failures.push(
    `(e) resize introduced ${onErrorAfterResize - onErrorBeforeResize} app.onError event(s) (destroyed-texture-in-submit regression?): ${JSON.stringify(resizeErrors)}`,
  );
}
const onStage = evidenceStages.find((stage) => stage.label === 'on');
if (onStage?.readback === undefined || offStage?.readback === undefined) {
  failures.push('(g) Bloom on/off stages did not produce GPU readback');
} else if (onStage.readback.nonBlackPixels === 0) {
  failures.push('(g0) Bloom contribution oracle: enabled output is all black');
} else if (
  onStage.readback.meanRgb === undefined ||
  offStage.readback.meanRgb === undefined ||
  onStage.readback.meanRgb.every(
    (channel, index) => Math.abs(channel - (offStage.readback.meanRgb[index] ?? 0)) <= 1e-6,
  )
) {
  failures.push(
    '(g) Bloom contribution oracle: on/off numeric RGB readback is identical; scene contribution did not reach the Bloom graph',
  );
}
if (onStage?.bloom?.graphStatus !== 'valid' || onStage?.bloom?.passCount !== 10) {
  failures.push(`(h) Bloom inspection did not report a valid ten-pass graph: ${JSON.stringify(onStage?.bloom)}`);
}
if (onStage?.bloom?.residentChildBytes !== onStage?.bloom?.targetBytes || onStage?.bloom?.residentChildBytes <= 0) {
  failures.push(`(h0) Bloom inspection did not report descriptor-derived resident bytes: ${JSON.stringify(onStage?.bloom)}`);
}
if (evidenceStages.length !== 5) {
  failures.push(`(i) expected five lifecycle evidence stages, got ${evidenceStages.length}`);
}
if (intensityZeroInspection.state !== 'off') {
  failures.push(`(j) intensity-zero Bloom state was not off: ${JSON.stringify(intensityZeroInspection)}`);
}

const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const evidenceFileName = FALSIFY_BLOOM ? 'falsify-dawn-result.json' : 'dawn-result.json';
const evidencePath = resolve(here, '..', 'evidence', evidenceFileName);
mkdirSync(resolve(here, '..', 'evidence'), { recursive: true });
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 'hello-bloom-evidence/1',
      sourceRevision,
      source: {
        path: 'apps/hello/bloom/scripts/smoke-dawn.mjs',
        sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      },
      backend: app.renderer.inspect().capabilities.backendKind,
      runner: { kind: 'dawn-node', id: 'webgpu' },
      successfulSubmittedFrames: submittedFrameEvents.length,
      intensityZero: {
        roster: intensityZeroRoster,
        bloom: intensityZeroInspection,
      },
      performance: performanceEvidence === undefined ? { status: 'not-requested' } : { status: performanceEvidence.status, measurement: performanceEvidence.measurement, budget: performanceEvidence.budget, observedStableFrames: performanceEvidence.observedStableFrames },
      stages: evidenceStages,
      structuredErrors: onErrorEvents,
      verdict: failures.length === 0 ? 'pass' : 'fail',
    },
    null,
    2,
  )}\n`,
);
console.log(`[smoke] evidence=${evidencePath}`);

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, app.onError=0, resize=${WIDTH}x${HEIGHT}->${RESIZE_W}x${RESIZE_H} (${resizeFrames}f, 0 new onError), backend=${app.renderer.inspect().capabilities.backendKind}`);

// smoke:all invokes this file again for timing and falsification. Only the
// correctness lifecycle emits the gate receipt; the outer command must also pass.
if (!CAPTURE_GPU_TIMINGS && !FALSIFY_BLOOM)
  emitSmokeReceipt('hello-bloom/smoke:all', submittedFrameEvents.length, 'smoke:all');

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
