#!/usr/bin/env node
import { createSmokePlatform } from '../../../../../../scripts/smoke-platform.mjs';
// apps/learn-render/5.advanced-lighting/3.1.shadow-mapping/3.full/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M2 / M2-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3.1 directional production shadow dawn-node smoke
// (structural-only). Spawns wood-floor + 6 cubes + DirectionalLight +
// DirectionalLight with castShadow (cascadeCount=1), renders 60 frames, and asserts
// no RhiError / no unknown onError codes.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-1-directional] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const WIDTH = 512;
const HEIGHT = 512;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

// Known-noise app.onError codes during shadow toggle demos.
const KNOWN_NOISE_CODES = new Set([]);

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

// rAF / cAF stubs must be installed BEFORE createApp.
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

// --- 3. Asset fixtures check ---

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + build shader manifest ---

const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    woodDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-5-3-1-directional] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

// --- 5. createApp + setup ---

const { createApp } = await import('@forgeax/engine-app/browser');

const runtimePkg = await import('@forgeax/engine-runtime');
const { createPlaneGeometry } = await import('@forgeax/engine-geometry');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');


const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-3-1-directional] backend=${app.renderer.inspect().capabilities.backendKind}`);

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
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


// --- 6. Register wood texture under its GUID ---

const woodGuidRes = AssetGuid.parse('019e3969-1d48-7c3b-ac24-6d68f457065f');
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const woodTexAsset = {
  kind: 'texture',
  shape: {
    viewDimension: '2d',
    extent: { width: woodDecoded.width, height: woodDecoded.height },
  },
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mips: woodDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};

const woodHandle = world.assets.create(woodTexAsset).unwrap();

// Floor material POJO with wood texture.
const floorMat = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_main' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
    {
      name: 'ShadowCaster',
      program: { module: 'forgeax::default-shadow-caster' },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ],
  values: {
    baseColorTexture: unwrapHandle(woodHandle),
  },
}).unwrap();

// --- 7. Spawn scene ---

// Floor plane: 20x20 on XZ at y=-0.5.
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);
const floorRes = createPlaneGeometry(20, 20);
if (!floorRes.ok) {
  console.error('[smoke] FAIL - createPlaneGeometry failed:', floorRes.error.code);
  process.exit(1);
}
const floorMesh = world.assets.create(floorRes.value).unwrap();
world.spawn(
  {
    component: Transform,
    data: { pos: [0, -0.5, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
  },
  { component: MeshFilter, data: { assetHandle: floorMesh } },
  { component: MeshRenderer, data: { materials: [floorMat] } },
).unwrap();

// 6 cubes at varying positions/sizes/colors.
const cubes = [
  { pos: [-3, 1.5, -2], scale: [1, 2, 1],color: [1, 0.3, 0.3] },
  { pos: [0, 0.5, -4], scale: [1, 1, 1],color: [0.3, 1, 0.3] },
  { pos: [3, 0.75, -1], scale: [1.5, 0.5, 1.5],color: [0.3, 0.3, 1] },
  { pos: [-4, 1, -5], scale: [0.5, 1.5, 0.5],color: [1, 1, 0.3] },
  { pos: [2, 0.5, -6], scale: [2, 1, 0.5],color: [1, 0.3, 1] },
  { pos: [-1, 0.5, -3], scale: [0.8, 0.8, 0.8],color: [0.3, 1, 1] },
];
for (const c of cubes) {
  const [r, g, b] = c.color;
  const mat = Materials.standard({ baseColor: [r, g, b, 1] });
  const matHandle = world.assets.create(mat).unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: c.pos,
        quat: [0, 0, 0, 1],
        scale: c.scale,
      },
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();
}

// Directional light with shadow.
const shadowPresent = FALSIFY !== 'force-no-shadow-pass';
const shadowFields = shadowPresent
  ? { castShadow: true, cascadeCount: 1, mapSize: 2048, depthBias: 0.00001, shadowDistance: 50, shadowFilter: 2, shadowAngularRadius: 0.00465, maxPenumbraTexels: 32 }
  : { castShadow: false };

if (!shadowPresent) {
  console.log('[smoke] FALSIFY=force-no-shadow-pass -- DirectionalLight castShadow=false');
}

world.spawn(
  {
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [0.2, -0.98, 0],
      color: [1, 1, 1], intensity: 1,
      ...shadowFields,
    },
  },
).unwrap();

// Camera at (0, 1.5, 8).
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.5, 8], quat: [0, 0, 0, 1]},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.02, 0.02, 0.04, 1],
    },
  },
).unwrap();

// Static camera (dawn-node smoke has no keyboard/mouse; structural-only).

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
  if (i % 16 === 15) await delay(1);
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

console.log(`[smoke] frames observed=${totalFrames}`);

// --- 9. Verdict (structural-only) ---

const failures = [];
if (app.renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.inspect().capabilities.backendKind} (expected webgpu)`);
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
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${totalFrames}, shadowPresent=${shadowPresent}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
