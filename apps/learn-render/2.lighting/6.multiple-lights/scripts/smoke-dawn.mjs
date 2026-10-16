#!/usr/bin/env node
// apps/learn-render/2.lighting/6.multiple-lights/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 2.6 multiple-lights dawn-node smoke
// (feat-20260611 w14 / M3 round-2 fix-up I-6 -- real-scene adaptation
// per src/index.ts).
//
// Walks the LO 2.6 multi-light scene the demo runs in production:
//   1. decodeImageFromFile(container2.png + container2_specular.png).
//   2. registerWithGuid<TextureAsset> for both.
//   3. registerWithGuid<MeshAsset>(cubeGuid, HANDLE_CUBE asset).
//   4. unlit material with diffuse baseColorTexture for the lit cubes.
//   5. spawn the LO 1.6/2.5 10-cube grid + DirectionalLight + 4
//      PointLights AND a colored small lamp cube per PointLight (LO
//      2.6 differential vs LO 2.5: each PL spawns its own lamp marker
//      with its own per-instance unlit material) + camera SpotLight.
//
// Differential axes vs hello-triangle / light-casters (D-2 / D-8
// byte-level):
//   - GUID set: 4 GUIDs (diffuse + specular + cube + main material) +
//     4 anonymous lamp materials (one per PointLight) -- 8 register*
//     calls total, NOT 4.
//   - clear color: engine teal default.
//   - sample sites: 4 colored lamp markers + lit cube grid; probe
//     names tied to LO 2.6's "multi-light loop" idiom.
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-multiple-lights] backend=webgpu`
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
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const DIFFUSE_SRC_PATH = resolve(TEXTURES_DIR, 'container2.png');
const DIFFUSE_META_PATH = resolve(TEXTURES_DIR, 'container2.png.meta.json');
const SPECULAR_SRC_PATH = resolve(TEXTURES_DIR, 'container2_specular.png');
const SPECULAR_META_PATH = resolve(TEXTURES_DIR, 'container2_specular.png.meta.json');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
// LO 2.6 own material GUID -- last byte 03 (vs 01 LO 2.4, 02 LO 2.5).
const CUBE_MATERIAL_GUID = '019e3969-2000-7000-8000-000000000003';
const LAMP_SCALE = 0.2;

const CUBE_POSITIONS = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];
const POINT_LIGHT_POSITIONS = [
  [0.7, 0.2, 2.0],
  [2.3, -3.3, -4.0],
  [-4.0, 2.0, -12.0],
  [0.0, 0.0, -3.0],
];
const POINT_LIGHT_COLORS = [
  [1.0, 1.0, 1.0],
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
];

// --- 1. dawn.node binding setup ----------------------------------------------

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

// --- 2. Mock canvas ---------------------------------------------------------

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

// --- 3. Drive engine ECS path -----------------------------------------------

if (
  !existsSync(DIFFUSE_SRC_PATH) ||
  !existsSync(DIFFUSE_META_PATH) ||
  !existsSync(SPECULAR_SRC_PATH) ||
  !existsSync(SPECULAR_META_PATH)
) {
  console.error('[smoke] FAIL - container2 / container2_specular asset fixtures missing');
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, PointLight, SpotLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  resolveAssetHandle,
} = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const diffuseRes = await decodeImageFromFile(DIFFUSE_SRC_PATH);
const specularRes = await decodeImageFromFile(SPECULAR_SRC_PATH);
if (!diffuseRes.ok || !specularRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed');
  process.exit(1);
}
const { decoded: diffuseDecoded, meta: diffuseMeta } = diffuseRes.value;
const { decoded: specularDecoded, meta: specularMeta } = specularRes.value;
console.log(
  `[learn-render-multiple-lights] decoded diffuse=${diffuseDecoded.width}x${diffuseDecoded.height} specular=${specularDecoded.width}x${specularDecoded.height}`,
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
  console.error(`[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-multiple-lights] backend=${renderer.inspect().capabilities.backendKind}`);
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
const errors = [];
renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  if (errors.length === 0) {
    console.error('[smoke] first renderer event error:');
    console.dir(event.error, { depth: null });
  }
  errors.push({ code: event.error.code, hint: event.error.hint });
});


const diffuseGuidRes = AssetGuid.parse(diffuseMeta.guid);
const specularGuidRes = AssetGuid.parse(specularMeta.guid);
const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
const matGuidRes = AssetGuid.parse(CUBE_MATERIAL_GUID);
if (!diffuseGuidRes.ok || !specularGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failure');
  process.exit(1);
}
const mkTex = (decoded) => ({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
  format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: decoded.bytes,
  colorSpace: decoded.colorSpace,
  mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
});
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
// feat-20260614 M8 (D-15/D-17): textures mint user-tier column handles via
// allocSharedRef; GUIDs are catalogued for loadByGuid parity.
const diffuseHandle = world.allocSharedRef('TextureAsset', mkTex(diffuseDecoded));
const specularHandle = world.allocSharedRef('TextureAsset', mkTex(specularDecoded));
assets.catalog(diffuseGuidRes.value, mkTex(diffuseDecoded));
assets.catalog(specularGuidRes.value, mkTex(specularDecoded));
const cubeAssetRes = resolveAssetHandle(world, HANDLE_CUBE);
if (!cubeAssetRes.ok) {
  console.error('[smoke] FAIL - HANDLE_CUBE asset unavailable');
  process.exit(1);
}
assets.catalog(cubeGuidRes.value, cubeAssetRes.value);

const litMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: { baseColor: [1.0, 1.0, 1.0, 1.0], baseColorTexture: unwrapHandle(diffuseHandle) },
});
void specularHandle;
// LO 2.6 10 lit cubes (same array as LO 1.6 / 2.5).
for (let i = 0; i < CUBE_POSITIONS.length; i++) {
  const pos = CUBE_POSITIONS[i];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [pos[0], pos[1], pos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [litMaterial] } },
  );
}

world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.2, -1, -0.3],
    color: [1, 1, 1],
    intensity: 0.5,
  },
});

// LO 2.6 multi-light loop differential: each PL gets its own coloured
// lamp cube + own per-instance unlit material with the PL colour
// baked into baseColor (NOT shared white lamp like LO 2.4).
for (let i = 0; i < POINT_LIGHT_POSITIONS.length; i++) {
  const plPos = POINT_LIGHT_POSITIONS[i];
  const plColor = POINT_LIGHT_COLORS[i];
  const lampMat = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
    values: { baseColor: [plColor[0], plColor[1], plColor[2], 1.0] },
  });
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [plPos[0], plPos[1], plPos[2]], quat: [0, 0, 0, 1], scale: [LAMP_SCALE, LAMP_SCALE, LAMP_SCALE],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [lampMat] } },
    {
      component: PointLight,
      data: {
        color: [plColor[0], plColor[1], plColor[2]],
        intensity: 100,
        range: 50,
      },
    },
  );
}

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
  {
    component: SpotLight,
    data: {
      direction: [0, 0, -1],
      color: [1, 1, 1],
      intensity: 4,
      range: 50,
      innerConeDeg: 12.5,
      outerConeDeg: 17.5,
    },
  },
);

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
    if (i === 0) {
      console.error('[smoke] first draw error:', r.error);
    }
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
    else framesObserved++;
  }
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

// --- 4. Pixel readback ------------------------------------------------------

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
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
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
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
// LO 2.6 sample sites: probe litCube0 at NDC origin + 3 lamp marker
// positions (whitelampNear / redLampMid / blueLampClose) covering the
// 4 PointLight markers' projected NDC.
const sites = [
  { name: 'litCube0', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'whiteLampNear', x: Math.floor(WIDTH * 0.62), y: Math.floor(HEIGHT * 0.48) },
  { name: 'litCubeFar', x: Math.floor(WIDTH * 0.36), y: Math.floor(HEIGHT * 0.52) },
  { name: 'blueLampClose', x: Math.floor(WIDTH * 0.5), y: Math.floor(HEIGHT * 0.48) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (4 criteria) ------------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['litCube0', 'whiteLampNear', 'litCubeFar'];
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

void matGuidRes;

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) LO 2.6 multi-light loop - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD}; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-6-multiple-lights' smoke",
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-2-lighting-6-multiple-lights/smoke', framesObserved);

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, LO 2.6 multi-light + 4 coloured lamps sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
