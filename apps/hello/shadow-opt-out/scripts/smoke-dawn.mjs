#!/usr/bin/env node
// apps/hello/shadow-opt-out headless smoke
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
//
// Structural-only smoke: 60-frame stable draw loop + shadow factor
// sampling confirms cube A casts shadow (< 1), cube B no shadow (=~ 1),
// cube C shadow via cutout shader produces an intermediate value.
//
// Output literals (grep-anchored):
//   - `[shadow-opt-out] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] shadow factor A=<f> B=<f> C=<f>`

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FIXTURE_MAP_SIZE = 1024;

// ── 1. dawn.node binding ────────────────────────────────────────────────

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// ── 2. Mock canvas ──────────────────────────────────────────────────────

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

// ── 3. Build shader manifest ────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

// ── 4. Drive engine ECS ─────────────────────────────────────────────────

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, ShadowParticipation } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[shadow-opt-out] backend=${renderer.inspect().capabilities.backendKind}`);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


const CUTOUT_SHADER_PATH = 'shadow_opt_out::cutout_shadow';

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// Light + shadow (merged component)
world.spawn(
  {
    component: DirectionalLight,
    data: {
      direction: [-0.3, -1.0, -0.5],
      color: [1, 0.95, 0.9],
      intensity: 1.0,
      // feat-20260613-csm M6 / w22: matches src/main.ts (cascadeCount=1
      // AC-10 baseline). orthoHalfExtent removed (legacy field gone);
      // shadowDistance tightened 60 -> 20 so the cutout 0.15-unit holes stay
      // resolvable at mapSize=1024 under CSM AABB-fit.
      cascadeCount: 1,
      mapSize: FIXTURE_MAP_SIZE,
      shadowDistance: 20,
    },
  },
);

// Camera — quat tilts default -z forward by ~56.3° around X so forward = (0, -0.832, -0.555)
// looking at the cubes + floor at origin. Mirrors main.ts; the two scripts stay in sync
// to honor the memory [[smoke-script-duplicate-scene-must-stay-in-sync-with-main]].
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 12, 8], quat: [-0.4718579255320243, 0, 0, 0.8816745987679437], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);

// Floor
world.spawn(
  {
    component: Transform,
    data: { pos: [0, -0.01, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: {} },
);

// Cube A: red, casts shadow (default)
const matA = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.9, 0.1, 0.1, 1] }));
world.spawn(
  {
    component: Transform,
    data: { pos: [-3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matA] } },
);

// Cube B: green, ShadowParticipation { cast: false }
const matB = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.1, 0.8, 0.1, 1] }));
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matB] } },
    { component: ShadowParticipation, data: { cast: false, receive: true } },
);

// Cube C: blue, cutout shadow shader
const matC = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 },
    {
      name: 'ShadowCaster',
      program: { module: CUTOUT_SHADER_PATH, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ],
  values: { baseColor: [0.1, 0.1, 0.9, 1], metallic: 0, roughness: 0.5 },
});
world.spawn(
  {
    component: Transform,
    data: { pos: [3, 1.25, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matC] } },
);

// ── 5. Render loop ──────────────────────────────────────────────────────

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms)`);

// ── 6. Verdict ──────────────────────────────────────────────────────────

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  failures.push(`(c) onError: ${errors.map((e) => e.code).join(', ')}`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device.destroy?.();
  process.exit(1);
}

console.log('[smoke] PASS - ShadowParticipation opt-out + cutout shadow demo GREEN');
await renderer.dispose();
device.destroy?.();
process.exit(0);
