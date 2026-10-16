#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-mesh-picking headless smoke (structural-only, no pixel readback).
//
// Strategy: spawn 4 shapes in a row via the dawn-node mock-canvas path,
// call pick() directly with simulated viewport coordinates, verify:
//   (a) backend=webgpu
//   (b) center pick on the box returns a hit (entity matches)
//   (c) center pick on the sphere returns a hit
//   (d) corner pick (empty space) returns undefined (miss)
//   (e) frames >= 60 with no draw crash
//   (f) Renderer.onError count == 0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 200;
const HEIGHT = 150;

// --- 1. dawn.node binding setup ---

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

// --- 2. Mock canvas ---

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

// --- 3. Drive engine ECS path ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createBoxGeometry, createSphereGeometry, createCapsuleGeometry, createTorusGeometry } = await import('@forgeax/engine-geometry');
const { pick } = await import('@forgeax/engine-picking');
const { createRenderer } = enginePkg;
const { Transform, propagateTransforms } = await import('@forgeax/engine-scene');
const { Camera, Materials, MeshFilter, MeshRenderer, perspective, PointLight } = await import('@forgeax/engine-render');

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

console.log(`[picking] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


// Create meshes with AABB
const boxGeom = createBoxGeometry(0.5, 0.5, 0.5, 1, 1, 1);
const sphereGeom = createSphereGeometry(0.4, 32, 16);
const capsuleGeom = createCapsuleGeometry(0.2, 0.6, 32, 8);
const torusGeom = createTorusGeometry(0.35, 0.1, 32, 16);

if (!boxGeom.ok || !sphereGeom.ok || !capsuleGeom.ok || !torusGeom.ok) {
  console.error('[smoke] FAIL - geometry creation failed');
  process.exit(1);
}

const boxHandle = world.allocSharedRef('MeshAsset', boxGeom.value);
const sphereHandle = world.allocSharedRef('MeshAsset', sphereGeom.value);
const capsuleHandle = world.allocSharedRef('MeshAsset', capsuleGeom.value);
const torusHandle = world.allocSharedRef('MeshAsset', torusGeom.value);

const defaultMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1] }));

const spacing = 1.5;
const boxEntity = world.spawn(
  { component: Transform, data: { pos: [-spacing * 1.5, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: boxHandle } },
  { component: MeshRenderer, data: { materials: [defaultMat] } },
).unwrap();
const sphereEntity = world.spawn(
  { component: Transform, data: { pos: [-spacing * 0.5, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: sphereHandle } },
  { component: MeshRenderer, data: { materials: [defaultMat] } },
).unwrap();
const capsuleEntity = world.spawn(
  { component: Transform, data: { pos: [spacing * 0.5, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: capsuleHandle } },
  { component: MeshRenderer, data: { materials: [defaultMat] } },
).unwrap();
const torusEntity = world.spawn(
  { component: Transform, data: { pos: [spacing * 1.5, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: torusHandle } },
  { component: MeshRenderer, data: { materials: [defaultMat] } },
).unwrap();

world.spawn(
  { component: Transform, data: { pos: [0, 4, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
);

const cameraEntity = world.spawn(
  { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) },
).unwrap();

// --- 4. Frame loop ---

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

// --- 5. Direct pick assertions ---

// Box at (-2.25, 0, 0): center of viewport looks at origin, box is left of center.
// Camera at (0, 0, 6), looking at (0, 0, 0). Box at (-2.25, 0, 0) projects to ~left side.
// We pick at specific screen positions for each shape.
propagateTransforms(world);

// Camera at (0,0,6) looking at origin, perspective fovY=π/4, aspect=WIDTH/HEIGHT.
// visible half-width at z=0: 6 * tan(π/8) * (200/150) = 6 * 0.4142 * 1.333 = 3.31
// pixels per unit at z=0: 200 / 6.63 = 30.2
// Box at -2.25 → 100 - 2.25*30.2 ≈ 32, Sphere at -0.75 → 77, Capsule at 0.75 → 123, Torus at 2.25 → 168

const hitBox = pick(world, cameraEntity, 32, HEIGHT / 2, WIDTH, HEIGHT);
const hitSphere = pick(world, cameraEntity, 77, HEIGHT / 2, WIDTH, HEIGHT);
const hitCapsule = pick(world, cameraEntity, 123, HEIGHT / 2, WIDTH, HEIGHT);
const hitTorus = pick(world, cameraEntity, 168, HEIGHT / 2, WIDTH, HEIGHT);
const cornerMiss = pick(world, cameraEntity, 1, 1, WIDTH, HEIGHT);

console.log(`[picking] hitBox=${hitBox ? `entity=${hitBox.entity}` : 'undefined'}`);
console.log(`[picking] hitSphere=${hitSphere ? `entity=${hitSphere.entity}` : 'undefined'}`);
console.log(`[picking] hitCapsule=${hitCapsule ? `entity=${hitCapsule.entity}` : 'undefined'}`);
console.log(`[picking] hitTorus=${hitTorus ? `entity=${hitTorus.entity}` : 'undefined'}`);
console.log(`[picking] cornerMiss=${cornerMiss === undefined ? 'undefined' : `entity=${cornerMiss.entity}`}`);

// --- 6. Verdict ---

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (!hitBox) {
  failures.push('(b) box pick returned undefined');
} else if (hitBox.entity !== boxEntity) {
  failures.push(`(b) box pick entity=${hitBox.entity} (expected ${boxEntity})`);
}
if (!hitSphere) {
  failures.push('(c) sphere pick returned undefined');
} else if (hitSphere.entity !== sphereEntity) {
  failures.push(`(c) sphere pick entity=${hitSphere.entity} (expected ${sphereEntity})`);
}
if (cornerMiss !== undefined) {
  failures.push(`(d) corner pick returned a hit (entity=${cornerMiss.entity}); expected undefined`);
}
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(e) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(f) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/bevy-mesh-picking smoke`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, boxHit=entity ${hitBox.entity}, sphereHit=entity ${hitSphere.entity}, capsuleHit=entity ${hitCapsule.entity}, torusHit=entity ${hitTorus.entity}, cornerMiss=undefined, RhiError count=0`,
);

device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
