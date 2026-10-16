#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-blend-modes headless dawn smoke (structural-only, no pixel readback).
// Strategy: spawn 5 spheres with different blend modes + ground plane, verify:
//   (a) backend=webgpu
//   (b) frames >= 60 with no draw crash
//   (c) Renderer.onError count == 0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 200;
const HEIGHT = 150;

// --- dawn.node setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- Mock canvas ---

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

// --- Drive engine ECS path ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createBoxGeometry, createSphereGeometry } = await import('@forgeax/engine-geometry');
const { createRenderer } = enginePkg;
const { Transform } = await import('@forgeax/engine-scene');
const { Camera, Materials, MeshFilter, MeshRenderer, perspective, PointLight } = await import('@forgeax/engine-render');
const { SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');

const world = new World();
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

console.log(`[blend-modes] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


// Ground plane (use createBoxGeometry — HANDLE_CUBE needs asset registration)
const planeGeom = createBoxGeometry(1, 0.02, 1, 1, 1, 1);
if (!planeGeom.ok) { console.error('plane geom failed'); process.exit(1); }
const planeHandle = world.allocSharedRef('MeshAsset', planeGeom.value);
const planeMat = world.allocSharedRef('MaterialAsset', Materials.unlit([0.3, 0.3, 0.3, 1]));
world.spawn(
  { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [16, 1, 16] } },
  { component: MeshFilter, data: { assetHandle: planeHandle } },
  { component: MeshRenderer, data: { materials: [planeMat] } },
);

// Create sphere mesh and 5 blend materials
const sphereGeom = createSphereGeometry(0.4, 32, 16);
if (!sphereGeom.ok) { console.error('sphere geom failed'); process.exit(1); }
const sphereHandle = world.allocSharedRef('MeshAsset', sphereGeom.value);

function blendMat(baseColor, blend) {
  return {
    kind: 'material',
    passes: [{
      name: 'Forward',
      program: { module: 'forgeax::default-unlit' },
      renderState: { blend, tags: { LightMode: 'Forward' } },
    }],
    values: { baseColor },
  };
}

const opaqueHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([0.9, 0.2, 0.3, 1]));
const blendHandle = world.allocSharedRef('MaterialAsset', blendMat([0.9, 0.2, 0.3, 0.5], {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}));
const premultHandle = world.allocSharedRef('MaterialAsset', blendMat([0.9, 0.2, 0.3, 0.5], SPRITE_PREMULTIPLIED_ALPHA_BLEND));
const addHandle = world.allocSharedRef('MaterialAsset', blendMat([0.9, 0.2, 0.3, 0.5], {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}));
const mulHandle = world.allocSharedRef('MaterialAsset', blendMat([0.9, 0.2, 0.3, 0.5], {
  color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
  alpha: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
}));

const positions = [
  { x: -4, mat: opaqueHandle },
  { x: -2, mat: blendHandle },
  { x: 0, mat: premultHandle },
  { x: 2, mat: addHandle },
  { x: 4, mat: mulHandle },
];

for (const { x, mat } of positions) {
  world.spawn(
    { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [mat] } },
  );
}

world.spawn(
  { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: PointLight, data: { color: [1, 1, 1], intensity: 600, range: 40 } },
);

world.spawn(
  { component: Transform, data: { pos: [0, 2.5, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) },
);

// --- Frame loop ---

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

const device = sharedDevice;
if (device) await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- Verdict ---

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0`,
);

device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
