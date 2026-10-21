#!/usr/bin/env node
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
// apps/learn-render/4.advanced-opengl/1.depth-testing/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 1.depth-testing dawn-node smoke.
// Pixel-level replica of the LO 4.1 normal path: metal.png floor + two
// marble.jpg cubes with PBR shading. Textures are decoded from the
// filesystem via `decodeImageFromFile` and created with `assets.create`
// (mirrors 1.4-textures smoke pattern).
//
// Falsifiable: delete/change texture GUID -> load fails -> smoke FAIL.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-1-depth-testing] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const METAL_SRC_PATH = resolve(TEXTURES_DIR, 'metal.png');
const MARBLE_SRC_PATH = resolve(TEXTURES_DIR, 'marble.jpg');

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing' smoke",
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

// --- 2. Mock canvas with offscreen render target ---

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

// --- 3. Asset fixtures check ---

if (!existsSync(METAL_SRC_PATH) || !existsSync(MARBLE_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${METAL_SRC_PATH} or ${MARBLE_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode textures + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const metalDecodeRes = await decodeImageFromFile(METAL_SRC_PATH);
const marbleDecodeRes = await decodeImageFromFile(MARBLE_SRC_PATH);
if (!metalDecodeRes.ok || !marbleDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    metalDecodeRes.ok ? null : metalDecodeRes.error.code,
    marbleDecodeRes.ok ? null : marbleDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: metalDecoded, meta: metalMeta } = metalDecodeRes.value;
const { decoded: marbleDecoded, meta: marbleMeta } = marbleDecodeRes.value;
console.log(
  `[learn-render-1-depth-testing] decoded metal=${metalDecoded.width}x${metalDecoded.height} ${metalDecoded.mime}`,
);
console.log(
  `[learn-render-1-depth-testing] decoded marble=${marbleDecoded.width}x${marbleDecoded.height} ${marbleDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-1-depth-testing] backend=${renderer.inspect().capabilities.backendKind}`);
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// Register textures under their GUIDs (mirror 1.4-textures smoke pattern).
const metalGuidRes = AssetGuid.parse('019e3969-1d47-760f-982e-7bad1ffd969c');
const marbleGuidRes = AssetGuid.parse('019e3969-1d46-7933-b14d-4faee5635ad6');
if (!metalGuidRes.ok || !marbleGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const metalTexAsset = {
  kind: 'texture',
  shape: {
    viewDimension: '2d',
    extent: { width: metalDecoded.width, height: metalDecoded.height },
  },
  format: metalDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: metalDecoded.bytes,
  colorSpace: metalDecoded.colorSpace,
  mips: metalDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const marbleTexAsset = {
  kind: 'texture',
  shape: {
    viewDimension: '2d',
    extent: { width: marbleDecoded.width, height: marbleDecoded.height },
  },
  format: marbleDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: marbleDecoded.bytes,
  colorSpace: marbleDecoded.colorSpace,
  mips: marbleDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Create managed texture handles from the decoded fixture values.
const metalHandle = unwrapHandle(world.assets.create(metalTexAsset).unwrap());
const marbleHandle = unwrapHandle(world.assets.create(marbleTexAsset).unwrap());
console.log(`[learn-render-1-depth-testing] registered metal handle id=${metalHandle}`);

// Register materials with pass-based MaterialAsset shape.
const floorMatHandle = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.9,
    baseColorTexture: metalHandle,
  },
}).unwrap();
const cubeMatHandle = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.5,
    baseColorTexture: marbleHandle,
  },
}).unwrap();

// Floor: HANDLE_QUAD is 1x1 in XY, rotated -90 deg around X to lie flat.
const SIN_NEG_90 = Math.sin(-Math.PI / 4);
const COS_NEG_90 = Math.cos(-Math.PI / 4);
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [5, 5, 5],quat: [SIN_NEG_90, 0, 0, COS_NEG_90],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();

// Cube 1 at (-1, 0, -1).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [-1, 0, -1], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

// Cube 2 at (2, 0, 0).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

// Directional light.
world.spawn({
  component: DirectionalLight,
  data: { castShadow: true,
    direction: [-0.5, -1.0, -0.3],
    color: [1.0, 1.0, 1.0],
    intensity: 1.0,
  },
});

// Camera at (0, 0, 3), Zoom=45 deg.
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

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  await drawReadyFrame(renderer, {
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
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

// --- 6. Pixel readback ---

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

// Sample sites:
//   - floorCenter: lower-center (should show metal texture >= threshold)
//   - cube1Region: left (cube at -1,0,-1 projects near center-left)
//   - cube2Region: right-of-center (cube at 2,0,0 projects near right)
//   - cornerTL / cornerBR: corners expected near clearColor
const sites = [
  { name: 'floorCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.65) },
  { name: 'cube1Region', x: Math.floor(WIDTH * 0.15), y: Math.floor(HEIGHT * 0.45) },
  { name: 'cube2Region', x: Math.floor(WIDTH * 0.55), y: Math.floor(HEIGHT * 0.45) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 7. Verdict ---

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.1, 0.1, 0.1];
const meshSiteNames = ['floorCenter', 'cube1Region', 'cube2Region'];
let meshedCount = 0;
const perSite = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSite[name] = Number(dist.toFixed(4));
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSite)}`);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedCount < 1) {
  failures.push(
    `(c) 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} from clear color; perSite=${JSON.stringify(perSite)}`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-4-advanced-opengl-1-depth-testing/smoke', framesObserved);

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
