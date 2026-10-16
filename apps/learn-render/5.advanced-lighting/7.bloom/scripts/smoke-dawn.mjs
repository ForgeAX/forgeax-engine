#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/7.bloom/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.7 - Bloom dawn-node smoke.
// Structural-only: >=60 frames, onError=0, perFramePassNames includes
// the five-level Bloom chain + tonemap. Camera.bloom readback asserts spawn wiring.
// No pixel readback (bloom visual verdict is verify-step territory).
//
// Scene mirrors src/index.ts: wood floor + 6 container crates + 4 HDR
// point lights with bright unlit light-box cubes (the bloom source).
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-7-bloom] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');
const CONTAINER2_SRC_PATH = resolve(TEXTURES_DIR, 'container2.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';

// Scene constants -- kept in lockstep with src/index.ts (the dawn smoke
// rebuilds the same scene without the dev-server pack path).
const LIGHT_COLORS = [
  [5.0, 5.0, 5.0],
  [10.0, 0.0, 0.0],
  [0.0, 0.0, 15.0],
  [0.0, 5.0, 0.0],
];
const LIGHT_POSITIONS = [
  [0.0, 0.5, 1.5],
  [-4.0, 0.5, -3.0],
  [3.0, 0.5, 1.0],
  [-0.8, 2.4, -1.0],
];
const CONTAINER_BOXES = [
  { pos: [0.0, 1.5, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [2.0, 0.0, 1.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [-1.0, -1.0, 2.0], scale: 1.0, axis: [1, 0, 1], deg: 60 },
  { pos: [0.0, 2.7, 4.0], scale: 1.25, axis: [1, 0, 1], deg: 23 },
  { pos: [-2.0, 1.0, -3.0], scale: 1.0, axis: [1, 0, 1], deg: 124 },
  { pos: [-3.0, 0.0, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
];
const DEG2RAD = Math.PI / 180;

// Bloom pass names expected in the bounded ten-pass chain when Bloom is enabled.
const BLOOM_PASS_NAMES = [
  'bloom-downsample-0',
  'bloom-downsample-1',
  'bloom-downsample-2',
  'bloom-downsample-3',
  'bloom-downsample-4',
  'bloom-upsample-3',
  'bloom-upsample-2',
  'bloom-upsample-1',
  'bloom-upsample-0',
  'bloom-composite',
];
const OUTPUT_TRANSFORM_PASS_NAME = 'output-transform';

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-7-bloom' smoke",
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

if (!existsSync(WOOD_SRC_PATH) || !existsSync(CONTAINER2_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixtures missing: ${WOOD_SRC_PATH} or ${CONTAINER2_SRC_PATH}`,
  );
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode textures + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine/render');
const { BLOOM_ENABLED, Camera, MeshFilter, MeshRenderer, PointLight, TONEMAP_REINHARD_EXTENDED } = await import('@forgeax/engine/render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { quat } = await import('@forgeax/engine-math');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
const container2DecodeRes = await decodeImageFromFile(CONTAINER2_SRC_PATH);
if (!woodDecodeRes.ok || !container2DecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    woodDecodeRes.ok ? null : woodDecodeRes.error.code,
    container2DecodeRes.ok ? null : container2DecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
const { decoded: container2Decoded } = container2DecodeRes.value;
console.log(
  `[learn-render-7-bloom] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);
console.log(
  `[learn-render-7-bloom] decoded container2=${container2Decoded.width}x${container2Decoded.height} ${container2Decoded.mime}`,
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
let debugDrawHost;
try {
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: MANIFEST_URL },
  );
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
  debugDrawHost = constructed.value.debugDrawHost;
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-7-bloom] backend=${renderer.inspect().capabilities.backendKind}`);

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// Register textures under their GUIDs.
const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
if (!woodGuidRes.ok || !container2GuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

function makeTexAsset(decoded) {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
    format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    data: decoded.bytes,
    colorSpace: decoded.colorSpace,
    mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
  };
}

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Catalogue the textures under their GUIDs, then mint shared-ref column handles.
const woodTexAsset = makeTexAsset(woodDecoded);
const container2TexAsset = makeTexAsset(container2Decoded);
assets.catalog(woodGuidRes.value, woodTexAsset);
assets.catalog(container2GuidRes.value, container2TexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);
const container2Handle = world.allocSharedRef('TextureAsset', container2TexAsset);
console.log(`[learn-render-7-bloom] registered wood handle id=${woodHandle}`);
console.log(`[learn-render-7-bloom] registered container2 handle id=${container2Handle}`);

// Register materials: wood floor + container crates (standard PBR).
const floorMatHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({
    baseColor: [1.0, 1.0, 1.0, 1.0],
    roughness: 0.9,
    baseColorTexture: unwrapHandle(woodHandle),
  }),
);
const containerMatHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({
    baseColor: [1.0, 1.0, 1.0, 1.0],
    roughness: 0.8,
    baseColorTexture: unwrapHandle(container2Handle),
  }),
);

// Spawn wood floor (bloom.cpp: translate (0,-1,0), scale (12.5,0.5,12.5)).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, -1.0, 0], quat: [0, 0, 0, 1], scale: [12.5, 0.5, 12.5],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMatHandle] } },
  )
  .unwrap();

// Spawn the six wooden container boxes.
const rot = quat.create();
for (const box of CONTAINER_BOXES) {
  quat.fromAxisAngle(rot, box.axis, box.deg * DEG2RAD);
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [box.pos[0], box.pos[1], box.pos[2]], quat: [rot[0], rot[1], rot[2], rot[3]], scale: [box.scale, box.scale, box.scale],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [containerMatHandle] } },
    )
    .unwrap();
}

// Spawn the four HDR point lights + their bright unlit light-box cubes
// (the bloom source: unlit cube painted with the HDR light colour).
for (let i = 0; i < LIGHT_POSITIONS.length; i++) {
  const pos = LIGHT_POSITIONS[i];
  const color = LIGHT_COLORS[i];
  world.spawn(
    {
      component: Transform,
      data: { pos: [pos[0], pos[1], pos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    {
      component: PointLight,
      data: { color: [color[0], color[1], color[2]], intensity: 1.0, range: 30.0 },
    },
  );
  const lightBoxMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([color[0], color[1], color[2], 1.0]),
  );
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [pos[0], pos[1], pos[2]], quat: [0, 0, 0, 1], scale: [0.25, 0.25, 0.25],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [lightBoxMat] } },
    )
    .unwrap();
}

// Camera with bloom enabled + tonemap (URP default pipeline path).
const cameraEntity = world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: WIDTH / HEIGHT,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_REINHARD_EXTENDED,
        exposure: 1.0,
        bloom: BLOOM_ENABLED,
        bloomThreshold: 1.0,
        bloomIntensity: 1.0,
        bloomSoftKnee: 0.5,
        bloomScatter: 0.7,
      },
    },
  )
  .unwrap();

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

// Pass diagnostics stay on the Runtime-owned host; public Renderer exposes only
// Result/receipt/inspection data.
const passNames = debugDrawHost.perFramePassNames;

// Read back Camera component for bloom field (assert spawn wiring).
const cameraBloomRes = world.get(cameraEntity, Camera);
const cameraBloom = cameraBloomRes.ok ? cameraBloomRes.value.bloom : undefined;

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

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// Check bloom pass names are all present.
const passNameSet = new Set(passNames);
const missingBloomPasses = BLOOM_PASS_NAMES.filter((n) => !passNameSet.has(n));
if (missingBloomPasses.length > 0) {
  failures.push(
    `(d) perFramePassNames missing bloom passes: [${missingBloomPasses.join(', ')}] (got [${passNames.join(', ')}])`,
  );
}
if (!passNameSet.has(OUTPUT_TRANSFORM_PASS_NAME)) {
  failures.push(
    `(e) perFramePassNames missing output-transform pass (got [${passNames.join(', ')}])`,
  );
}

// Check Camera.bloom = BLOOM_ENABLED (spawn wiring regression guard).
if (cameraBloom !== BLOOM_ENABLED) {
  failures.push(
    `(f) Camera.bloom=${cameraBloom} (expected ${BLOOM_ENABLED} = BLOOM_ENABLED)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-7-bloom' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - ${failures.length === 0 ? 'all' : 'remaining'} criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, bloom passes present, output-transform pass present, Camera.bloom=BLOOM_ENABLED`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
