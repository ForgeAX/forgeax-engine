#!/usr/bin/env node
// parity-instancing-static headless smoke (feat-20260514-ecs-children-
// instances-managed-buffer-array M3 / w16; AC-06 main verification path).
//
// feat-20260604-instances-per-instance-transform-shader-group3-bin M3 / w13:
//   Hardened with multi-NDC sampling that proves instances are spread across
//   distinct grid positions (not collapsed at entity origin). The assertion
//   samples screen positions where spread-mode instances produce bright,
//   non-background pixels. FALSIFY=instances-collapse forces all
//   instance_local=I (collapse to entity origin), and the multi-sample
//   assertion must FAIL -- proving the gate is sensitive to spread vs
//   collapse.
//
// Evidence: with the 8x8x8 grid (spacing 2.0, camera (30,30,60) looking at
// origin, FOV 60 deg, 1280x720), spread-mode cubes near the front of the
// grid (z ~ -7) project to the lower portion of the screen as bright
// (0.737, 0.737, 0.737) pixels. In collapse mode, all cubes sit at origin
// (far from camera, single small pixel footprint) and the entire screen
// reads the uniform background (0.251, 0.251, 0.314). Sampling 5 known
// bright-pixel positions distinguishes the two states.

import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const FALSIFY_COLLAPSE = process.env.FALSIFY === 'instances-collapse';

const WIDTH = 1280;
const HEIGHT = 720;

// Grid form (parity smoke fixture). The same public collection path can be
// exercised at the acceptance populations without changing the fixture:
// `INSTANCE_COUNT=1500|10000|20000 SMOKE_MIN_FRAMES=600 pnpm ... smoke`.
const INSTANCE_COUNT = Number.parseInt(process.env.INSTANCE_COUNT ?? '512', 10);
const GRID_DIMS =
  INSTANCE_COUNT === 1500
    ? [10, 10, 15]
    : INSTANCE_COUNT === 10000
      ? [20, 20, 25]
      : INSTANCE_COUNT === 20000
        ? [25, 20, 40]
        : [8, 8, 8];
const [GRID_X, GRID_Y, GRID_Z] = GRID_DIMS;
const SPACING = 2.0;

// Camera:
const CAM_POS_X = 30;
const CAM_POS_Y = 30;
const CAM_POS_Z = 60;
const CAM_FOV = (60 * Math.PI) / 180;
const CAM_NEAR = 0.1;
const CAM_FAR = 1000;
const CAM_ASPECT = WIDTH / HEIGHT;

// Clear color:
const CLEAR_R = 0.05;
const CLEAR_G = 0.05;
const CLEAR_B = 0.08;

// --- 1. dawn.node binding setup ----------------------------------------------

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

// --- 2. Mock canvas with offscreen render target ----------------------------

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

// --- 3. Build engine scene --------------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createRenderer } = enginePkg;
const { Transform } = await import('@forgeax/engine-scene');
const { Camera, DirectionalLight, Instances, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

function buildTranslationGrid() {
  const halfX = ((GRID_X - 1) * SPACING) / 2;
  const halfY = ((GRID_Y - 1) * SPACING) / 2;
  const halfZ = ((GRID_Z - 1) * SPACING) / 2;
  const out = new Float32Array(INSTANCE_COUNT * 16);
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const x = i % GRID_X;
    const y = Math.floor(i / GRID_X) % GRID_Y;
    const z = Math.floor(i / (GRID_X * GRID_Y));
    const base = i * 16;
    out[base + 0] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    if (FALSIFY_COLLAPSE) {
      // All instances collapse to entity origin.
      out[base + 12] = 0;
      out[base + 13] = 0;
      out[base + 14] = 0;
    } else {
      out[base + 12] = x * SPACING - halfX;
      out[base + 13] = y * SPACING - halfY;
      out[base + 14] = z * SPACING - halfZ;
    }
    out[base + 15] = 1;
  }
  return out;
}

const world = new World();
world.spawn(
  {
    component: Transform,
    data: { pos: [CAM_POS_X, CAM_POS_Y, CAM_POS_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: CAM_FOV, aspect: CAM_ASPECT, near: CAM_NEAR, far: CAM_FAR } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.3, -1, -0.5], color: [1, 1, 1], intensity: 1 },
});

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let renderer;
try {
  const created = await createRenderer(mockCanvas, {}, { shaderManifestUrl: EMPTY_MANIFEST_URL });
  if (!created.ok) throw created.error;
  renderer = created.value;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: {} },
  { component: Instances, data: { transforms: buildTranslationGrid() } },
);

console.log(`[parity-instancing-static] backend=${renderer.inspect().capabilities.backendKind}`);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
let firstCollectionInspection;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
  }
  if (i === 0) {
    firstCollectionInspection = renderer
      .inspect()
      .instanceCollections[0];
  }
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 4. Pixel readback + multi-NDC assertion ---------------------------------

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
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

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];

// Multi-NDC sampling: screen positions where spread-mode front-grid
// cubes project as bright pixels (empirically verified: 0.737 vs
// collapse-mode background 0.251). These positions probe distinct
// world-space grid locations, so they are sensitive to spread vs
// collapse.
//
// Positions (empirically verified on 1280x720, camera (30,30,60) looking
// at origin, FOV 60 deg, 8x8x8 grid spacing 2.0):
//
//   SPREAD mode          COLLAPSE mode
//   (300,568): 0.737     (300,568): 0.251  -- front-right-bottom cube face
//   (320,568): 0.737     (320,568): 0.251  -- adjacent cube on same row
//   (350,568): 0.737     (350,568): 0.251  -- mid-front cube
//   (370,568): 0.737     (370,568): 0.251  -- front-left cube
//   (640,360): 0.251     (640,360): 0.251  -- NDC center (background in both)
//
// The center sample anchors the background value; boundary samples probe
// spread vs collapse. In SPREAD mode, >=3 of the 4 boundary samples must
// show bright pixel values (distance from background > 0.1). In COLLAPSE
// mode, <=1 boundary sample may (accidentally) hit geometry; >=3 must
// match background.
const SAMPLE_POINTS = [
  { label: 'front-right-bottom-300', sx: 300, sy: 568 },
  { label: 'front-mid-320', sx: 320, sy: 568 },
  { label: 'front-mid-350', sx: 350, sy: 568 },
  { label: 'front-left-370', sx: 370, sy: 568 },
  { label: 'ndc-center', sx: Math.floor(WIDTH / 2), sy: Math.floor(HEIGHT / 2) },
];

// Background reference: the uniform ambient fill that covers the screen
// when no geometry is present. Empirically measured as (0.251, 0.251, 0.314).
// We sample the NDC center (which is background in both modes for this grid)
// as the per-run background reference to tolerate minor driver variance.
const centerPixel = readRgba(SAMPLE_POINTS[4].sx, SAMPLE_POINTS[4].sy);
const BACKGROUND_REF = centerPixel;

console.log(`[smoke] backgroundRef (NDC center)=${JSON.stringify(BACKGROUND_REF.map(v => Number(v.toFixed(4))))}`);

// Visibility threshold: a pixel is "lit" if its distance from the background
// reference exceeds this. The background is ~(0.25,0.25,0.31) and bright
// cube faces are ~(0.74,0.74,0.74), so a threshold of 0.1 gives ample margin.
const VISIBILITY_THRESHOLD = 0.1;

const sampleResults = [];
let visibleCount = 0;
for (const sp of SAMPLE_POINTS) {
  const pixel = readRgba(sp.sx, sp.sy);
  const dist = distance(pixel, BACKGROUND_REF);
  const visible = dist > VISIBILITY_THRESHOLD;
  if (visible) visibleCount++;
  sampleResults.push({
    label: sp.label,
    pixel: [Number(pixel[0].toFixed(3)), Number(pixel[1].toFixed(3)), Number(pixel[2].toFixed(3))],
    distance: Number(dist.toFixed(4)),
    visible,
  });
}
console.log(`[smoke] samples (${FALSIFY_COLLAPSE ? 'COLLAPSE' : 'SPREAD'} mode): ${JSON.stringify(sampleResults)}`);

const collectionInspection = renderer
  .inspect()
  .instanceCollections[0];
console.log(
  `[smoke] collection=${JSON.stringify({
    requestedCount: INSTANCE_COUNT,
    firstUploadBytes: firstCollectionInspection?.uploadedBytes ?? 0,
    stableUploadBytes: collectionInspection?.uploadedBytes ?? 0,
    collectionId: collectionInspection?.collectionId,
    count: collectionInspection?.count,
    revision: collectionInspection?.revision,
    lane: collectionInspection?.lane,
    residentGeneration: collectionInspection?.residentGeneration,
    backend: collectionInspection?.backend,
  })}`,
);

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer error events fired ${errors.length} times: [${codes}]`);
}

if (
  INSTANCE_COUNT !== 512 &&
  (collectionInspection === undefined ||
    collectionInspection.count !== INSTANCE_COUNT ||
    (collectionInspection.uploadedBytes ?? 0) !== 0)
) {
  failures.push(
    `(e) collection inspection did not prove stable residency for ${INSTANCE_COUNT} instances`,
  );
}
if (firstCollectionInspection === undefined || (firstCollectionInspection.uploadedBytes ?? 0) <= 0) {
  failures.push('(f) first frame did not report a non-zero instance upload');
}

// The gate asserts spread: at least 3 of 4 boundary samples must show
// bright pixels coming from front-grid cube faces. FALSIFY=instances-collapse
// forces all instances to the entity origin, so the same boundary positions
// will read background (0/4 visible) and the assertion MUST fail -- proving
// the gate genuinely detects spread vs collapse.
//
// A FALSIFY run that PASSES would mean the gate cannot discriminate,
// i.e. it is a false green (same failure family as
// dawn-smoke-loose-threshold-masks-browser-black).
const boundaryVisible = sampleResults.slice(0, 4).filter(s => s.visible).length;
const MIN_BOUNDARY_VISIBLE = 3;

if (boundaryVisible < MIN_BOUNDARY_VISIBLE) {
  failures.push(`(c) multi-NDC: only ${boundaryVisible}/4 boundary samples visible (needed >=${MIN_BOUNDARY_VISIBLE}) -- instances NOT spread across distinct grid positions`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('  hint: inspect Renderer.onError fan-out + verify renderer-owned Instances collection upload path on dawn-node');
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - SPREAD: backend=webgpu, frames=${framesObserved}, boundary-visible=${boundaryVisible}/4, RhiError count=${errors.length}`);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
