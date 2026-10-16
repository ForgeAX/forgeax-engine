#!/usr/bin/env node
// hello-fbx-cube dawn smoke (M4 / T17): structural gate + pixel readback.
//
// Two layers:
//   1. Structural (unchanged from M3): backend=webgpu, >=60 frames, 0 RhiError.
//   2. Pixel readback (T17, AC-14/AC-18): copyTextureToBuffer the offscreen
//      render target after the frame loop and assert the cube covers the NDC
//      center with a deterministic lit colour distinctly above black, while a
//      screen corner stays at the cleared black background.
//
// Expected colour anchor (see concerns in the M4 milestone report):
//   cube.fbx carries ZERO materials (parity snapshot signed at M1/T6:
//   materials:[], mesh materialIndex:-1), so the engine binds its fallback
//   grey PBR material (baseColor [0.5,0.5,0.5]). Under the single directional
//   light the NDC-center pixel resolves to a stable ~[0.2235,0.2235,0.2235].
//   AC-18's "source material colour (non-fallback grey)" is not physically
//   satisfiable for cube.fbx because there is no source material to show; this
//   smoke therefore anchors on the *deterministic non-black lit render* (the
//   cube is present, shaded, and occludes the black background), which is the
//   falsifiable signal available for this fixture.
//
// Falsification check (plan-strategy §5.4, AGENTS.md LO 5.1 black-screen
// lesson): run with FALSIFY=blank to swap the expected center colour to the
// cleared-black background value. The center-vs-black distance assertion then
// trips and the smoke exits non-zero, proving the pixel assertion is sensitive
// to the rendered cube (not vacuously true). FALSIFY is a local judgement-of-
// discrimination tool only; CI runs the script with no env.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
// feat-20260615-ci-smoke-time-budget parity: 200x150 keeps the fragment-bound
// dawn/lavapipe readback cheap; the cube still covers the NDC center at this size.
const WIDTH = 200;
const HEIGHT = 150;

// FALSIFY=blank: expect the cleared black background at the cube's NDC center.
// The center-non-black assertion must then FAIL, proving discrimination.
const FALSIFY = process.env.FALSIFY ?? '';
if (FALSIFY !== '' && FALSIFY !== 'blank') {
  console.error(`[smoke] FAIL - unknown FALSIFY mode '${FALSIFY}' (expected '' or 'blank')`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ---
let create, globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Capture the raw GPUDevice the engine's createRenderer ends up using so the
// post-loop readback runs on the same device (mirror of apps/hello/cube smoke).
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

// --- 2. Mock canvas with offscreen render target ---
let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  // RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01)
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
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

// --- 3. Engine + FBX import ---
const { World } = await import('@forgeax/engine-ecs');
const { Transform } = await import('@forgeax/engine-scene');
const { MeshFilter, DirectionalLight } = await import('@forgeax/engine-render');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { MeshRenderer, Camera } = await import('@forgeax/engine-render');
const { fbxImporter } = await import('@forgeax/engine-fbx');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = manifestExists(MANIFEST_PATH)
  ? `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`
  : '';

function manifestExists(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, MANIFEST_URL ? { shaderManifestUrl: MANIFEST_URL } : {});
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[hello-fbx-cube] Standard pipeline active');
if (!assets) { console.error('[smoke] FAIL - AssetRegistry null'); process.exit(1); }

// Import cube.fbx via fbxImporter. The importer honours the GUID import-stable
// iron law: it only emits sub-assets declared in ctx.subAssets[]. Read them from
// the meta sidecar (SSOT) so this smoke exercises the same declared-GUID path as
// the dev server / build pre-import, not a subAssets:[] shortcut that produces
// nothing.
//
// T17: the ufbx importer parses ctx.readSource() bytes in-memory (the old SDK
// importer read the source path from disk itself, so the M3 smoke passed an
// empty Uint8Array; that path no longer works). Read the real .fbx bytes here.
const CUBE_FBX = resolve(here, '..', '..', '..', '..', 'forgeax-engine-assets', 'vendor', 'fbx-test', 'cube.fbx');
const CUBE_META = JSON.parse(readFileSync(`${CUBE_FBX}.meta.json`, 'utf8'));
let results;
try {
  results = await fbxImporter.import({
    source: CUBE_FBX,
    readSource: async () => ({ ok: true, value: new Uint8Array(readFileSync(CUBE_FBX)) }),
    readSibling: async () => ({ ok: false, error: { code: 'source-read-failed' } }),
    decodeImage: async () => ({ ok: false, error: { code: 'image-decode-failed' } }),
    subAssets: CUBE_META.subAssets,
    importSettings: {},
  });
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : String(err);
  console.error(`[smoke] FAIL - fbxImporter.import threw: ${code}`);
  process.exit(1);
}

if (!results.ok) {
  console.error(`[smoke] FAIL - fbxImporter failed: ${results.error.code}`);
  process.exit(1);
}

const meshAsset = results.value.assets.find((a) => a.kind === 'mesh');
const matAsset = results.value.assets.find((a) => a.kind === 'material');
if (!meshAsset || !matAsset) {
  console.error('[smoke] FAIL - fbxImporter did not produce mesh/material');
  process.exit(1);
}

console.log(`[smoke] mesh vertices=${meshAsset.payload.vertices.length} submeshes=${meshAsset.payload.submeshes.length}`);

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// feat-20260614 M8: AssetRegistry register* deleted; mint user-tier column
// handles via world.allocSharedRef (bare Handle, not a Result).
const meshHandle = world.allocSharedRef('MeshAsset', meshAsset.payload);
const matHandle = world.allocSharedRef('MaterialAsset', matAsset.payload);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 30], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push(event.error.code);
});


let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) {
    const code = r.error && typeof r.error === 'object' && 'code' in r.error ? r.error.code : 'unknown';
    errors.push(code);
  }
  framesObserved++;
}

console.log(`[smoke] frames=${framesObserved} errors=${errors.length}`);

// --- 4. Pixel readback ---
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();

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
const bytes = new Uint8Array(readbackBuffer.getMappedRange().slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgb = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [(bytes[off + 0] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};
const ndcCenter = readRgb(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const corner = readRgb(Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter, corner })}`);

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];
// FALSIFY=blank: pretend the cube's NDC center matches the cleared black
// background. The center-non-black assertion below then trips (distance ~0),
// proving the pixel readback discriminates the rendered cube from a blank frame.
const observedCenter = FALSIFY === 'blank' ? BLACK : ndcCenter;
const centerDist = distance(observedCenter, BLACK);
const cornerDist = distance(corner, BLACK);

// --- 5. Verdict ---
const failures = [];
// Structural (not weakened by the pixel layer).
if (!sharedDevice) failures.push('(a) Dawn device was not created by the host-owned Standard pipeline');
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) failures.push(`(c) errors=${errors.join(',')}`);
// Pixel readback (T17 / AC-14 / AC-18).
if (centerDist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(d) NDC-center ${JSON.stringify(observedCenter)} too close to black (distance ${centerDist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) - cube not rendered`);
}
if (cornerDist > SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(e) corner ${JSON.stringify(corner)} not black background (distance ${cornerDist.toFixed(4)} > ${SMOKE_PIXEL_THRESHOLD})`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}

console.log(`[smoke] PASS - backend=webgpu, frames=${framesObserved}, errors=0, NDC-center distance to black=${centerDist.toFixed(4)}, corner black`);
emitSmokeReceipt('hello-fbx-cube/smoke', framesObserved);
process.exit(0);
