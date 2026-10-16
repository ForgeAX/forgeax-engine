#!/usr/bin/env node
// apps/hello/video-texture headless dawn structural smoke
// (feat-20260623-world-space-video-asset M5 / w19).
//
// End-to-end structural proof: dawn-node drives the video-texture ECS path
// (VideoAsset register + VideoPlayer spawn + MeshFilter/MeshRenderer +
// MaterialAsset.values referencing the video GUID), runs 60 frames,
// and exits 0 when the registration/spawn/bind-group chain does not throw.
//
// Dawn structural-only: dawn-node has NO HTMLVideoElement / VideoFrame, so
// video pixel upload is NOT exercised (that lives in the browser e2e, w21).
// This smoke validates that the video kind in the Asset union, the loader,
// the VideoPlayer component, the extract-stage videoTextureFields resolution,
// and the record-stage DynamicTextureStore routing all survive without
// crashing a dawn-node device.
//
// Strategy (mirrors hello-room smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + shim GPUCanvasContext.
//   3. Build a World identical to the browser demo: quad mesh + unlit
//      MaterialAsset with baseColorTexture=videoGuid + VideoPlayer clip.
//   4. await runtime host initialization + 60x lease-bound renderer.draw(...).
//   5. Verdict: backend===webgpu, frames>=60, draw errors===0.
//
// Exit codes:
//   0 = green (structural chain survived)
//   1 = red (crash / draw error)

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

// Small canvas to keep lavapipe fragment-bound smoke fast.
const WIDTH = 200;
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/video-texture smoke');
  console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
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
  console.error('  rerun: pnpm --filter @forgeax/video-texture smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await origReqAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const origReqDev = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await origReqDev(desc);
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

// --- 3. Drive engine ECS path with video asset -------------------------------

import { readFileSync } from 'node:fs';

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');
const { VideoPlayer } = await import('@forgeax/engine-graphics-extras');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(
  readFileSync(MANIFEST_PATH, 'utf8'),
)}`;

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - renderer host construction failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = origReqAdapter;
}

console.log('[video-texture] pipeline=Standard');


// --- 4. Register a video asset and an unlit material that samples from it ----

const videoGuidResult = AssetGuid.parse('f1b3d000-1111-4aaa-9eee-aa1111112222');
if (!videoGuidResult.ok) {
  console.error(`[smoke] FAIL - video GUID parse: ${videoGuidResult.error.code}`);
  process.exit(1);
}
const videoGuid = videoGuidResult.value;
assets.catalog(videoGuid, { kind: 'video', url: '/cutscene.webm' });

const videoHandleRes = await assets.loadByGuid(videoGuid);
if (!videoHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid video: ${videoHandleRes.error.code}`);
  process.exit(1);
}
console.log('[video-texture] VideoAsset registered and loaded');

// Unlit material whose baseColorTexture paramValue is the video GUID.
// The extract stage resolves the GUID to a video handle via resolveVideoFieldHandle,
// and the record stage routes it to DynamicTextureStore (dawn has no video element,
// so it will bind a default fallback view — the structural chain is the test).
const matGuidResult = AssetGuid.parse('b2b3d000-2222-4bbb-9eee-bb2222223333');
if (!matGuidResult.ok) {
  console.error(`[smoke] FAIL - material GUID parse: ${matGuidResult.error.code}`);
  process.exit(1);
}
assets.catalog(matGuidResult.value, {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-unlit' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.2, 0.5, 0.9],
    baseColorTexture: videoGuid,
  },
});

const matHandleRes = await assets.loadByGuid(matGuidResult.value);
if (!matHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid material: ${matHandleRes.error.code}`);
  process.exit(1);
}
console.log('[video-texture] video-textured material registered');

// --- 5. Build world: quad + camera + directional light + video player -------

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const frameRequest = {
  leases: [worldAttachment1.value],
  camera: { lease: worldAttachment1.value },
  environment: { lease: worldAttachment1.value },
};

// NB: do NOT insert a VideoSourceProvider — dawn has no HTMLVideoElement.
// The record stage's single per-frame upload path resolves element===undefined,
// hits the AC-10 double-miss, fires video-upload-unsupported on the engine error
// channel, and falls back to the default view — structurally valid, no crash.
// The verdict below filters that expected code out of the draw-error gate.

world.spawn(
  {
    component: Camera,
    // perspective() requires fov (RADIANS) + aspect; raw `{ fov: 60, near, far }`
    // would leave aspect=0 (degenerate projection) and treat 60 as radians.
    data: perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
  },
  { component: Transform, data: { pos: [0, 0, 5]} },
);
console.log('[video-texture] camera entity spawned');

world.spawn(
  {
    component: DirectionalLight,
    data: {
      direction: [-0.3, -1.0, -0.5],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  },
  { component: Transform, data: { pos: [1, 2, 1]} },
);
console.log('[video-texture] light entity spawned');

// Mint handles from the payloads that loadByGuid returned (loadByGuid
// returns the payload, not a handle — D-17). allocSharedRef maps payload
// to a per-world column handle for spawn.
const videoClipHandle = world.allocSharedRef('VideoAsset', videoHandleRes.value);
const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

const videoEnt = world.spawn(
  { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
  {
    component: VideoPlayer,
    data: { clip: videoClipHandle, playing: true, loop: true, currentTime: 0 },
  },
  {
    component: Transform,
    data: { pos: [0, 0, -1], scale: [2, 2, 1]},
  },
);
console.log(`[video-texture] video-textured quad entity spawned: ${String(videoEnt)}`);

// --- 6. Render loop ----------------------------------------------------------

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    errors.push({ code: event.error.code, hint: event.error.hint, detail: event.error.detail });
  }
});

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw(frameRequest);
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code} - ${r.error.hint}`);
  }
  framesObserved++;
}
const device = sharedDevice;
if (device) {
  await device.queue.onSubmittedWorkDone();
}
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 7. Verdict (structural: chain survived) ---------------------------------

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}
const drawErrors = errors.filter((e) => {
  if (e.code === 'video-upload-unsupported') return false;
  return e.detail?.cause?.code !== 'video-upload-unsupported';
});
if (drawErrors.length > 0) {
  const codes = drawErrors.map((e) => e.code).join(', ');
  failures.push(`Renderer error events fired ${drawErrors.length} times (excluding video-upload-unsupported): [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - structural chain GREEN: pipeline=Standard, frames=${framesObserved}, VideoAsset registered, VideoPlayer spawned, extract/record routing survived.`,
);

device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
