#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-lighting headless dawn smoke — proves Bevy lighting behavior:
// red PointLight + green SpotLight + blue PointLight + DirectionalLight + Skylight
// illuminate a scene with ground/walls/cube/sphere/logo. Static render.
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NDC-center pixel is NOT black — the lit scene is visible
//   (d) earlyMaxBright > 0.03 — lights produce lit pixels (not just ambient)
//   (e) RhiError count = 0

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;

// --- dawn.node binding setup ---
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
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- mock canvas + offscreen render target ---
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
  addEventListener() {}, removeEventListener() {},
};

// --- build the lighting World inline (Node can't import .ts) ---
const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { PointLight, SpotLight } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials, Skylight } = await import('@forgeax/engine-render');
const { perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE } = await import('@forgeax/engine-assets-runtime');
const { quat } = await import('@forgeax/engine-math');

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
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-lighting] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const RED = [1, 0, 0];
const LIME = [0, 1, 0];
const BLUE = [0, 0, 1];
const RED4 = [1, 0, 0, 1];
const LIME4 = [0, 1, 0, 1];
const BLUE4 = [0, 0, 1, 1];

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// ── Ground plane (flat cube), white PBR ─────────────────────────────────
const whiteMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [1, 1, 1, 1] }));
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [whiteMat] } },
);

// ── Left wall ───────────────────────────────────────────────────────────
const indigoMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [75 / 255, 0, 130 / 255, 1] }));
const leftWallQuat = quat.create();
quat.fromAxisAngle(leftWallQuat, [0, 0, 1], Math.PI / 2);
world.spawn(
  { component: Transform, data: { pos: [2.5, 2.5, 0], quat: leftWallQuat, scale: [5, 0.15, 5] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [indigoMat] } },
);

// ── Back wall ───────────────────────────────────────────────────────────
const backWallQuat = quat.create();
quat.fromAxisAngle(backWallQuat, [1, 0, 0], Math.PI / 2);
world.spawn(
  { component: Transform, data: { pos: [0, 2.5, -2.5], quat: backWallQuat, scale: [5, 0.15, 5] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [indigoMat] } },
);

// ── Logo quad ───────────────────────────────────────────────────────────
const logoMat = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 1, 1, 1]));
const logoQuat = quat.create();
quat.fromAxisAngle(logoQuat, [0, 1, 0], Math.PI / 8);
world.spawn(
  { component: Transform, data: { pos: [-2.2, 0.5, 1], quat: logoQuat, scale: [2, 0.5, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
  { component: MeshRenderer, data: { materials: [logoMat] } },
);

// ── Pink cube ───────────────────────────────────────────────────────────
const pinkMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [1, 20 / 255, 147 / 255, 1] }));
world.spawn(
  { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [pinkMat] } },
);

// ── Green sphere ────────────────────────────────────────────────────────
const greenMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [50 / 255, 205 / 255, 50 / 255, 1] }));
world.spawn(
  { component: Transform, data: { pos: [1.5, 1, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [greenMat] } },
);

// ── Red PointLight with emissive sphere child ───────────────────────────
const redEmissiveMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: RED4, emissive: [4, 0, 0] }));
world.spawn(
  { component: Transform, data: { pos: [1, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: PointLight, data: { color: RED, intensity: 400, range: 20, castShadow: true } },
);
world.spawn(
  { component: Transform, data: { pos: [1, 2, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [redEmissiveMat] } },
);

// ── Green SpotLight with emissive sphere child ──────────────────────────
const greenEmissiveMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: LIME4, emissive: [0, 4, 0] }));
world.spawn(
  {
    component: Transform,
    data: { pos: [-1, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
  },
  {
    component: SpotLight,
    data: {
      direction: [0, -1, 0],
      color: LIME,
      intensity: 400,
      innerConeDeg: 34.4,
      outerConeDeg: 45.8,
      castShadow: true,
    },
  },
);
world.spawn(
  { component: Transform, data: { pos: [-1, 2, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [greenEmissiveMat] } },
);

// ── Blue PointLight with emissive sphere child ──────────────────────────
const blueEmissiveMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: BLUE4, emissive: [0, 0, 4] }));
world.spawn(
  { component: Transform, data: { pos: [0, 4, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: PointLight, data: { color: BLUE, intensity: 400, range: 20, castShadow: true } },
);
world.spawn(
  { component: Transform, data: { pos: [0, 4, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [blueEmissiveMat] } },
);

// ── DirectionalLight ────────────────────────────────────────────────────
const sunQuat = quat.create();
quat.fromAxisAngle(sunQuat, [1, 0, 0], -Math.PI / 4);
world.spawn(
  { component: Transform, data: { pos: [0, 2, 0], quat: sunQuat, scale: [1, 1, 1] } },
  { component: DirectionalLight, data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 10, castShadow: true, mapSize: testQuality.shadowMapSize, cascadeCount: testQuality.cascadeCount } },
);

// ── Skylight (ambient) ──────────────────────────────────────────────────
world.spawn({
  component: Skylight,
  data: { color: new Float32Array([1, 0.27, 0]), intensity: 1 },
});

// ── Camera ──────────────────────────────────────────────────────────────
world.spawn(
  {
    component: Transform,
    data: {
      pos: [-2, 2.5, 5],
      quat: quat.fromLookAt(quat.create(), [-2, 2.5, 5], [0, 0, 0], [0, 1, 0]),
      scale: [1, 1, 1],
    },
  },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);

// --- drive the frame loop ---
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
let framesObserved = 0;
let earlyMaxBright = 0;

const readCenter = (bytes, bytesPerRow, w, h) => {
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const off = cy * bytesPerRow + cx * 4;
  return [(bytes[off] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};

// Take an early readback at frame 5 to capture lit-brightness.
const EARLY_FRAME = Math.min(5, TARGET_FRAMES - 1);
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;

  if (i === EARLY_FRAME) {
    const device = sharedDevice;
    if (!device) continue;
    await device.queue.onSubmittedWorkDone();
    const bpp = 4;
    const bpr = Math.ceil((WIDTH * bpp) / 256) * 256;
    const eb = device.createBuffer({ size: bpr * HEIGHT, usage: 0x01 | 0x08 });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: eb, bytesPerRow: bpr, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    try { await eb.mapAsync(0x01); } catch (_) { /* skip */ }
    const ebBytes = new Uint8Array(eb.getMappedRange().slice(0));
    eb.unmap(); eb.destroy();

    let maxB = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bpr + x * 4;
        const rv = (ebBytes[off] ?? 0) / 255;
        const gv = (ebBytes[off + 1] ?? 0) / 255;
        const bv = (ebBytes[off + 2] ?? 0) / 255;
        const bright = rv * 0.299 + gv * 0.587 + bv * 0.114;
        if (bright > maxB) maxB = bright;
      }
    }
    earlyMaxBright = maxB;
    console.log(`[smoke] earlyMaxBright at frame ${i}=${earlyMaxBright.toFixed(4)}`);
  }
}

const device = sharedDevice;
if (!device) { console.error('[smoke] FAIL - no shared device captured for readback'); process.exit(1); }
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} (target=${TARGET_FRAMES})`);

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}

// Final frame readback
const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
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

const ndcCenter = readCenter(bytes, bytesPerRow, WIDTH, HEIGHT);
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter })}`);

// Dump PNG
try {
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
  mkdirSync(dirname(pngOut), { recursive: true });
  writeFileSync(pngOut, encodePng(WIDTH, HEIGHT, tight));
  console.log(`[smoke] wrote PNG=${pngOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const dist3 = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const dist = dist3(ndcCenter, [0, 0, 0]);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) — lit scene not visible`);
}
if (earlyMaxBright <= 0.03) {
  failures.push(`(d) earlyMaxBright=${earlyMaxBright.toFixed(4)} <= 0.03 — lights not producing visible illumination`);
}
if (errors.length > 0) failures.push(`(e) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 5 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center dist=${dist.toFixed(4)}, earlyMaxBright=${earlyMaxBright.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
