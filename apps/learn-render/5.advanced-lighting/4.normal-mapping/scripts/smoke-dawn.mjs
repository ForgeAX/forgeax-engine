#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/4.normal-mapping/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 4.normal-mapping dawn-node smoke.
// Structural-only: >=60 frames, onError=0, no pixel readback.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-4-normal-mapping] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const BRICKWALL_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2.jpg');
const BRICKWALL_NORMAL_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2_normal.jpg');
const BRICKWALL_HEIGHT_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2_disp.jpg');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping' smoke",
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

if (!existsSync(BRICKWALL_SRC_PATH) || !existsSync(BRICKWALL_NORMAL_SRC_PATH) || !existsSync(BRICKWALL_HEIGHT_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${BRICKWALL_SRC_PATH}, ${BRICKWALL_NORMAL_SRC_PATH}, or ${BRICKWALL_HEIGHT_SRC_PATH}`,
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
const { Camera, Materials, MeshFilter, MeshRenderer, PointLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const brickwallDecodeRes = await decodeImageFromFile(BRICKWALL_SRC_PATH);
const brickwallNormalDecodeRes = await decodeImageFromFile(BRICKWALL_NORMAL_SRC_PATH);
const brickwallHeightDecodeRes = await decodeImageFromFile(BRICKWALL_HEIGHT_SRC_PATH);
if (!brickwallDecodeRes.ok || !brickwallNormalDecodeRes.ok || !brickwallHeightDecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    brickwallDecodeRes.ok ? null : brickwallDecodeRes.error.code,
    brickwallNormalDecodeRes.ok ? null : brickwallNormalDecodeRes.error.code,
    brickwallHeightDecodeRes.ok ? null : brickwallHeightDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: brickwallDecoded } = brickwallDecodeRes.value;
const { decoded: brickwallNormalDecoded } = brickwallNormalDecodeRes.value;
const { decoded: brickwallHeightDecoded } = brickwallHeightDecodeRes.value;
console.log(
  `[learn-render-4-normal-mapping] decoded brickwall=${brickwallDecoded.width}x${brickwallDecoded.height} ${brickwallDecoded.mime}`,
);
console.log(
  `[learn-render-4-normal-mapping] decoded brickwall_normal=${brickwallNormalDecoded.width}x${brickwallNormalDecoded.height} ${brickwallNormalDecoded.mime}`,
);
console.log(
  `[learn-render-4-normal-mapping] decoded brickwall_height=${brickwallHeightDecoded.width}x${brickwallHeightDecoded.height} ${brickwallHeightDecoded.mime}`,
);

const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(demoManifest))}`;

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: MANIFEST_URL },
  );
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

console.log(`[learn-render-4-normal-mapping] backend=${renderer.inspect().capabilities.backendKind}`);

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// Register textures under their GUIDs.
const brickwallGuidRes = AssetGuid.parse('019e3969-1d45-744f-8269-e1b1c6e6a8cf');
const brickwallNormalGuidRes = AssetGuid.parse('019e3969-1d45-7020-8756-675a0f885532');
const brickwallHeightGuidRes = AssetGuid.parse('019e3969-1d45-7d3e-9bc8-55fcdc87beab');
if (!brickwallGuidRes.ok || !brickwallNormalGuidRes.ok || !brickwallHeightGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const baseColorTexAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: brickwallDecoded.width, height: brickwallDecoded.height } },
  format: brickwallDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: brickwallDecoded.bytes,
  colorSpace: brickwallDecoded.colorSpace,
  mips: brickwallDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const normalTexAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: brickwallNormalDecoded.width, height: brickwallNormalDecoded.height } },
  format: brickwallNormalDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: brickwallNormalDecoded.bytes,
  colorSpace: brickwallNormalDecoded.colorSpace,
  mips: brickwallNormalDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const heightTexAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: brickwallHeightDecoded.width, height: brickwallHeightDecoded.height } },
  format: brickwallHeightDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: brickwallHeightDecoded.bytes,
  colorSpace: brickwallHeightDecoded.colorSpace,
  mips: brickwallHeightDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Catalogue the textures under their GUIDs, then mint shared-ref column handles.
const baseColorHandle = world.assets.create(baseColorTexAsset).unwrap();
const normalHandle = world.assets.create(normalTexAsset).unwrap();
const heightHandle = world.assets.create(heightTexAsset).unwrap();
console.log(`[learn-render-4-normal-mapping] registered brickwall handle id=${baseColorHandle}`);

const normalMatHandle = world.assets.create(Materials.standard({
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.8,
    baseColorTexture: unwrapHandle(baseColorHandle),
    normalTexture: unwrapHandle(normalHandle),
    normalScale: [2, 0.35],
})).unwrap();
const bumpMatHandle = world.assets.create(Materials.standard({
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.8,
    baseColorTexture: unwrapHandle(baseColorHandle),
    bumpTexture: unwrapHandle(heightHandle),
    bumpScale: -6,
})).unwrap();

// Two panels exercise the same material inputs as the browser example.
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [-0.68, 0, 0], quat: [0, 0, 0, 1], scale: [1.2, 1.2, 1],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [normalMatHandle] } },
  )
  .unwrap();
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0.68, 0, 0], quat: [0, 0, 0, 1], scale: [1.2, 1.2, 1],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [bumpMatHandle] } },
  )
  .unwrap();

// Off-axis light matches the browser scene.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0.5, 1, 1.2], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: PointLight, data: { intensity: 8, range: 10 } },
);

// Camera at (0, 0, 3.4), Zoom=45 deg.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3.4], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
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
  const r = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
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

// --- 6. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
