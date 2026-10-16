#!/usr/bin/env node
import { solidTexture } from './texture-fixture.mjs';
// smoke-falsify.mjs -- feat-20260629-multi-uv-set-support m5-w4
//
// Visual falsification variant for AC-10. Constructs the same 2-UV-set
// procedural plane but replaces uv1 with a constant value. The expected
// outcome is that the visual differentiation (maxDiff across quad samples)
// drops below the threshold -- confirming that the AC-10 smoke signal
// genuinely comes from uv1 data, not from unrelated rendering noise.
//
// This script does NOT run in CI (plan-strategy §5.4). It is executed
// manually during M5 implement to verify falsification sensitivity.
//
// Accepted outcomes:
//   (a) FAIL_WITH_LOW_DIFF: maxDiff < 0.03 -- constant uv1 killed the
//       checkerboard variation; AC-10 smoke is falsifiable. CORRECT.
//   (b) PASS_WITH_HIGH_DIFF: maxDiff >= 0.03 despite the collapse -- means
//       the checkerboard difference was not from uv1 data; AC-10
//       must be arbitrated by human Read(image). DEGENERATE.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = 60;
const SMOKE_PIXEL_THRESHOLD = 0.05;

const WIDTH = 200;
const HEIGHT = 150;

// --- dawn.node ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[falsify-smoke] FAIL - dawn.node import failed: ${err}`);
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
  console.error(`[falsify-smoke] FAIL - dawn-node create([]) failed: ${err}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const origReqDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await origReqDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- mock canvas ---

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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- build 2-UV plane mesh (WITH FALSIFICATION: uv1 = uv0 swap) ---

const HALF_W = 1.5;
const HALF_H = 1.5;
const GRID_X = 4;
const GRID_Y = 4;
const VX = GRID_X + 1;
const VY = GRID_Y + 1;
const UV_SETS = 2;
const FLOATS_BASE = 12;
const FLOATS_PER_VERTEX = FLOATS_BASE + (UV_SETS - 1) * 2;

const vertexCount = VX * VY;
const indexCount = GRID_X * GRID_Y * 6;
const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
const indices = new Uint16Array(indexCount);
const segW = (HALF_W * 2) / GRID_X;
const segH = (HALF_H * 2) / GRID_Y;

for (let iy = 0, vi = 0; iy < VY; iy++) {
  for (let ix = 0; ix < VX; ix++, vi++) {
    const x = ix * segW - HALF_W;
    const y = -(iy * segH - HALF_H);
    const b = vi * FLOATS_PER_VERTEX;
    vertices[b + 0] = x;
    vertices[b + 1] = y;
    vertices[b + 2] = 0;
    vertices[b + 3] = 0;
    vertices[b + 4] = 0;
    vertices[b + 5] = 1;
    const gridU = ix / GRID_X;
    const gridV = iy / GRID_Y;
    vertices[b + 6] = gridU;
    vertices[b + 7] = gridV;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
    // FALSIFICATION: collapse uv1 to a constant instead of the checkerboard.
    vertices[b + 12] = 0;
    vertices[b + 13] = 0;
  }
}

for (let iy = 0, ii = 0; iy < GRID_Y; iy++) {
  for (let ix = 0; ix < GRID_X; ix++) {
    const a = ix + VX * iy;
    const b = ix + VX * (iy + 1);
    const c = ix + 1 + VX * (iy + 1);
    const d = ix + 1 + VX * iy;
    indices[ii++] = a;
    indices[ii++] = b;
    indices[ii++] = d;
    indices[ii++] = b;
    indices[ii++] = c;
    indices[ii++] = d;
  }
}

const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const uvs = new Float32Array(vertexCount * 2);
const tangents = new Float32Array(vertexCount * 4);
const uv1 = new Float32Array(vertexCount * 2);
for (let i = 0; i < vertexCount; i++) {
  const b = i * FLOATS_PER_VERTEX;
  positions[i * 3 + 0] = vertices[b + 0];
  positions[i * 3 + 1] = vertices[b + 1];
  positions[i * 3 + 2] = vertices[b + 2];
  normals[i * 3 + 0] = vertices[b + 3];
  normals[i * 3 + 1] = vertices[b + 4];
  normals[i * 3 + 2] = vertices[b + 5];
  uvs[i * 2 + 0] = vertices[b + 6];
  uvs[i * 2 + 1] = vertices[b + 7];
  tangents[i * 4 + 0] = vertices[b + 8];
  tangents[i * 4 + 1] = vertices[b + 9];
  tangents[i * 4 + 2] = vertices[b + 10];
  tangents[i * 4 + 3] = vertices[b + 11];
  uv1[i * 2 + 0] = vertices[b + 12];
  uv1[i * 2 + 1] = vertices[b + 13];
}

console.log('[falsify-smoke] uv1 data collapsed to zero -- checkerboard should vanish');

// --- drive engine ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createRenderer } = enginePkg;
const { Transform } = await import('@forgeax/engine-scene');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');

const world = new World();
const DEMO_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo';
const baseColorTextureHandle = world.allocSharedRef('TextureAsset', solidTexture([255, 128, 64, 255]));
const detailTextureHandle = world.allocSharedRef('TextureAsset', solidTexture([64, 192, 255, 255]));
const meshAsset = {
  kind: 'mesh',
  vertices,
  indices,
  attributes: { position: positions, normal: normals, uv: uvs, tangent: tangents, uv1 },
  submeshes: [{
    indexOffset: 0,
    indexCount: indices.length,
    vertexCount,
    topology: 'triangle-list',
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'Default' }],
  aabb: new Float32Array([-HALF_W, -HALF_H, -0.01, HALF_W, HALF_H, 0.01]),
};
const materialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: DEMO_MATERIAL_SHADER_PATH }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: {
    baseColor: [0.7, 0.7, 0.7, 1],
    baseColorUvTransform: [0, 0, 1, 1],
    baseColorTexture: baseColorTextureHandle,
    detailTexture: detailTextureHandle,
  },
};
const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);
const matHandle = world.allocSharedRef('MaterialAsset', materialAsset);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.3, -0.8, -1], color: [1, 1, 1], intensity: 1 },
});

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
let MANIFEST_URL;
let manifestParsed;
try {
  const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8');
  MANIFEST_URL = `data:application/json,${encodeURIComponent(manifestRaw)}`;
  manifestParsed = JSON.parse(manifestRaw);
} catch {
  console.error('[falsify-smoke] FAIL - manifest.json not found. Run: pnpm --filter @forgeax/hello-multi-uv build first');
  process.exit(1);
}

let renderer;
try {
  const created = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!created.ok) throw created.error;
  renderer = created.value;
} catch (err) {
  console.error(`[falsify-smoke] FAIL - createRenderer threw: ${err}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const drawFrame = () => renderer.draw({
  leases: [lease],
  camera: { lease },
  environment: { lease },
});


const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    if (errors.length === 0) console.error('[falsify-smoke] first renderer error:', JSON.stringify(event.error));
    errors.push(event.error);
  }
});

const demoShaderEntry = (manifestParsed.materialShaders ?? []).find(
  (entry) => entry?.identifier === DEMO_MATERIAL_SHADER_PATH,
);
if (!demoShaderEntry) {
  console.error(`[falsify-smoke] FAIL - manifest missing ${DEMO_MATERIAL_SHADER_PATH}`);
  process.exit(1);
}
const demoComposedWgsl = demoShaderEntry.composedWgsl.includes('\n')
  ? demoShaderEntry.composedWgsl
  : readFileSync(resolve(here, '..', 'dist', 'shaders', demoShaderEntry.composedWgsl.replace(/^\.\//, '')), 'utf8');
const manifestParamSchema =
  typeof demoShaderEntry.paramSchema === 'string'
    ? JSON.parse(demoShaderEntry.paramSchema)
    : (demoShaderEntry.paramSchema ?? []);
const composedUsesSampledTexture = (name) => {
  const start = demoComposedWgsl.indexOf(`textureSample(${name}`);
  return start >= 0 && demoComposedWgsl.slice(start, start + 320).includes(`${name}_sampler`);
};
if (
  !Array.isArray(manifestParamSchema) ||
  !manifestParamSchema.some((entry) => entry?.name === 'baseColorUvTransform' && entry?.type === 'vec4') ||
  !manifestParamSchema.some((entry) => entry?.name === 'baseColorTexture' && entry?.type === 'texture2d') ||
  !manifestParamSchema.some((entry) => entry?.name === 'detailTexture' && entry?.type === 'texture2d') ||
  !composedUsesSampledTexture('baseColorTexture') ||
  !composedUsesSampledTexture('detailTexture')
) {
  console.error('[falsify-smoke] FAIL - multi-UV multi-texture schema/sample binding is missing');
  process.exit(1);
}
console.log('[falsify-smoke] texture binding: PASS schema=baseColorTexture+detailTexture textureSample=true');

const yieldTick = () => new Promise((resolve) => setTimeout(resolve, 0));
for (let warm = 0; warm < 16; warm++) {
  world.update().unwrap();
  drawFrame();
  await yieldTick();
}

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[falsify-smoke] draw frame ${i} error: ${r.error.code}`);
}
await sharedDevice.queue.onSubmittedWorkDone();

// --- readback ---

const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
const rbBuf = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = sharedDevice.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: rbBuf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([enc.finish()]);
}
await rbBuf.mapAsync(0x01);
const mapped = rbBuf.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
rbBuf.unmap();
rbBuf.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [(bytes[off + 0] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};

const samples = [
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.6)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.6)),
];

const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const maxDiff = Math.max(
  dist(samples[0], samples[1]), dist(samples[0], samples[2]),
  dist(samples[0], samples[3]), dist(samples[1], samples[2]),
  dist(samples[1], samples[3]), dist(samples[2], samples[3]),
);

console.log(`[falsify-smoke] quadSamples=${JSON.stringify(samples)}`);
console.log(`[falsify-smoke] maxDiff=${maxDiff.toFixed(4)}`);

sharedDevice.destroy?.();
delete globalThis.navigator.gpu;

if (errors.length > 0) {
  console.error(`[falsify-smoke] FAIL - renderer errors: ${errors.map((error) => error.code).join(', ')}`);
  process.exit(1);
}

// Falsification verdict: the custom multi-UV shader paints uv1 after sampling
// the real texture with uv0. With uv1 collapsed to zero, every covered sample
// has the same checkerboard input and the variance must disappear.
if (maxDiff < 0.03) {
  console.log('[falsify-smoke] PASS_FALSIFY - constant uv1 killed checkerboard variance (maxDiff < 0.03). AC-10 smoke is falsifiable.');
  process.exit(0);
} else {
  console.log(`[falsify-smoke] FAIL_FALSIFY - constant uv1 did NOT kill checkerboard variance (maxDiff=${maxDiff.toFixed(4)} >= 0.03).`);
  console.log('[falsify-smoke] AC-10 smoke signal is NOT sensitive to uv1 data. Human Read(image) arbitration required.');
  process.exit(1);
}
