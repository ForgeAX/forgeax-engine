#!/usr/bin/env node
// hello-picking headless smoke (feat-20260529-picking-raycasting-screen-to-entity
// M4 / w17). Structural-only (D-2): no pixel readback.
//
// Strategy: drive the engine ECS path with a single cube + a perspective camera
// on the dawn-node mock-canvas path, then call the runtime `pick` free function
// DIRECTLY with simulated viewport coordinates (no DOM click event). Verify:
//   (a) backend=webgpu
//   (b) a center-of-viewport pick returns the cube entity (hit, not undefined)
//   (c) hit.point / hit.distance are finite and distance >= 0
//   (d) a far-corner pick (empty space) returns undefined (miss)
//   (e) frames >= 60 with no draw crash
//   (f) Renderer.onError count == 0
//
// Why direct `pick(...)` instead of a synthetic DOM event: the smoke verifies the
// engine picking contract (ray -> AABB -> nearest entity), not browser event
// plumbing. The demo's `main.ts` owns the DOM click -> viewport-coordinate glue;
// the smoke feeds viewport coordinates straight in.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
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
  const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
  const { createBoxGeometry } = await import('@forgeax/engine-geometry');
  const { pick } = await import('@forgeax/engine-picking');
const { Materials } = await import('@forgeax/engine-render');
  const {
    Camera,
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
    perspective,
  } = await import('@forgeax/engine-render');
  const { propagateTransforms, Transform } = await import('@forgeax/engine-scene');

const world = new World();
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1], intensity: 1,
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

console.log(`[picking] backend=${renderer.inspect().capabilities.backendKind}`);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


// Custom cube mesh ensures AABB computation (the ray-AABB pick test reads it).
const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
if (!boxResult.ok) {
  console.error(`[smoke] FAIL - createBoxGeometry failed: ${boxResult.error.code}`);
  process.exit(1);
}
const cubeHandle = world.allocSharedRef('MeshAsset', boxResult.value);
const defaultHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([0.55, 0.55, 0.6, 1]));

// Cube at the origin + a perspective camera looking down -Z. The center of the
// viewport casts a ray straight through the origin -> the cube must be hit.
const cubeEntity = world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: cubeHandle } },
  { component: MeshRenderer, data: { materials: [defaultHandle] } },
).unwrap();

const cameraEntity = world.spawn(
  { component: Transform, data: { pos: [0, 0, 4]} },
  {
    component: Camera,
    data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, autoAspect: false }),
  },
).unwrap();

// --- 4. Frame loop ---

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
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
if (device) await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 5. Direct pick assertions (structural, no pixel readback) ---

const centerHit = pick(world, cameraEntity, WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT);
const cornerMiss = pick(world, cameraEntity, 1, 1, WIDTH, HEIGHT);
console.log(
  `[picking] centerHit=${centerHit ? `entity=${centerHit.entity} distance=${centerHit.distance.toFixed(3)}` : 'undefined'}`,
);
console.log(`[picking] cornerMiss=${cornerMiss === undefined ? 'undefined' : `entity=${cornerMiss.entity}`}`);

// --- 7. M18 live vertex recovery contract ---

const { pickVertex, pickVertexOnEntity } = await import('@forgeax/engine-picking');
const centerX = WIDTH / 2;
const centerY = HEIGHT / 2;
const m18Failures = [];
const isSorted = (hits) => hits.every((hit, index) => index === 0 || hits[index - 1].screenDist <= hit.screenDist);
const finiteVertexHit = (hit) =>
  Number.isFinite(hit.screenDist) && Number.isFinite(hit.worldDist) &&
  Number.isFinite(hit.worldPos[0]) && Number.isFinite(hit.worldPos[1]) && Number.isFinite(hit.worldPos[2]);

const baselinePropagation = propagateTransforms(world);
if (!baselinePropagation.ok) m18Failures.push(`baseline propagate failed: ${baselinePropagation.error.code}`);
const baselineVertices = pickVertex(world, cameraEntity, centerX, centerY, WIDTH, HEIGHT, { limit: 3 });
const baselineAllVertices = pickVertex(world, cameraEntity, centerX, centerY, WIDTH, HEIGHT, { limit: 64 });
const baselineEntityVertices = pickVertexOnEntity(
  world,
  cameraEntity,
  centerX,
  centerY,
  WIDTH,
  HEIGHT,
  cubeEntity,
  { limit: 3 },
);
console.log(`[picking] m18 baseline sceneVertices=${baselineVertices.length} entityVertices=${baselineEntityVertices.length}`);
if (baselineVertices.length === 0) m18Failures.push('baseline pickVertex returned no vertices');
if (baselineEntityVertices.length === 0) m18Failures.push('baseline pickVertexOnEntity returned no vertices');
if (!isSorted(baselineVertices) || !isSorted(baselineEntityVertices)) m18Failures.push('baseline vertex hits are not sorted');
if (baselineVertices.some((hit) => hit.entity !== cubeEntity || !finiteVertexHit(hit))) {
  m18Failures.push('baseline vertex hit identity or numeric fields are invalid');
}

const baselineAnchor = baselineAllVertices[0];
const transformUpdate = world.set(cubeEntity, Transform, { pos: [0.25, 0, 0] });
if (!transformUpdate.ok) m18Failures.push(`transform update failed: ${transformUpdate.error.code}`);
const movedPropagation = propagateTransforms(world);
if (!movedPropagation.ok) m18Failures.push(`moved propagate failed: ${movedPropagation.error.code}`);
const movedVertices = pickVertex(world, cameraEntity, centerX, centerY, WIDTH, HEIGHT, { limit: 3 });
const movedAllVertices = pickVertex(world, cameraEntity, centerX, centerY, WIDTH, HEIGHT, { limit: 64 });
console.log(`[picking] m18 afterTransform sceneVertices=${movedVertices.length}`);
if (movedVertices.length === 0) m18Failures.push('after-transform pickVertex returned no vertices');
if (!isSorted(movedVertices)) m18Failures.push('after-transform vertex hits are not sorted');
if (movedVertices.some((hit) => hit.entity !== cubeEntity || !finiteVertexHit(hit))) {
  m18Failures.push('after-transform vertex hit identity or numeric fields are invalid');
}
if (baselineAnchor) {
  const movedAnchor = movedAllVertices.find((hit) => hit.vertexIndex === baselineAnchor.vertexIndex);
  if (!movedAnchor) {
    m18Failures.push(`after-transform lost vertex identity ${baselineAnchor.vertexIndex}`);
  } else if (Math.abs(movedAnchor.worldPos[0] - baselineAnchor.worldPos[0] - 0.25) > 0.01) {
    m18Failures.push(
      `after-transform worldPos.x delta=${movedAnchor.worldPos[0] - baselineAnchor.worldPos[0]} (expected 0.25)`,
    );
  }
}

const cameraUpdate = world.set(cameraEntity, Camera, { aspect: 1.1, fov: Math.PI / 3 });
if (!cameraUpdate.ok) m18Failures.push(`camera update failed: ${cameraUpdate.error.code}`);
const cameraPropagation = propagateTransforms(world);
if (!cameraPropagation.ok) m18Failures.push(`camera propagate failed: ${cameraPropagation.error.code}`);
const afterCameraVertices = pickVertex(world, cameraEntity, centerX, centerY, WIDTH, HEIGHT, { limit: 3 });
const afterCameraEntityVertices = pickVertexOnEntity(
  world,
  cameraEntity,
  centerX,
  centerY,
  WIDTH,
  HEIGHT,
  cubeEntity,
  { limit: 3 },
);
const afterCameraMiss = pickVertex(world, cameraEntity, 1, 1, WIDTH, HEIGHT, { limit: 3 });
console.log(
  `[picking] m18 afterCamera sceneVertices=${afterCameraVertices.length} entityVertices=${afterCameraEntityVertices.length} cornerVertices=${afterCameraMiss.length}`,
);
if (afterCameraVertices.length === 0 || afterCameraEntityVertices.length === 0) {
  m18Failures.push('after-camera vertex query returned no hits');
}
if (!isSorted(afterCameraVertices) || !isSorted(afterCameraEntityVertices)) {
  m18Failures.push('after-camera vertex hits are not sorted');
}
if (afterCameraVertices.some((hit) => hit.entity !== cubeEntity || !finiteVertexHit(hit))) {
  m18Failures.push('after-camera vertex hit identity or numeric fields are invalid');
}
if (afterCameraMiss.length !== 0) m18Failures.push('after-camera corner query returned a hit');
if (m18Failures.length === 0) console.log('[picking] M18 live vertex recovery: PASS');

// --- 6. Verdict ---

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (!centerHit) {
  failures.push('(b) center pick returned undefined (expected the cube entity)');
} else if (centerHit.entity !== cubeEntity) {
  failures.push(`(b) center pick entity=${centerHit.entity} (expected cube entity=${cubeEntity})`);
}
if (centerHit) {
  const p = centerHit.point;
  const finite = Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) &&
    Number.isFinite(centerHit.distance);
  if (!finite) failures.push(`(c) hit.point/distance not finite: point=${JSON.stringify(p)} distance=${centerHit.distance}`);
  if (centerHit.distance < 0) failures.push(`(c) hit.distance=${centerHit.distance} < 0`);
}
if (cornerMiss !== undefined) {
  failures.push(`(d) corner pick returned a hit (entity=${cornerMiss.entity}); expected undefined (miss)`);
}
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(e) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(f) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
for (const failure of m18Failures) failures.push(`M18: ${failure}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-picking smoke`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 7 criteria GREEN: backend=webgpu, frames=${framesObserved}, centerHit=entity ${centerHit.entity}, cornerMiss=undefined, M18 live vertex recovery=PASS, RhiError count=0`,
);

device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
