#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-texture headless dawn smoke — reproduces the app's texture World in
// node-dawn and asserts a real textured render (unlit + baseColorTexture).
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NDC-center pixel is NOT black (the textured quad fills the center)
//   (d) Renderer.onError fired 0 times.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 200;
const HEIGHT = 150;

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

// --- build the texture World ---
const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { quat } = await import('@forgeax/engine-math');
const { unwrapHandle } = await import('@forgeax/engine-types');

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
console.log(`[bevy-texture] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// Build checkerboard texture
const CHECKER_SIZE = 64;
const CHECKER_TILES = 8;
const TILE_PX = CHECKER_SIZE / CHECKER_TILES;
const checkerPixels = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
for (let y = 0; y < CHECKER_SIZE; y++) {
  for (let x = 0; x < CHECKER_SIZE; x++) {
    const off = (y * CHECKER_SIZE + x) * 4;
    const tx = Math.floor(x / TILE_PX);
    const ty = Math.floor(y / TILE_PX);
    const white = (tx + ty) % 2 === 0;
    const v = white ? 255 : 0;
    checkerPixels[off] = v;
    checkerPixels[off + 1] = v;
    checkerPixels[off + 2] = v;
    checkerPixels[off + 3] = 255;
  }
}
const texPod = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: CHECKER_SIZE, height: CHECKER_SIZE } },
  format: 'rgba8unorm-srgb',
  data: checkerPixels,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const texHandle = world.allocSharedRef('TextureAsset', texPod);
const texId = unwrapHandle(texHandle);

// Upload texture to GPU

const normalMat = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 1, 1, 1], { baseColorTexture: texId }));
const redMat = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 0.5], { baseColorTexture: texId }));
const blueMat = world.allocSharedRef('MaterialAsset', Materials.unlit([0, 0, 1, 0.5], { baseColorTexture: texId }));

// Normal quad at z=1.5
world.spawn(
  { component: Transform, data: { pos: [0, 0, 1.5], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [normalMat] } },
);
// Red-tinted quad at z=0
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [redMat] } },
);
// Blue-tinted quad at z=-1.5
world.spawn(
  { component: Transform, data: { pos: [0, 0, -1.5], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [blueMat] } },
);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: DirectionalLight, data: { color: [1, 1, 1], intensity: 1 } },
);
// Camera at +Z, identity quat looks along -Z toward the quads
world.spawn(
  { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} (target=${TARGET_FRAMES})`);

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
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

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [(bytes[off] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};
const ndcCenter = readRgba(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const topLeft = readRgba(Math.floor(WIDTH * 0.1), Math.floor(HEIGHT * 0.1));
const topRight = readRgba(Math.floor(WIDTH * 0.9), Math.floor(HEIGHT * 0.1));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter, topLeft, topRight })}`);

// Dump full frame PNG for visual inspection.
try {
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const src = y * bytesPerRow;
    tight.set(bytes.subarray(src, src + WIDTH * 4), y * WIDTH * 4);
  }
  const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
  mkdirSync(dirname(pngOut), { recursive: true });
  writeFileSync(pngOut, writeReferencePng(tight, WIDTH, HEIGHT));
  console.log(`[smoke] wrote PNG=${pngOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const centerDist = distance(ndcCenter, [0, 0, 0]);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (centerDist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${centerDist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) — textured quad not visible`);
}
if (errors.length > 0) failures.push(`(d) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${centerDist.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
