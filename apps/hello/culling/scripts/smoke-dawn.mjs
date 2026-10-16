#!/usr/bin/env node
// hello-culling headless smoke (feat-20260528-frustum-culling M5 / w13).
//
// Strategy: drive the engine ECS path with a NxN cube grid and a revolving
// camera. Frustum culling runs unconditionally in the extract stage. Verify:
//   (a) backend=webgpu
//   (b) frames >= 60
//   (c) pixel readback epsilon <= 0.05
//   (d) at least one frame has culled > 0 (frustum culling is active)
//   (e) Renderer.onError count == 0
//   (f) culling semantic guard: the narrow-fov orbit camera leaves >= 80% of
//       the grid outside the frustum every frame, so maxVisible / total
//       <= 0.20 across the run (culling actually removes the majority)

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;
// 46 x 46 = 2116 cubes: the wide grid keeps the narrow-fov orbit camera's
// centre ray on a cube (far cubes project toward the horizon) and leaves the
// large majority outside the frustum every frame so the culling stat is
// observable.
const GRID_SIZE = 46;
const GRID_SPACING = 3;
const CAMERA_TARGET = [GRID_SPACING / 2, 0, GRID_SPACING / 2];

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
const geometryPkg = await import('@forgeax/engine-geometry');
const mathPkg = await import('@forgeax/engine-math');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { quat } = mathPkg;
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const world = new World();
// Spawn DirectionalLight
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
let renderDiagnostics;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  renderDiagnostics = constructed.value.debugDrawHost;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

console.log(`[culling] backend=${renderer.inspect().capabilities.backendKind}`);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  errors.push({ code: event.error.code, hint: event.error.hint, detail: event.error.detail });
});


// Register a custom cube mesh with a known AABB through the renderer's
// asset registry. The built-in HANDLE_CUBE uses engine-internal handle
// values; using a custom mesh ensures the AABB lookup path works on the
// dawn-node mock canvas path.
const { createBoxGeometry } = geometryPkg;
const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
if (!boxResult.ok) {
  console.error(`[smoke] FAIL - createBoxGeometry failed: ${boxResult.error.code}`);
  process.exit(1);
}
const customCubeHandle = world.allocSharedRef('MeshAsset', boxResult.value);

// Spawn cubes AFTER the renderer is ready (assets must be registered
// so AABB lookup succeeds). Frustum culling is unconditional; the orbit
// camera's narrow fov leaves most of the grid off-screen every frame so
// the culling stat stays observably active (mirrors apps/hello/culling/src/main.ts).
for (let ix = 0; ix < GRID_SIZE; ix++) {
  for (let iz = 0; iz < GRID_SIZE; iz++) {
    const gx = (ix - (GRID_SIZE - 1) / 2) * GRID_SPACING;
    const gz = (iz - (GRID_SIZE - 1) / 2) * GRID_SPACING;
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [gx, 0, gz],
          quat: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7],},
      },
      { component: MeshFilter, data: { assetHandle: customCubeHandle } },
      { component: MeshRenderer, data: { materials: [] } },
    );
  }
}

// Spawn camera — positioned to see a subset of cubes
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 4, 6],
      quat: quat.fromLookAt(quat.create(), [0, 4, 6], CAMERA_TARGET, [0, 1, 0]),
      scale: [1, 1, 1],
    },
  },
  {
    component: Camera,
    data: { fov: Math.PI / 5, aspect: 16 / 9, near: 0.1, far: 30 },
  },
).unwrap();

// --- 4. Frame loop ---

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
let maxCulled = 0;
let maxVisibleRatio = 0;
let maxVisible = 0;
let lastTotal = 0;
let angle = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
  angle += 0.003;
  const camDist = 8;
  const camX = Math.sin(angle) * camDist;
  const camZ = Math.cos(angle) * camDist;

  // Orbit camera around the grid
  world.set(cameraEntity, Transform, {
    pos: [camX, 4, camZ],
    quat: quat.fromLookAt(quat.create(), [camX, 4, camZ], CAMERA_TARGET, [0, 1, 0]),
    scale: [1, 1, 1],
  });

  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);

  // Low-level host diagnostics prove culling; public Renderer inspection is POD-only.
  const stats = renderDiagnostics.frustumStats;
  if (stats.culled > maxCulled) maxCulled = stats.culled;
  const visible = stats.total - stats.culled;
  if (visible > maxVisible) maxVisible = visible;
  const ratio = stats.total > 0 ? visible / stats.total : 0;
  if (ratio > maxVisibleRatio) maxVisibleRatio = ratio;
  lastTotal = stats.total;
  // Cap per-frame log noise; keep first 5 + every 50th.
  if (i < 5 || i % 50 === 0) {
    console.log(`[culling] culled=${stats.culled} total=${stats.total} visible=${visible}`);
  }

  framesObserved++;
  await delay(0);
}

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 5. Pixel readback ---

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const ndcCenter = readRgba(cx, cy);
const pixelSamples = { ndcCenter };
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 6. Verdict ---

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];
const dist = distance(ndcCenter, BLACK);

// culling semantic guard: with a narrow camera (fov=PI/5, far=30) orbiting at
// radius 8, frustum culling should drop >= 80% of cubes every frame.
// Threshold = 20% ratio.
const VISIBLE_RATIO_CEILING = 0.20;

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center pixel ${JSON.stringify(ndcCenter)} too close to black (distance ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD})`);
}
if (maxCulled === 0) {
  failures.push('(d) frustum culling never active: maxCulled=0 across all frames');
}
if (errors.length > 0) {
  const firstDetailJson = (() => {
    try { return JSON.stringify(errors[0]?.detail); } catch { return '<unstringifiable>'; }
  })();
  const codeCounts = {};
  for (const e of errors) codeCounts[e.code] = (codeCounts[e.code] ?? 0) + 1;
  const codes = Object.entries(codeCounts).map(([c, n]) => `${c}=${n}`).join(', ');
  failures.push(
    `(e) Renderer.onError fired ${errors.length} times: [${codes}]; first detail=${firstDetailJson}`,
  );
}
if (maxVisibleRatio > VISIBLE_RATIO_CEILING) {
  failures.push(
    `(f) culling semantic guard: maxVisible/total=${maxVisibleRatio.toFixed(3)} > ${VISIBLE_RATIO_CEILING} (max ${maxVisible}/${lastTotal}); frustum culling did not remove the majority`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-culling smoke`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${dist.toFixed(4)}, maxCulled=${maxCulled}, Renderer.onError count=0, maxVisible/total=${maxVisibleRatio.toFixed(3)} (<=${VISIBLE_RATIO_CEILING})`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
