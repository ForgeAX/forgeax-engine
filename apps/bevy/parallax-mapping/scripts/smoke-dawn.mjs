#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// apps/bevy/parallax-mapping/scripts/smoke-dawn.mjs
//
// Bevy 3D parallax_mapping Dawn smoke.
// Structural-only: >=60 frames, onError=0, no pixel readback. This is the
// regression baseline; the pixel-readback discriminator (non-black +
// displacement-visible + algo-switch diff) lives in scripts/smoke-browser.mjs.
//
// The custom parallax shader declares THREE textures (baseColor / normal /
// HEIGHT). installMaterialArtifact needs the post-naga_oil COMPOSED WGSL, which
// only the build produces -> this smoke reads dist/shaders/manifest.json (build
// the demo first: `pnpm -F <pkg> build`).
//
// Output literals (preserved for grep tooling):
//   - `[bevy-parallax-mapping] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const DIFFUSE_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2.jpg');
const NORMAL_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2_normal.jpg');
const HEIGHT_SRC_PATH = resolve(TEXTURES_DIR, 'bricks2_disp.jpg');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping' smoke",
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm'.
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

if (!existsSync(DIFFUSE_SRC_PATH) || !existsSync(NORMAL_SRC_PATH) || !existsSync(HEIGHT_SRC_PATH)) {
  console.error('[smoke] FAIL - asset fixtures missing under', TEXTURES_DIR);
  console.error('  rerun: git submodule update --init --recursive (forgeax-engine-assets)');
  process.exit(1);
}

// --- 4. Decode textures + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_QUAD } = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const decodeOrExit = async (path, label) => {
  const res = await decodeImageFromFile(path);
  if (!res.ok) {
    console.error(`[smoke] FAIL - decodeImageFromFile(${label}) failed: ${res.error.code}`);
    process.exit(1);
  }
  return res.value.decoded;
};
const diffuseDecoded = await decodeOrExit(DIFFUSE_SRC_PATH, 'bricks2');
const normalDecoded = await decodeOrExit(NORMAL_SRC_PATH, 'bricks2_normal');
const heightDecoded = await decodeOrExit(HEIGHT_SRC_PATH, 'bricks2_disp');
console.log(
  `[bevy-parallax-mapping] decoded bricks2=${diffuseDecoded.width}x${diffuseDecoded.height} normal+disp ok`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

const backend = renderer.inspect().capabilities.backendKind;
console.log(`[bevy-parallax-mapping] backend=${backend}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


// --- 5. Register custom parallax shader from the BUILT composed WGSL ---

const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  console.error(
    '  hint: rebuild via `pnpm --filter @forgeax/bevy-parallax-mapping build',
  );
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const parallaxEntry = (demoManifest.materialShaders ?? []).find(
  (m) => m && m.identifier === 'bevy::parallax_mapping',
);
if (!parallaxEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing bevy::parallax_mapping entry');
  process.exit(1);
}
// --- 6. Catalogue textures + spawn scene ---

const mkTex = (decoded) => ({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
  format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: decoded.bytes,
  colorSpace: decoded.colorSpace,
  mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
});

const guids = {
  diffuse: AssetGuid.parse('019e3969-1d45-744f-8269-e1b1c6e6a8cf'),
  normal: AssetGuid.parse('019e3969-1d45-7020-8756-675a0f885532'),
  height: AssetGuid.parse('019e3969-1d45-7d3e-9bc8-55fcdc87beab'),
};
if (!guids.diffuse.ok || !guids.normal.ok || !guids.height.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const drawFrame = () => renderer.draw({
  leases: [lease],
  camera: { lease },
  environment: { lease },
});
const assets = hostAssets;
const diffuseTex = mkTex(diffuseDecoded);
const normalTex = mkTex(normalDecoded);
const heightTex = mkTex(heightDecoded);
assets.catalog(guids.diffuse.value, diffuseTex);
assets.catalog(guids.normal.value, normalTex);
assets.catalog(guids.height.value, heightTex);
const diffuseHandle = world.allocSharedRef('TextureAsset', diffuseTex);
const normalHandle = world.allocSharedRef('TextureAsset', normalTex);
const heightHandle = world.allocSharedRef('TextureAsset', heightTex);
console.log(`[bevy-parallax-mapping] registered bricks2 handle id=${diffuseHandle}`);

for (const [index, algoMode] of [0, 1, 2].entries()) {
  const material = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'bevy::parallax_mapping' }, renderState: { tags: { LightMode: 'Forward' } } }],
    parameters: [
      { name: 'baseColor', type: 'color' },
      { name: 'heightScale', type: 'f32' },
      { name: 'algoMode', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'heightTexture', type: 'texture' },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      heightScale: 0.1,
      algoMode,
      baseColorTexture: unwrapHandle(diffuseHandle),
      normalTexture: unwrapHandle(normalHandle),
      heightTexture: unwrapHandle(heightHandle),
    },
  });
  world.spawn(
    { component: Transform, data: { pos: [(index - 1) * 2.25, 0, 0], quat: [0, 0, 0, 1], scale: [1.85, 1.85, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
}

world.spawn({
  component: DirectionalLight,
  data: { direction: [0.5, -0.5, -1], color: [1, 1, 1], intensity: 3, castShadow: false },
});

world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
);

// --- 7. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${SMOKE_MIN_FRAMES})`,
);

// --- 8. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (backend !== 'webgpu') failures.push(`(a) backend=${backend} (expected webgpu)`);
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
    '  rerun: pnpm --filter @forgeax/bevy-parallax-mapping smoke',
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
