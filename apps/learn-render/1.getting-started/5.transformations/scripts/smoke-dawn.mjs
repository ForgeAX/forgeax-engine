#!/usr/bin/env node
// apps/learn-render/1.getting-started/5.transformations/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 1.5 transformations dawn-node smoke (feat-20260611
// w10 / M3 round-2 fix-up I-2 -- real-scene adaptation per src/index.ts).
//
// Walks the wood-container engine ECS path the demo runs in production:
//   1. decodeImageFromFile(container.jpg) via @forgeax/engine-image
//      (the LO 1.5 lecture re-uses the LO 1.4 wood JPG; src/index.ts
//      uses WOOD_TEXTURE_GUID = '019e3969-1d46-773e-988c-a10e305ff2a4').
//   2. registerWithGuid<TextureAsset>(woodGuid, ...) so the deferred
//      AssetRegistry path resolves the texture handle.
//   3. registerWithGuid<MeshAsset>(cubeGuid, HANDLE_CUBE asset) so the
//      cube geometry is reachable via GUID (mirrors the demo's
//      registerWithGuid + loadByGuid<MeshAsset> recipe).
//   4. Material registered carrying baseColorTexture: woodHandle.
//   5. spawn cube with the LO 1.5 Z-axis rotation baked into the quat
//      (no animation -- smoke is a static-frame verdict).
//
// Differential axes vs hello-triangle (D-2 / D-8 byte-level):
//   - GUID set: WOOD_TEXTURE_GUID (LO §1.4 source) + CUBE_MESH_GUID
//     (engine builtin alias) + CUBE_MATERIAL_GUID (LO §1.5 own) -- 3
//     registerWithGuid calls, not 0.
//   - clear color: engine teal default (0.2, 0.3, 0.3).
//   - sample sites: single textured cube at origin with LO 1.5 Z-axis
//     rotation; named cubeUL / cubeBR / cubeCenter (NOT triLeft/triRight
//     -- this scene has a cube, not a triangle).
//   - Transform: LO 1.5 introduces glm::rotate -- the smoke bakes a
//     Z-axis 30 degree rotation into quat (sin / cos halves).
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-transformations] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS - 4 criteria GREEN: ...`

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const CONTAINER_TEXTURES_DIR = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
);
const CONTAINER_SRC_PATH = resolve(CONTAINER_TEXTURES_DIR, 'container.jpg');
const CONTAINER_META_PATH = resolve(CONTAINER_TEXTURES_DIR, 'container.jpg.meta.json');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

// LO 1.5 Z-axis 30-degree rotation -- the lecture's `glm::rotate(...,
// glm::radians(30.0f), glm::vec3(0, 0, 1))` baked into a quaternion so
// the static smoke frame still exhibits the rotation effect.
const ROT_Z_RAD = (30 * Math.PI) / 180;
const ROT_HALF = ROT_Z_RAD * 0.5;
const ROT_QUAT_Z = Math.sin(ROT_HALF);
const ROT_QUAT_W = Math.cos(ROT_HALF);

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-5-transformations' smoke",
  );
  console.error(
    '  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present',
  );
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
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
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

// --- 3. Drive engine ECS path with wood texture upload + rotated cube -------

if (!existsSync(CONTAINER_SRC_PATH) || !existsSync(CONTAINER_META_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${CONTAINER_SRC_PATH} or ${CONTAINER_META_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');

const decodeRes = await decodeImageFromFile(CONTAINER_SRC_PATH);
if (!decodeRes.ok) {
  console.error(
    `[smoke] FAIL - decodeImageFromFile failed: ${decodeRes.error.code} ${decodeRes.error.hint ?? ''}`,
  );
  process.exit(1);
}
const { decoded: woodDecoded, meta: woodMeta } = decodeRes.value;
console.log(
  `[learn-render-transformations] decoded ${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime} guid=${woodMeta.guid}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: EMPTY_MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - renderer host construction failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[learn-render-transformations] pipeline=Standard');

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


const woodTexAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: woodDecoded.width, height: woodDecoded.height } },
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mips: woodDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const frameRequest = {
  leases: [worldAttachment1.value],
  camera: { lease: worldAttachment1.value },
  environment: { lease: worldAttachment1.value },
};
// Mint user-tier column handles (M8 D-17). The baseColorTexture slot
// carries the resolved numeric Handle via unwrapHandle; the cube enters
// the world via the engine builtin HANDLE_CUBE directly (no GUID round-trip).
const woodTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodTexAsset));
const woodMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 },
  ],
  values: { baseColor: [1.0, 1.0, 1.0, 1.0], baseColorTexture: woodTexHandle },
});
// Single cube at origin with LO 1.5 Z-axis 30deg rotation baked in.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, ROT_QUAT_Z, ROT_QUAT_W], scale: [1, 1, 1],},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  {
    component: MeshRenderer,
    data: { materials: [woodMaterial] },
  },
);
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1],
    intensity: 1,
  },
});

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw(frameRequest);
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
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
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 4. Pixel readback (multi-site grid) ------------------------------------

if (!renderTarget) {
  console.error(
    '[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()',
  );
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
  console.error(
    `[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
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
// LO 1.5 single rotated cube probes -- centre + slightly offset
// upper-left / lower-right interior cells (rotated cube spans both
// diagonals so the probes hit the cube even with a 30deg Z-twist).
const sites = [
  { name: 'cubeCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeUL', x: Math.floor(WIDTH * 0.42), y: Math.floor(HEIGHT * 0.4) },
  { name: 'cubeBR', x: Math.floor(WIDTH * 0.58), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (4 criteria) ------------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['cubeCenter', 'cubeUL', 'cubeBR'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) LO 1.5 rotated wood cube - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} distance from clear color; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-5-transformations' smoke",
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify wood-texture decode + LO 1.5 Z-axis rotation quat',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: pipeline=Standard, frames=${framesObserved}, LO 1.5 rotated cube sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
emitSmokeReceipt('app-learn-render-1-getting-started-5-transformations/smoke', framesObserved);
process.exit(0);
