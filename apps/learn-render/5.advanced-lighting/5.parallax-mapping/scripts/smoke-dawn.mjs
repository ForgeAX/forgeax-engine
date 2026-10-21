#!/usr/bin/env node
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
// apps/learn-render/5.advanced-lighting/5.parallax-mapping/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 5.parallax-mapping dawn-node smoke.
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
//   - `[learn-render-5-5-parallax] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
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
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

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
  `[learn-render-5-5-parallax] decoded bricks2=${diffuseDecoded.width}x${diffuseDecoded.height} normal+disp ok`,
);

const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  console.error(
    "  hint: rebuild via `pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping' build`",
  );
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(demoManifest))}`;

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

console.log(`[learn-render-5-5-parallax] backend=${renderer.inspect().capabilities.backendKind}`);

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// --- 5. Catalogue textures + spawn scene ---

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

const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const diffuseTex = mkTex(diffuseDecoded);
const normalTex = mkTex(normalDecoded);
const heightTex = mkTex(heightDecoded);
const diffuseHandle = world.assets.create(diffuseTex).unwrap();
const normalHandle = world.assets.create(normalTex).unwrap();
const heightHandle = world.assets.create(heightTex).unwrap();
console.log(`[learn-render-5-5-parallax] registered bricks2 handle id=${diffuseHandle}`);

const matHandle = world.assets.create({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'learn_render::5_5_parallax' }, renderState: { tags: { LightMode: 'Forward' } } }],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    heightScale: 0.1,
    // POM (2.0) -> exercises the deepest march path so the structural smoke
    // covers the heaviest pipeline branch.
    algoMode: 2.0,
    baseColorTexture: unwrapHandle(diffuseHandle),
    normalTexture: unwrapHandle(normalHandle),
    heightTexture: unwrapHandle(heightHandle),
  },
}).unwrap();

world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  )
  .unwrap();

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
  await drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-5-advanced-lighting-5-parallax-mapping/smoke', framesObserved);

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
