#!/usr/bin/env node
import { solidTexture } from './texture-fixture.mjs';
// hello-multi-uv headless smoke (AC-10 visual differentiation gate).
//
// Strategy: drive the engine ECS path end-to-end, same shape as
// hello-cube smoke, with a custom 2-UV-set procedural plane mesh.
// After 60 frames, reads back the render target and checks for
// non-black pixels (baseline visual differentiation gate).
//
// AC-10 visual differentiation is carried by the demo's OWN custom shader
// (multi-uv-demo.wgsl), NOT the engine-shipped default-standard-pbr (which
// must stay single-UV byte-identical, AC-11/AC-12). The demo shader paints
// uv1 into the surface colour. The procedural plane has uv1=(0,0) for even
// cells and uv1=(1,1) for odd cells, so pixel values differ between grid
// regions when the multi-UV pipeline feeds the second set. A mesh with no
// second UV set would read uv0 via clamp-to-last (NOT (0,0)); the per-cell
// variance here exists only because this plane carries a real second set.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emitSmokeReceipt } from '../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 200;
const HEIGHT = 150;

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
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
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
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- device capture ---

let sharedDevice;
const originalAmbientRequestAdapter =
  globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- 3. Build procedural 2-UV plane mesh ---

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
    vertices[b + 6] = ix / GRID_X;
    vertices[b + 7] = iy / GRID_Y;
    vertices[b + 8] = 1;
    vertices[b + 9] = 0;
    vertices[b + 10] = 0;
    vertices[b + 11] = 1;
    const cell = (ix ^ iy) & 1;
    vertices[b + 12] = cell === 0 ? 0.0 : 1.0;
    vertices[b + 13] = cell === 0 ? 0.0 : 1.0;
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

// --- 4. Drive engine ECS path ---

const { World } = await import('@forgeax/engine-ecs');
const enginePkg = await import('@forgeax/engine-runtime');
const { createRenderer } = enginePkg;
const { Transform } = await import('@forgeax/engine-scene');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { readShaderManifestPublication } = await import('@forgeax/engine-shader');

const world = new World();
const baseColorTextureHandle = world.allocSharedRef('TextureAsset', solidTexture([255, 128, 64, 255]));
const detailTextureHandle = world.allocSharedRef('TextureAsset', solidTexture([64, 192, 255, 255]));

// Mint user-tier column handles for the custom mesh + material via
// world.allocSharedRef (slots >= 1024, resolved by the renderer through
// world.sharedRefs at draw time). This mirrors apps/hello-multi-uv/src/main.ts:
// the prior smoke spawned MeshFilter with a raw integer handle (100) that was
// never registered and an empty MeshRenderer, so the render system reported
// `asset-not-registered` every frame and never drew. The mesh carries a real
// second UV set; the material references the demo's custom multi-UV shader by
// path (the shader itself is registered after host initialization below).
const DEMO_MATERIAL_SHADER_PATH = 'hello-multi-uv::multi-uv-demo';
const meshAsset = {
  kind: 'mesh',
  vertices,
  indices,
  attributes: {
    position: positions,
    normal: normals,
    uv: uvs,
    tangent: tangents,
    uv1,
  },
  submeshes: [
    {
      indexOffset: 0,
      indexCount: indices.length,
      vertexCount,
      topology: 'triangle-list',
      materialSlot: 0,
    },
  ],
  materialSlots: [{ slotName: 'Default' }],
  aabb: new Float32Array([-HALF_W, -HALF_H, -0.01, HALF_W, HALF_H, 0.01]),
};
const materialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: DEMO_MATERIAL_SHADER_PATH },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
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
  {
    component: Transform,
    data: {
      pos: [0, 0, 0.5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 },
  },
);
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.3, -0.8, -1],
    color: [1, 1, 1],
    intensity: 1,
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const MANIFEST_PATH = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
let MANIFEST_URL;
let manifestParsed;
try {
  const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8');
  MANIFEST_URL = `data:application/json,${encodeURIComponent(manifestRaw)}`;
  manifestParsed = await readShaderManifestPublication(JSON.parse(manifestRaw));
} catch {
  console.error('[smoke] FAIL - manifest.json missing or invalid. Run: pnpm --filter @forgeax/hello-multi-uv build first');
  process.exit(1);
}

// The published manifest is content-addressed; the engine expansion (same path as
// renderer admission) restores per-variant composedWgsl.
const demoShaderEntry = (manifestParsed.materialShaders ?? []).find(
  (m) => m && m.identifier === 'hello-multi-uv::multi-uv-demo',
);
if (!demoShaderEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing hello-multi-uv::multi-uv-demo entry');
  process.exit(1);
}
// Composed WGSL lives per variant; the canonical (all-axes-on) variant carries
// the multi-UV sampling path this smoke falsifies.
const canonicalVariant = (demoShaderEntry.variants ?? []).find((v) => v?.definesKey === '');
if (typeof canonicalVariant?.composedWgsl !== 'string') {
  console.error('[smoke] FAIL - hello-multi-uv::multi-uv-demo has no canonical variant composedWgsl');
  process.exit(1);
}
const demoComposedWgsl = canonicalVariant.composedWgsl;
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
  console.error('[smoke] FAIL - multi-UV multi-texture schema/sample binding is missing');
  process.exit(1);
}
console.log('[smoke] texture binding: PASS schema=baseColorTexture+detailTexture textureSample=true');

let renderer;
try {
  const created = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!created.ok) throw created.error;
  renderer = created.value;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const inspection = renderer.inspect();

console.log(`[hello-multi-uv] backend=${inspection.capabilities.backendKind}`);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


// The Standard host resolves the material shader from the build manifest before
// the first receipt. Warm-up only yields to the host lifecycle; it never installs
// a late shader or pipeline registry entry.
const yieldTick = () => new Promise((r) => setTimeout(r, 0));
const drawFrame = () => renderer.draw({
  leases: [lease],
  camera: { lease },
  environment: { lease },
});
let lastReceipt;
for (let warm = 0; warm < 16; warm++) {
  world.update().unwrap();
  const frame = drawFrame();
  if (frame.ok) lastReceipt = frame.value;
  await yieldTick();
}

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, 60);
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  else lastReceipt = r.value;
  framesObserved++;
}

if (lastReceipt === undefined) {
  console.error('[smoke] FAIL - no successful FrameReceipt was produced');
  process.exit(1);
}
const observed = await renderer.observe(lastReceipt, { include: ['draws'] });
if (!observed.ok) {
  console.error(`[smoke] FAIL - receipt observation failed: ${observed.error.code}`);
  process.exit(1);
}

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 5. Pixel readback ---

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({
  size: bytesPerRow * HEIGHT,
  usage: 0x01 | 0x08,
});
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
await readbackBuffer.mapAsync(0x01);
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

const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
const ndcCenter = readRgba(cx, cy);

// Sample several points across the plane to detect checkerboard variation
const samples = [
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.3), Math.floor(HEIGHT * 0.6)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.3)),
  readRgba(Math.floor(WIDTH * 0.6), Math.floor(HEIGHT * 0.6)),
];

console.log(
  `[smoke] pixelSamples=${JSON.stringify({ ndcCenter, quadSamples: samples })}`,
);

// --- 6. Verdict ---

const BLACK = [0, 0, 0];
const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

const failures = [];
if (inspection.capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${inspection.capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);

const centerDist = dist(ndcCenter, BLACK);
if (centerDist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(c) NDC-center pixel ${JSON.stringify(ndcCenter)} too close to black (distance ${centerDist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD})`,
  );
}

if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer error events fired ${errors.length} times: [${codes}]`);
}

// (e) AC-10 visual differentiation: verify the four corner samples are not all
// identical (checkerboard uv1 modulation should create variance across the grid)
const maxDiff = Math.max(
  dist(samples[0], samples[1]),
  dist(samples[0], samples[2]),
  dist(samples[0], samples[3]),
  dist(samples[1], samples[2]),
  dist(samples[1], samples[3]),
  dist(samples[2], samples[3]),
);
console.log(`[smoke] quadSampleMaxDiff=${maxDiff.toFixed(4)}`);
// When uv1 checkerboard works, maxDiff should be > 0.03 (visible variance).
// When broken (uv1 stuck at 0,0), all pixels converge to uniform albedo.
if (maxDiff < 0.03) {
  failures.push(
    `(e) AC-10 visual differentiation: quadSampleMaxDiff=${maxDiff.toFixed(4)} (< 0.03) — checkerboard uv1 not producing visible variance (multi-UV pipeline may be broken)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 5 criteria GREEN: backend=webgpu, frames=${framesObserved}, center distance=${centerDist.toFixed(4)}, RhiError count=0, visual differentiation maxDiff=${maxDiff.toFixed(4)}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
emitSmokeReceipt('hello-multi-uv/smoke', framesObserved);
process.exit(0);
