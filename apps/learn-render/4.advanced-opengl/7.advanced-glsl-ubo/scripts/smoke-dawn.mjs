#!/usr/bin/env node
import { createSmokePlatform } from '../../../../../scripts/smoke-platform.mjs';
// apps/learn-render/4.advanced-opengl/7.advanced-glsl-ubo/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 7.advanced-glsl-ubo dawn-node smoke.
//
// Strategy (structural-only, plan D-4 / AC-06):
//   1. Inject globalThis.navigator.gpu via `webgpu` npm package (dawn-node).
//   2. Mock canvas + createApp (structural boot).
//   3. Spawn minimal proof scene: 3 cubes + camera + DirectionalLight.
//   4. Run N>=60 frames, collect RhiError via Renderer error event.
//   5. Assert: createApp boot OK + 0 RhiError + frames completed without crash.
//      No pixel assertion (UBO is engine-internal; no visible state toggle).
//   6. Charter P3 explicit failure: on fail, output structured diagnostic.
//
// Output literals (preserved for grep tooling):
//   `[learn-render-7-advanced-glsl-ubo] backend=webgpu`
//   `[smoke] structuralOnly={"frames":<N>,"bootOk":<bool>,"rhiErrors":<N>}`
//   `[smoke] PASS`

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const CLEAR_RGBA = [0.1, 0.1, 0.1, 1.0];

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo' smoke",
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);

// Capture the raw GPUDevice via requestAdapter monkey-patch so the mock canvas
// can allocate a real offscreen render target (the renderer.draw path needs a
// valid GPUTexture to draw into; structural-only smoke does no pixel readback).
let sharedDevice;
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// rAF shim so the createApp game-loop schedules in node. We drive the queue
// manually below (no real timer). performance.now is faked per tick.
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
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

// --- 2. Mock canvas ---

// tagName lets createApp(arg) dispatch into the canvas form; isConnected=true
// skips the canvas-detached fail-fast (createApp.ts step 1). getContext returns
// a shim whose configure() allocates a real offscreen render target.
let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
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

// --- 3. Engine imports + createApp bootstrap ---

const enginePkg = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
// createApp lives in @forgeax/engine-app, not @forgeax/engine-runtime.
const { createApp } = await import('@forgeax/engine-app/browser');
const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);

const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

const appRes = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL });

globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appRes.ok) {
  console.error(`[smoke] FAIL - createApp boot failed: ${appRes.error.code} hint=${appRes.error.hint}`);
  process.exit(1);
}
const app = appRes.value;
const renderer = app.renderer;
const world = app.world;
const assets = app.assets;

console.log(`[learn-render-7-advanced-glsl-ubo] backend=${renderer.inspect().capabilities.backendKind}`);

// --- 4. RhiError collection ---

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// --- 5. Spawn minimal proof scene (AC-05) ---

// Three cubes in a row with standard PBR material.
const matHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
  baseColor: [0.8, 0.8, 0.8, 1],
  metallic: 0.0,
  roughness: 0.5,
}));

// Spawn three cubes: left, center, right.
for (let i = -1; i <= 1; i++) {
  world.spawn(
    {
      component: Transform,
      data: { pos: [i * 1.5, 0, 0]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );
}

// DirectionalLight for PBR shading.
world.spawn({
  component: DirectionalLight,
  data: { castShadow: true,
    direction: [-0.4, -0.6, -0.7],
    color: [1, 1, 1],
    intensity: 1.5,
  },
});

// Camera with perspective projection.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 6]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
    },
  },
);

// --- 6. Draw frames via the createApp game-loop (rAF-driven) ---

// app.start() arms the game loop; the loop queues its next tick inside the
// rAF callback (createFrameLoop), so we drain the queue manually with a faked
// monotonic clock. This exercises the real createApp frame path (NOT a manual
// world.update + renderer.draw bypass).
// Monkey-patch performance.now BEFORE app.start() so the frame-loop's initial
// lastTimestamp reads the fake value, not a large real timestamp.
// Otherwise the first tick computes a negative delta and world.update()
// returns time-delta-invalid.
let fakeNow = 0;
const realPerformanceNow = globalThis.performance.now.bind(globalThis.performance);
globalThis.performance.now = () => fakeNow;

let crashed = false;
const startRes = app.start();
if (!startRes.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startRes.error.code}`);
  process.exit(1);
}

let framesObserved = 0;
try {
  for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
    framesObserved++;
  }
} catch (err) {
  crashed = true;
  console.error(`[smoke] crash at frame: ${err instanceof Error ? err.message : String(err)}`);
}
globalThis.performance.now = realPerformanceNow;

const stopRes = app.stop();
if (!stopRes.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopRes.error.code}`);
  process.exit(1);
}
const disposeRes = await app.dispose();
if (!disposeRes.ok) {
  console.error(`[smoke] FAIL - app.dispose() returned err: ${disposeRes.error.code}`);
  process.exit(1);
}

// --- 7. Verdict ---

const failures = [];

// (a) Backend must be webgpu.
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}

// (b) No crash.
if (crashed) {
  failures.push('(b) render loop crashed');
}

// (c) createApp boot OK (verified above, but detect state):
if (!appRes.ok) {
  failures.push(`(c) createApp boot failed: ${appRes.error.code}`);
}

// (d) 0 RhiError.
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) RhiError count=${errors.length}: [${codes}]`);
}

// (e) Frames actually advanced.
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(e) frames observed=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}

console.log(
  `[smoke] structuralOnly=${JSON.stringify({
    frames: framesObserved,
    bootOk: appRes.ok,
    rhiErrors: errors.length,
    crashed,
  })}`,
);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, frames=${framesObserved}, ` +
    `boot=OK, RhiError count=${errors.length}, crashed=${crashed}`,
);

emitSmokeReceipt(
  'app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo/smoke',
  framesObserved,
);

// Synchronously walk dawn-node's destruction graph in spec order so the
// renderer's module-level GPU resources (e.g. SSAO ShaderModule / Pipelines /
// BGL captured in the Runtime-owned host -- renderer disposal deliberately
// drops JS refs but does NOT destroy the device per w25 chromium-pool lesson)
// are released before V8 process teardown. Without this pair, dawn native
// dtors race process exit -> SIGSEGV (PR #397 4.7 smoke regression).
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
