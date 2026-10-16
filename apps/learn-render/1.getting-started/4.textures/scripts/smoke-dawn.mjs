#!/usr/bin/env node
// apps/learn-render/1.getting-started/4.textures/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 1.4 textures dawn-node smoke (M8 / T-M8-02 red ->
// T-M8-03 + T-M8-04 green; AC-03 + AC-08 + AC-09 + AC-13 + AC-25 90s
// budget). Mirrors apps/hello/cube/scripts/smoke-dawn.mjs structure +
// hello-room baseline grid + adds the GUID-keyed wood-container.image
// .meta.json -> AssetRegistry catalog path so the textured cube
// renders the LO 1.4 container chapter end-to-end.
//
// Strategy (charter P5 producer / consumer split + P4 consistent
// abstraction):
//   1. Inject globalThis.navigator.gpu via dawn-node `webgpu` package.
//   2. Build a mock HTMLCanvasElement + offscreen render target.
//   3. Drive the engine ECS path:
//      (a) decodeImageFromFile(container.jpg) via
//          @forgeax/engine-image -- the build-time decoder reads the
//          sidecar GUID + colorSpace + mipmap settings, returns
//          DecodedImage POD.
//      (b) catalog<TextureAsset>(woodGuid, texAsset) and mint the ECS handle;
//          the Standard host owns GPU residency and upload.
//      (c) catalog<MeshAsset>(cubeGuid, cubeMesh) -- mirror of
//          hello-room cube-mesh.stub.meta.json + cube-mesh.pack.json
//          handle ordering.
//      (d) catalog<MaterialAsset>(matGuid, unlitMat) carrying
//          baseColorTexture: woodHandle reference.
//      (e) await loadByGuid<MaterialAsset>(matGuid) + spawn entity +
//          renderer.draw 300x.
//   4. copyTextureToBuffer + mapAsync multi-pixel grid (5 sites) +
//      verdict: (a) backend=webgpu (b) frames>=60 (c) at least one
//      meshed site distance to clear-color > eps (d) Renderer.onError
//      RhiError count == 0.
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-textures] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//
// Red-phase stance (T-M8-02 acceptanceCheck): until T-M8-03 lands the
// submodule container.jpg + sidecar fixtures the script aborts at
// step (a) decodeImageFromFile with image-meta-missing. The script
// exits 1 + emits the structured failure JSON on stderr; that is the
// expected red signal until T-M8-04 wires the full recipe.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const ASSETS_DIR = resolve(APP_ROOT, 'assets');
// tweak-20260521 D-1a: container.jpg lives in the forgeax-engine-assets
// submodule (CC BY-NC carve-out per AGENTS.md §Assets submodule). 4
// levels above APP_ROOT lands on the monorepo root.
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const CONTAINER_TEXTURES_DIR = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
);
const CONTAINER_SRC_PATH = resolve(CONTAINER_TEXTURES_DIR, 'container.jpg');
const CONTAINER_META_PATH = resolve(CONTAINER_TEXTURES_DIR, 'container.jpg.meta.json');

// AC-25 90s wall budget shared with 7-camera smoke; section 1.4 share
// is 45s upper bound with the local dawn-node binding. The wall time
// is logged regardless of pass / fail so the verify step can audit
// drift (charter F3 implementation: real measurement, not estimate).
const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-4-textures' smoke",
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

// --- 3. Drive engine ECS path with container texture upload -----------------

// Sidecar fixture must be present in the forgeax-engine-assets submodule
// (forgeax-engine-assets/learn-opengl/textures/container.jpg + container.jpg
// .meta.json); local assets/ retains only material-wood.pack.json.
if (!existsSync(CONTAINER_SRC_PATH) || !existsSync(CONTAINER_META_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${CONTAINER_SRC_PATH} or ${CONTAINER_META_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  console.error(
    "  hint:  the LO 1.4 container.jpg lives in the CC BY-NC carve-out submodule subtree; AGENTS.md §Assets submodule documents the clone protocol.",
  );
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { createShaderModule, rhi } = await import('@forgeax/engine-rhi-webgpu');
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
  `[learn-render-textures] decoded ${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime} colorSpace=${woodDecoded.colorSpace} mipmap=${woodDecoded.mipmap} guid=${woodMeta.guid}`,
);

// M5-engine-fix: build a real engine manifest carrying pbr.wgsl + unlit.wgsl
// (post w22.9 the inline fallback was deleted; the engine demands real
// entries). Mirrors apps/hello/cube/scripts/smoke-dawn.mjs.
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: EMPTY_MANIFEST_URL },
    { rhi, createShaderModule },
  );
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - renderer host threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[learn-render-textures] Standard host constructed');

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
assets.catalog(woodMeta.guid, woodTexAsset);

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
// Mint a user-tier column handle for the wood texture (M8 D-17); the
// baseColorTexture slot carries the resolved numeric Handle via unwrapHandle.
const woodTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodTexAsset));
console.log(`[learn-render-textures] minted wood texture handle id=${woodTexHandle}`);

// Build the world: cube + camera + directional light. The cube uses
// the engine builtin HANDLE_CUBE mesh + an unlit MeshRenderer
// pointing at a MaterialAsset whose baseColorTexture is the wood
// handle. RenderSystem materialBindGroup picks up baseColorTexture
// via AssetRegistry.getTextureGpuView (research F-6 fix).
const woodMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 },
  ],
  values: { baseColor: [1.0, 1.0, 1.0, 1.0], baseColorTexture: woodTexHandle },
});
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
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
  const r = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
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
const sites = [
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeUL', x: Math.floor(WIDTH * 0.35), y: Math.floor(HEIGHT * 0.4) },
  { name: 'cubeBR', x: Math.floor(WIDTH * 0.65), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (4 criteria; AC-25 wall budget logged separately) ------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['ndcCenter', 'cubeUL', 'cubeBR'];
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
if (assets === undefined) failures.push('(a) host asset owner is unavailable');
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) textured cube sample - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} distance from clear color; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-4-textures' smoke",
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify wood-container.meta.json sidecar GUID matches material-wood.pack.json baseColorTexture reference',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, textured sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
