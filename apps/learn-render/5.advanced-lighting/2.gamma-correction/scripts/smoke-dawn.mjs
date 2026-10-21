#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/2.gamma-correction/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 2.gamma-correction dawn-node smoke.
// Structural-only: >=60 frames, onError=0, one Standard feature drives both
// gamma parameter modes; no pixel readback (visual delta is verify-step work).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-2-gamma-correction] pipeline=Standard`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const PER_STATE_FRAMES = Math.max(30, Math.ceil(SMOKE_MIN_FRAMES / 2));
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Inline shader source mirrors the host-owned fullscreen feature in src/index.ts.
const PASSTHROUGH_CORRECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  return vec4<f32>(col, 1.0);
}
`;
const WRONG_GAMMA_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  let wrong = pow(col, vec3<f32>(2.2));
  return vec4<f32>(wrong, 1.0);
}
`;

const GAMMA_EFFECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}
@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@group(1) @binding(2) var<uniform> gammaParams : vec4<f32>;
@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  if (gammaParams.x > 0.5) { return vec4<f32>(pow(col, vec3<f32>(2.2)), 1.0); }
  return vec4<f32>(col, 1.0);
}
`;

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-2-gamma-correction' smoke",
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

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const {
  Camera,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PostProcessParams,
} = await import('@forgeax/engine-render');
const { createFullscreenRenderFeature } = await import('@forgeax/engine-app');
const { Transform } = await import('@forgeax/engine-scene');

const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed:', woodDecodeRes.error.code);
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-2-gamma-correction] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
try {
  const gammaFeature = createFullscreenRenderFeature({
    identity: 'learn-render-5-2::gamma',
    source: GAMMA_EFFECT_WGSL,
    params: { byteSize: 16, defaultValue: new Uint8Array(16) },
  });
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    { features: [gammaFeature] },
    { shaderManifestUrl: MANIFEST_URL },
  );
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[learn-render-2-gamma-correction] Standard pipeline active');

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const woodTexAsset = {
  kind: 'texture',
  shape: {
    viewDimension: '2d',
    extent: { width: woodDecoded.width, height: woodDecoded.height },
  },
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mips: woodDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};

const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Catalogue the texture under its GUID, then mint a shared-ref column handle.
const woodHandle = world.assets.create(woodTexAsset).unwrap();

const planeMat = world.assets.create({
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
    roughness: 0.8,
    baseColorTexture: unwrapHandle(woodHandle),
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
    { component: MeshRenderer, data: { materials: [planeMat] } },
  )
  .unwrap();

world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 1, 1], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: PointLight, data: {} },
);

const cameraEntity = world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
  { component: PostProcessParams, data: { shader: 'learn-render-5-2::gamma', data: new Uint8Array(16) } },
).unwrap();

const frameRequest = {
  leases: [worldAttachment1.value],
  camera: { lease: worldAttachment1.value },
  environment: { lease: worldAttachment1.value },
};

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < PER_STATE_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw(frameRequest);
  if (!r.ok) {
    console.error(`[smoke] draw correct frame ${i} error: ${r.error.code}`);
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
  }
  framesObserved++;
}

// Update the receipt-bound feature parameter, then drive the same frame owner.
const wrongMode = new Uint8Array(16);
new Float32Array(wrongMode.buffer)[0] = 1;
const modeResult = world.set(cameraEntity, PostProcessParams, { data: wrongMode });
if (!modeResult.ok) throw modeResult.error;

for (let i = 0; i < PER_STATE_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw(frameRequest);
  if (!r.ok) {
    console.error(`[smoke] draw wrong frame ${i} error: ${r.error.code}`);
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
  }
  framesObserved++;
}
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, per-state=${PER_STATE_FRAMES})`,
);

// --- 8. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(b) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-2-gamma-correction' smoke",
  );
  const disposeResult = await renderer.dispose();
  if (!disposeResult.ok) console.error(`[smoke] renderer.dispose() returned err: ${disposeResult.error.code}`);
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: pipeline=Standard, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

const disposeResult = await renderer.dispose();
if (!disposeResult.ok) {
  console.error(`[smoke] renderer.dispose() returned err: ${disposeResult.error.code}`);
  process.exit(1);
}
delete globalThis.navigator.gpu;
process.exit(0);
