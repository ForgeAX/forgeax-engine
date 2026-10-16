#!/usr/bin/env node
// apps/learn-render/4.advanced-opengl/3.blending/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 3.blending dawn-node smoke.
// Pixel-level replica of the LO 4.3 blending scene: metal.png floor +
// marble.jpg cube + 5 grass discard quads (alpha-test.wgsl, alpha < 0.1)
// + 5 window blend quads (SRC_ALPHA/ONE_MINUS_SRC_ALPHA) with mode=3
// distance-based transparent sort (back-to-front per frame).
//
// Textures are decoded from the filesystem via `decodeImageFromFile`
// and registered with `registerWithGuid`.
//
// Falsifiable: set mode=0 (horizontal-z) instead of mode=3 (distance)
// and the transparent window ordering may change, affecting blend
// sampling. Remove the grass discard shader and the grass area samples
// would change.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-3-blending] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 512;
const HEIGHT = 512;

// --- Pre-composed alpha-test WGSL (common.wgsl imports resolved inline) ---
// This is the naga_oil-composed result of alpha-test.wgsl with
// `#import forgeax_view::common::{View, Mesh, view, meshes}` resolved.
// The struct layouts byte-for-byte match packages/shader/src/common.wgsl
// (View 176 B / Mesh world mat4 via 256 B per-entity stride).
// When the engine provides a `composeCustomShader` API, this constant
// can be replaced with a runtime `composeShader()` call.
const COMPOSED_ALPHA_TEST_WGSL = `
struct View {
  worldViewProj   : mat4x4<f32>,
  lightDir        : vec3<f32>,
  lightColor      : vec3<f32>,
  cameraPos       : vec3<f32>,
  lightSpaceMatrix : mat4x4<f32>,
};

struct Mesh {
  worldFromLocal : mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> view : View;

@group(2) @binding(0) var<storage, read> meshes : array<Mesh>;

struct Material {
  baseColor : vec4<f32>,
  metallic  : f32,
  roughness : f32,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalSampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let texSample = textureSample(baseColorTexture, baseColorSampler, in.uv);
  let alpha = material.baseColor.a * texSample.a;
  if (alpha < 0.1) {
    discard;
  }
  return vec4<f32>(material.baseColor.rgb * texSample.rgb, alpha);
}
`;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const METAL_SRC_PATH = resolve(TEXTURES_DIR, 'metal.png');
const MARBLE_SRC_PATH = resolve(TEXTURES_DIR, 'marble.jpg');
const GRASS_SRC_PATH = resolve(TEXTURES_DIR, 'grass.png');
const WINDOW_SRC_PATH = resolve(TEXTURES_DIR, 'window.png');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-3-blending' smoke",
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

const texturePaths = [METAL_SRC_PATH, MARBLE_SRC_PATH, GRASS_SRC_PATH, WINDOW_SRC_PATH];
for (const p of texturePaths) {
  if (!existsSync(p)) {
    console.error(`[smoke] FAIL - asset fixture missing: ${p}`);
    console.error(
      '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
    );
    process.exit(1);
  }
}

// --- 4. Decode textures + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { TransparentSort } = await import('@forgeax/engine-render/authoring');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');
const MODE_DISTANCE = TransparentSort.distance;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const metalDecodeRes = await decodeImageFromFile(METAL_SRC_PATH);
const marbleDecodeRes = await decodeImageFromFile(MARBLE_SRC_PATH);
const grassDecodeRes = await decodeImageFromFile(GRASS_SRC_PATH);
const windowDecodeRes = await decodeImageFromFile(WINDOW_SRC_PATH);
if (
  !metalDecodeRes.ok ||
  !marbleDecodeRes.ok ||
  !grassDecodeRes.ok ||
  !windowDecodeRes.ok
) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    metalDecodeRes.ok ? null : metalDecodeRes.error.code,
    marbleDecodeRes.ok ? null : marbleDecodeRes.error.code,
    grassDecodeRes.ok ? null : grassDecodeRes.error.code,
    windowDecodeRes.ok ? null : windowDecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: metalDecoded } = metalDecodeRes.value;
const { decoded: marbleDecoded } = marbleDecodeRes.value;
const { decoded: grassDecoded } = grassDecodeRes.value;
const { decoded: windowDecoded } = windowDecodeRes.value;
console.log(
  `[learn-render-3-blending] decoded metal=${metalDecoded.width}x${metalDecoded.height} ${metalDecoded.mime}`,
);
console.log(
  `[learn-render-3-blending] decoded grass=${grassDecoded.width}x${grassDecoded.height} ${grassDecoded.mime}`,
);

const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(demoManifest))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-3-blending] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// Runtime consumes the cooked alpha-test module from the demo manifest.
if (!(demoManifest.materialShaders ?? []).some((m) => m?.identifier === 'learn_render::alpha_test')) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing learn_render::alpha_test');
  process.exit(1);
}

// Register textures under their GUIDs.
const METAL_GUID = '019e3969-1d47-760f-982e-7bad1ffd969c';
const MARBLE_GUID = '019e3969-1d46-7933-b14d-4faee5635ad6';
const GRASS_GUID = '019e3969-1d46-73fe-af59-5ce69389b7bb';
const WINDOW_GUID = '019e3969-1d48-75c7-81de-822f424ec949';

function makeTexAsset(decoded) {
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: decoded.width, height: decoded.height },
    },
    format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    data: decoded.bytes,
    colorSpace: decoded.colorSpace,
    mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
  };
}

const metalGuidRes = AssetGuid.parse(METAL_GUID);
const marbleGuidRes = AssetGuid.parse(MARBLE_GUID);
const grassGuidRes = AssetGuid.parse(GRASS_GUID);
const windowGuidRes = AssetGuid.parse(WINDOW_GUID);
if (
  !metalGuidRes.ok ||
  !marbleGuidRes.ok ||
  !grassGuidRes.ok ||
  !windowGuidRes.ok
) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

// World must exist before allocSharedRef mints any column handle.
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

const metalHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(metalDecoded)));
const marbleHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(marbleDecoded)));
const grassHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(grassDecoded)));
const windowHandle = unwrapHandle(world.allocSharedRef('TextureAsset', makeTexAsset(windowDecoded)));
console.log(`[learn-render-3-blending] registered metal handle id=${metalHandle}`);

// Register materials with pass-based MaterialAsset shape.
// ── Floor material: PBR metal.png ──────────────────────────────────
const floorMatHandle = world.allocSharedRef('MaterialAsset', {
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
});

// ── Cube material: PBR marble.jpg ──────────────────────────────────
const cubeMatHandle = world.allocSharedRef('MaterialAsset', {
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
});

// ── Grass material: alpha-test discard shader, Transparent queue ───
const grassMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'learn_render::alpha_test' },
      renderState: { tags: { LightMode: 'Forward' } },
      queue: 3000, // RenderQueue.Transparent
      renderState: { depthWriteEnabled: false },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.5,
    baseColorTexture: grassHandle,
  },
});

// ── Window material: semi-transparent blend, Transparent queue ─────
const windowMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' } },
      queue: 3000, // RenderQueue.Transparent
      renderState: {
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.5,
    baseColorTexture: windowHandle,
  },
});

// Enable mode=3 distance-based transparent sort.
const sortCfgRes = TransparentSort.configure(world, {
  mode: MODE_DISTANCE,
  yzAlpha: 1.0,
});
if (!sortCfgRes.ok) {
  console.error('[smoke] FAIL - setTransparentSortConfig failed:', sortCfgRes.error);
  process.exit(1);
}

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
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();

// Single marble cube at (0, 0.5, 0).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();

// Transparent object positions (LO 4.3 verbatim).
const TRANSPARENT_POSITIONS = [
  [-1.5, 0.0, -0.48],
  [1.5, 0.0, 0.51],
  [0.0, 0.0, 0.7],
  [-0.3, 0.0, -2.3],
  [0.5, 0.0, -0.6],
];

// Spawn 5 grass discard quads.
for (const p of TRANSPARENT_POSITIONS) {
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [p[0], p[1], p[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [grassMatHandle] } },
    )
    .unwrap();
}

// Spawn 5 semi-transparent window quads.
for (const p of TRANSPARENT_POSITIONS) {
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [p[0], p[1], p[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [windowMatHandle] } },
    )
    .unwrap();
}

// Directional light.
world.spawn({
  component: DirectionalLight,
  data: {
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
  const r = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
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

// Sample sites (512x512 canvas, camera at z=3, fov=45 deg):
//   - floorCenter: lower-center (should show metal texture, NOT clearColor)
//   - cubeRegion: center (cube at (0,0.5,0) projects near center)
//   - grassCenter: mid-left (grass at (-1.5,0,-0.48) projects left of center)
//   - windowNear: right-of-center (window at (1.5,0,0.51), near camera)
//   - cornerTL / cornerBR: corners expected near clearColor
const sites = [
  { name: 'floorCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.65) },
  { name: 'cubeRegion', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.4) },
  { name: 'grassCenter', x: Math.floor(WIDTH * 0.12), y: Math.floor(HEIGHT * 0.4) },
  { name: 'windowNear', x: Math.floor(WIDTH * 0.62), y: Math.floor(HEIGHT * 0.42) },
  { name: 'windowFar', x: Math.floor(WIDTH * 0.22), y: Math.floor(HEIGHT * 0.3) },
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

// Core mesh sites: floor + cube + grass should be visibly rendered.
const meshSiteNames = ['floorCenter', 'cubeRegion', 'grassCenter'];
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-3-blending' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-4-advanced-opengl-3-blending/smoke', framesObserved);

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
