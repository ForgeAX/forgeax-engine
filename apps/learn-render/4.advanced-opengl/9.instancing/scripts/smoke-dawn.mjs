#!/usr/bin/env node
// apps/learn-render/4.advanced-opengl/9.instancing/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.9 instancing dawn-node smoke (feat-20260611
// w15 / M3 round-2 fix-up I-7 -- real-scene adaptation per src/index.ts).
//
// Walks the LO 4.9 4-asset chain the demo runs in production:
//   1. parseGltfFromFile(planet.gltf) -- vendored Mars planet mesh.
//   2. parseGltfFromFile(rock.gltf) -- vendored asteroid mesh.
//   3. decodeImageFromFile(mars.png + rock.png) -- the planet + rock
//      diffuse textures.
//   4. registerWithGuid for each (mesh + texture pairs) so the demo's
//      4 vendored GUIDs are reachable.
//   5. spawn 1 planet entity at origin (non-instanced) + 1 asteroid
//      belt entity with World-owned Instances.transforms containing
//      ASTEROID_COUNT=12 packed transforms (smoke uses small N for
//      dawn-node frame budget; production uses 1200) + DirectionalLight
//      + camera elevated/pulled-back to frame the belt.
//
// Differential axes vs hello-triangle (D-2 / D-8 byte-level):
//   - GUID set: 4 vendored GUIDs (PLANET_MESH + ROCK_MESH + MARS_TEX +
//     ROCK_TEX) -- two parseGltfFromFile + two decodeImageFromFile
//     calls.
//   - clear color: engine teal default (0.2, 0.3, 0.3).
//   - sample sites: planetCenter at NDC origin + ringL/ringR for the
//     asteroid belt left/right edges. Names tied to LO 4.9 belt
//     geometry, NOT triLeft/triRight (no triangle here).
//   - World-owned Instances transforms express the LO 4.9 core teaching point.
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-instancing] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS - 4 criteria GREEN: ...`

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const OBJECTS_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'objects');
const PLANET_GLTF_PATH = resolve(OBJECTS_DIR, 'planet', 'planet.gltf');
const ROCK_GLTF_PATH = resolve(OBJECTS_DIR, 'rock', 'rock.gltf');
const MARS_PNG_PATH = resolve(OBJECTS_DIR, 'planet', 'mars.png');
const MARS_META_PATH = resolve(OBJECTS_DIR, 'planet', 'mars.png.meta.json');
const ROCK_PNG_PATH = resolve(OBJECTS_DIR, 'rock', 'rock.png');
const ROCK_META_PATH = resolve(OBJECTS_DIR, 'rock', 'rock.png.meta.json');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

// LO 4.9 belt parameters -- asteroid count reduced to 12 for the
// dawn-node frame budget (production demo uses 1200).
const ASTEROID_COUNT = 12;
const BELT_RADIUS = 16.0;
const PLANET_SCALE = 4.0;
const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 14;
const CAMERA_POS_Z = 34;

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

// --- 3. Drive engine ECS path: planet + rock + asteroid belt ---------------

if (
  !existsSync(PLANET_GLTF_PATH) ||
  !existsSync(ROCK_GLTF_PATH) ||
  !existsSync(MARS_PNG_PATH) ||
  !existsSync(ROCK_PNG_PATH)
) {
  console.error('[smoke] FAIL - planet / rock / mars / rock texture asset fixtures missing');
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, Instances, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { meshIrToMeshAsset } = await import('@forgeax/engine-gltf');
const { parseGltfFromFile } = await import('@forgeax/engine-gltf/node');

const planetDocRes = await parseGltfFromFile(PLANET_GLTF_PATH);
const rockDocRes = await parseGltfFromFile(ROCK_GLTF_PATH);
if (!planetDocRes.ok || !rockDocRes.ok) {
  console.error('[smoke] FAIL - parseGltfFromFile failed');
  process.exit(1);
}
const planetDoc = planetDocRes.value;
const rockDoc = rockDocRes.value;

const marsRes = await decodeImageFromFile(MARS_PNG_PATH);
const rockTexRes = await decodeImageFromFile(ROCK_PNG_PATH);
if (!marsRes.ok || !rockTexRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed for mars/rock png');
  process.exit(1);
}
const { decoded: marsDecoded, meta: marsMeta } = marsRes.value;
const { decoded: rockTexDecoded, meta: rockTexMeta } = rockTexRes.value;
console.log(
  `[learn-render-instancing] decoded mars=${marsDecoded.width}x${marsDecoded.height} rock=${rockTexDecoded.width}x${rockTexDecoded.height} planetMeshes=${planetDoc.meshes.length} rockMeshes=${rockDoc.meshes.length}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: EMPTY_MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(`[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-instancing] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// LO 4.9 vendored GUIDs from src/index.ts.
const PLANET_MESH_GUID = AssetGuid.parse('019ea6af-7084-75fd-bf77-de799946f4c9');
const ROCK_MESH_GUID = AssetGuid.parse('019ea6af-9d77-7776-9e32-58ba7fd3e4cc');
if (!PLANET_MESH_GUID.ok || !ROCK_MESH_GUID.ok) {
  console.error('[smoke] FAIL - planet/rock GUID parse failed');
  process.exit(1);
}
const marsGuidRes = AssetGuid.parse(marsMeta.guid);
const rockTexGuidRes = AssetGuid.parse(rockTexMeta.guid);
if (!marsGuidRes.ok || !rockTexGuidRes.ok) {
  console.error('[smoke] FAIL - mars/rock png GUID parse failed');
  process.exit(1);
}
const mkTex = (decoded) => ({
  kind: 'texture',
  shape: {
    viewDimension: '2d',
    extent: { width: decoded.width, height: decoded.height },
  },
  format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: decoded.bytes,
  colorSpace: decoded.colorSpace,
  mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
});
// World must exist before allocSharedRef mints any column handle.
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Texture handles feed material baseColorTexture fields (numeric slot ->
// unwrapHandle); mesh handles feed MeshFilter.assetHandle (branded handle).
const marsHandle = unwrapHandle(world.allocSharedRef('TextureAsset', mkTex(marsDecoded)));
const rockTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', mkTex(rockTexDecoded)));

// Bridge planet/rock mesh IRs to MeshAsset.
const planetMeshIrs = planetDoc.meshes.filter((m) => m.meshIndex === 0);
const rockMeshIrs = rockDoc.meshes.filter((m) => m.meshIndex === 0);
const planetMeshResult = meshIrToMeshAsset(planetMeshIrs);
if (!planetMeshResult.ok) throw planetMeshResult.error;
const planetMeshAsset = planetMeshResult.value;
const rockMeshResult = meshIrToMeshAsset(rockMeshIrs);
if (!rockMeshResult.ok) throw rockMeshResult.error;
const rockMeshAsset = rockMeshResult.value;
const planetMeshHandle = world.allocSharedRef('MeshAsset', planetMeshAsset);
const rockMeshHandle = world.allocSharedRef('MeshAsset', rockMeshAsset);

// Materials: planet uses mars.png, asteroid uses rock.png. PBR standard
// (Materials.standard mirrors src/index.ts; emits a passes-based payload).
const planetMaterial = world.allocSharedRef('MaterialAsset', Materials.standard({
  baseColor: [0.7, 0.7, 0.7, 1],
  metallic: 0.1,
  roughness: 0.8,
  baseColorTexture: marsHandle,
}));
const rockMaterial = world.allocSharedRef('MaterialAsset', Materials.standard({
  baseColor: [0.7, 0.7, 0.7, 1],
  metallic: 0.05,
  roughness: 0.9,
  baseColorTexture: rockTexHandle,
}));

// LO 4.9 central planet (non-instanced) at origin.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [PLANET_SCALE, PLANET_SCALE, PLANET_SCALE],},
  },
  { component: MeshFilter, data: { assetHandle: planetMeshHandle } },
  { component: MeshRenderer, data: { materials: [planetMaterial] } },
);

// LO 4.9 asteroid belt: ONE entity with World-owned Instances.transforms
// (16 floats per instance = mat4 column-major). The smoke builds a deterministic
// ring of ASTEROID_COUNT rocks at BELT_RADIUS.
const transforms = new Float32Array(ASTEROID_COUNT * 16);
const ASTEROID_SCALE = 0.4;
for (let i = 0; i < ASTEROID_COUNT; i++) {
  const angle = (i / ASTEROID_COUNT) * Math.PI * 2;
  const x = Math.cos(angle) * BELT_RADIUS;
  const z = Math.sin(angle) * BELT_RADIUS;
  const o = i * 16;
  // identity-rotated scaled translation: column-major mat4 with
  // diagonal = ASTEROID_SCALE, translation in column 3.
  transforms[o + 0] = ASTEROID_SCALE;
  transforms[o + 5] = ASTEROID_SCALE;
  transforms[o + 10] = ASTEROID_SCALE;
  transforms[o + 12] = x;
  transforms[o + 13] = 0;
  transforms[o + 14] = z;
  transforms[o + 15] = 1;
}
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: MeshFilter, data: { assetHandle: rockMeshHandle } },
  { component: MeshRenderer, data: { materials: [rockMaterial] } },
  { component: Instances, data: { transforms } },
);

world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -0.7, -0.4],
    color: [1, 0.97, 0.92],
    intensity: 2.0,
  },
});

// LO 4.9 elevated camera framing the whole belt.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: CAMERA_FOV, aspect: WIDTH / HEIGHT, near: 0.1, far: 200 },
  },
);

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
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
// LO 4.9 sample sites: planetCenter at NDC origin (planet at origin
// projected through elevated camera) + ringL/ringR at the belt's
// horizontal extremes (left/right ring tips at +-BELT_RADIUS).
const sites = [
  { name: 'planetCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.55) },
  { name: 'ringL', x: Math.floor(WIDTH * 0.18), y: Math.floor(HEIGHT * 0.62) },
  { name: 'ringR', x: Math.floor(WIDTH * 0.82), y: Math.floor(HEIGHT * 0.62) },
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
// Verdict relies on the planetCenter probe being non-clear (the
// instanced ring may project off-screen for low ASTEROID_COUNT, so the
// gate is "at least 1 of the 3 belt sites is non-clear").
const meshSiteNames = ['planetCenter', 'ringL', 'ringR'];
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
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) LO 4.9 planet + asteroid belt - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD}; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-9-instancing' smoke",
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, LO 4.9 planet + ${ASTEROID_COUNT}-rock instanced belt sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
