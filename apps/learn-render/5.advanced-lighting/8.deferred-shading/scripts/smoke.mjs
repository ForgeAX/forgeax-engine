#!/usr/bin/env node
import { createSmokePlatform } from '../../../../../scripts/smoke-platform.mjs';
// apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/smoke.mjs
// feat-20260612-standard-deferred-shading-learn-render-5-8 M7 / w21.
//
// LearnOpenGL section 5.8 deferred-shading dawn-node smoke (structural-only).
// Spawns a configurable point-light count (default 32) + 9 cube 3x3 grid through Standard deferred opaque,
// renders 60 frames, and asserts no RhiError / no unknown onError codes.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-8-deferred] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const PROFILE_CAPTURE_PATH = process.env.FORGEAX_PROFILE_CAPTURE_PATH;
const PROFILE_DETAIL = process.env.FORGEAX_PROFILE_DETAIL === 'nested' ? 'nested' : 'owner';
const PROFILE_FRAME_LIMIT = Number.parseInt(
  process.env.FORGEAX_PROFILE_FRAME_LIMIT ?? String(SMOKE_MIN_FRAMES),
  10,
);
const PROFILE_EVENT_LIMIT = Number.parseInt(process.env.FORGEAX_PROFILE_EVENT_LIMIT ?? '100000', 10);
const PROFILE_SETTLE_AFTER_FRAMES = 16;
const PROFILE_SETTLE_MS = Number.parseInt(process.env.FORGEAX_PROFILE_SETTLE_MS ?? '25', 10);
const WIDTH = 512;
const HEIGHT = 512;

const DEFAULT_NUM_LIGHTS = 32;
const NUM_LIGHTS = (() => {
  const requested = process.env.FORGEAX_DEFERRED_LIGHTS;
  if (requested === undefined) return DEFAULT_NUM_LIGHTS;
  const parsed = Number(requested);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 256) return parsed;
  throw new Error('FORGEAX_DEFERRED_LIGHTS must be an integer in [1, 256]');
})();
const CUBE_SCALE = 0.5;
const CUBE_SPACING = 3.0;
const CUBE_Y = -0.5;

const here = dirname(fileURLToPath(import.meta.url));

// Known-noise app.onError codes during the Standard deferred demo.
const KNOWN_NOISE_CODES = new Set([
  'standard-light-budget-exceeded',
  'standard-cluster-index-overflow',
]);

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
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
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// rAF / cAF stubs must be installed BEFORE createApp; the engine's frame-loop
// captures the function reference at start() time, but ECS systems built during
// createApp may schedule rAF callbacks transitively.
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

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- 2. Mock canvas with offscreen render target ---

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

// --- 3. Build engine shader manifest for dawn-node (no Vite) ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

// --- 4. createApp + setup ---

const { createApp } = await import('@forgeax/engine-app/browser');
const { createProfileClock, createProfiler } = await import('@forgeax/engine-profiler');

const { Materials } = await import('@forgeax/engine-render');
const {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const profiler =
  PROFILE_CAPTURE_PATH === undefined
    ? undefined
    : createProfiler({
        // The smoke loop replaces performance.now() with a deterministic frame
        // clock, so diagnostic profiling must use an independent monotonic clock.
        clock: createProfileClock(() => Number(process.hrtime.bigint() / 1000n)),
      });
const standardLightCount = NUM_LIGHTS === 1 ? 1 : NUM_LIGHTS === 256 ? 256 : 32;
const appOptions = {
  standardProfile: {
    ...DEFAULT_STANDARD_PROFILE,
    lightCount: standardLightCount,
    renderPath: FALSIFY === 'force-forward' ? 'forward' : 'deferred',
  },
  ...(profiler === undefined ? {} : { profiler }),
};
const appResult = await createApp(mockCanvas, { ...(appOptions), platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
const inspection = app.renderer.inspect();
console.log(`[learn-render-5-8-deferred] backend=${inspection.capabilities.backendKind}`);
console.log(`[smoke] lights=${NUM_LIGHTS}`);

if (profiler !== undefined) {
  const started = profiler.startCapture({
    frameLimit: PROFILE_FRAME_LIMIT,
    eventLimit: PROFILE_EVENT_LIMIT,
    detail: PROFILE_DETAIL,
  });
  if (!started.ok) {
    console.error(`[smoke] FAIL - profiler.startCapture: ${started.error.code}`);
    process.exit(1);
  }
  console.log(
    `[smoke] profiler capture=${started.value.captureId} detail=${PROFILE_DETAIL} settleAfter=${PROFILE_SETTLE_AFTER_FRAMES} settleMs=${PROFILE_SETTLE_MS} frames=${PROFILE_FRAME_LIMIT} events=${PROFILE_EVENT_LIMIT}`,
  );
}

const onErrorEvents = [];
app.onError((err) => {
  const event = {
    code: err.code,
    expected: err.expected,
    hint: err.hint,
    detail: err.detail,
  };
  onErrorEvents.push(event);
  console.error(`[smoke] onError structured=${JSON.stringify(event)}`);
});


const assets = app.assets;
if (assets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const world = app.world;

// --- 5. Spawn 9 cubes in 3x3 grid ---

const cubeColors = [
  [1.0, 0.3, 0.3], [0.3, 1.0, 0.3], [0.3, 0.3, 1.0],
  [1.0, 1.0, 0.3], [0.3, 1.0, 1.0], [1.0, 0.3, 1.0],
  [0.7, 0.7, 0.3], [0.3, 0.7, 0.7], [0.7, 0.3, 0.7],
];
const cubeHandles = [];
let idx = 0;
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    const cx = (col - 1) * CUBE_SPACING;
    const cz = (row - 1) * CUBE_SPACING;
    const [r, g, b] = cubeColors[idx];

    const mat = Materials.standard({ baseColor: [r, g, b, 1] });
    const matHandle = world.allocSharedRef('MaterialAsset', mat);
    cubeHandles.push(matHandle);

    world.spawn(
      {
        component: Transform,
        data: {
          pos: [cx, CUBE_Y, cz], quat: [0, 0, 0, 1], scale: [CUBE_SCALE, CUBE_SCALE, CUBE_SCALE],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ).unwrap();
    idx++;
  }
}

// --- 6. glibc-compatible LCG: matches `srand(13)` + `rand()` from LO 5.8.1 ---

function glibcRand(state) {
  const next = ((state * 1103515245 + 12345) >>> 0) & 0x7fffffff;
  const value = (next >> 16) & 0x7fff;
  return [next, value];
}

function randomPosition(state) {
  const [s1, xv] = glibcRand(state);
  const [s2, yv] = glibcRand(s1);
  const [s3, zv] = glibcRand(s2);
  const x = ((xv % 100) / 100.0) * 6.0 - 3.0;
  const y = ((yv % 100) / 100.0) * 6.0 - 3.0;
  const z = ((zv % 100) / 100.0) * 6.0 - 3.0;
  return [x, y, z, s3];
}

function randomColor(state) {
  const [s1, rv] = glibcRand(state);
  const [s2, gv] = glibcRand(s1);
  const [s3, bv] = glibcRand(s2);
  const r = ((rv % 100) / 200.0) + 0.5;
  const g = ((gv % 100) / 200.0) + 0.5;
  const b = ((bv % 100) / 200.0) + 0.5;
  return [r, g, b, s3];
}

// --- 7. Spawn 32 point lights (deterministic seed=13) ---

let state = 13;
for (let i = 0; i < NUM_LIGHTS; i++) {
  const [px, py, pz, sa] = randomPosition(state);
  const [cr, cg, cb, sb] = randomColor(sa);
  state = sb;

  world.spawn(
    {
      component: Transform,
      data: { pos: [px, py, pz], quat: [0, 0, 0, 1]},
    },
    {
      component: PointLight,
      data: {
        color: [cr, cg, cb],
        intensity: 1.0,
        range: 6.0,
      },
    },
  );

  // Light-box visualization: small cube at each light position.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [px, py, pz], quat: [0, 0, 0, 1], scale: [0.125, 0.125, 0.125],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeHandles[0]] } },
  );
}

// Camera at (0, 1.5, 6) looking -Z.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.5, 6.0], quat: [0, 0, 0, 1]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.02, 0.02, 0.04, 1],
    },
  },
).unwrap();

// --- 8. Render 60 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  if (i % 16 === 15) await delay(i + 1 === PROFILE_SETTLE_AFTER_FRAMES ? PROFILE_SETTLE_MS : 1);
}

const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}
const disposeResult = await app.dispose();
if (!disposeResult.ok) {
  console.error(`[smoke] FAIL - app.dispose() returned err: ${disposeResult.error.code}`);
  process.exit(1);
}

if (profiler !== undefined && PROFILE_CAPTURE_PATH !== undefined) {
  const capture = profiler.latestCapture();
  if (capture === undefined) {
    console.error('[smoke] FAIL - profiler did not produce a capture');
    process.exit(1);
  }
  writeFileSync(PROFILE_CAPTURE_PATH, `${JSON.stringify(capture)}\n`);
  console.log(
    `[smoke] profiler capture written=${PROFILE_CAPTURE_PATH} records=${capture.records.length} completeness=${capture.completeness.status} dropped=${capture.completeness.droppedEventCount}`,
  );
}

console.log(`[smoke] frames observed=${totalFrames}`);

// --- 9. Verdict (structural-only) ---

const failures = [];
if (inspection.capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${inspection.capabilities.backendKind} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(c) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${totalFrames}, standardProfile=${FALSIFY === 'force-direct' ? 'direct' : 'clustered'}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
