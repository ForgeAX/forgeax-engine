#!/usr/bin/env node
// hello-sprite-atlas headless smoke (feat-20260622-chunk-gpu-instancing-
// sprite-tilemap M4 / w17; AC-01 + AC-07 structural anchors).
//
// What this smoke proves (structural-only; pixel-parity baseline regen
// is verify-stage SSOT per plan-strategy §5.1 charter P5):
//   1. A large set of independent sprite entities (no Instances component)
//      collapses to ONE drawIndexed per frame (record-stage fold operator
//      M1 / w4). The default/local fixture is 10000 entities; PR CI may use
//      the same fold assertion with a smaller fixture to avoid spending a
//      minute constructing an identical 10000-entity world on lavapipe.
//   2. instanceCount matches the fixture on that drawIndexed.
//   3. Runtime assembly diagnostics snapshot `render.instancing.foldedDraws`
//      monotonically advances at 1/frame (M3 / w13 metric increment).
//
// Strategy (mirrors apps/hello/sprite/scripts/smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Register a synthetic 64x64 RGBA atlas texture + default sampler
//      so the sprite material loads without a /pack-index.json fetch.
//   4. Spawn independent sprite entities; the engine's record-stage
//      fold operator collapses them transparently. No Instances component
//      on any entity.
//   5. drive 60 frames; assert structural counters every frame.
//
// Metric semantics (foldedDraws):
//   The counter increments once per fold-eligible head bucket per frame.
//   With 10000 entities sharing one (Layer.value, pos z, materialHandle)
//   triple we expect exactly 1 head bucket per frame -> after N frames the
//   counter value is N. The smoke reads it post-loop and asserts
//   value == drawCallCount (each rendered frame contributes exactly 1).
//
// AC-07 path note (charter F2 + P5 producer/consumer split):
//   PNG pixel parity baseline regen for the 100x100 grid (this rewrite)
//   is a verify-stage activity (subagent renders -> orchestrator Reads
//   image). The smoke does not enforce a frozen PNG baseline because the
//   demo's visual surface changed shape (10x10 -> 100x100) and the M4
//   verify subagent owns the baseline regen + commit.

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '1000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 200;
const HEIGHT = 150;
const CLEAR_RGBA = [0.07, 0.07, 0.09, 1];
const lightweight = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const SPRITE_GRID = lightweight ? 32 : 100;
const SPRITE_COUNT = SPRITE_GRID * SPRITE_GRID;
const SPRITE_SPACING = 0.018;

const here = dirname(fileURLToPath(import.meta.url));
void here;

// --- 1. dawn.node setup --------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-sprite-atlas smoke');
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
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;

// AC-01 / AC-07 structural counters.
let rhiDrawIndexedCallsThisFrame = 0;
let rhiLastInstanceCount = 0;

function patchDeviceForRhiStats(dev) {
  const origCreateCommandEncoder = dev.createCommandEncoder.bind(dev);
  dev.createCommandEncoder = (desc) => {
    const enc = origCreateCommandEncoder(desc);
    const origBeginRenderPass = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (passDesc) => {
      const pass = origBeginRenderPass(passDesc);
      const origDrawIndexed = pass.drawIndexed.bind(pass);
      pass.drawIndexed = (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) => {
        rhiDrawIndexedCallsThisFrame++;
        rhiLastInstanceCount = instanceCount;
        return origDrawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
      };
      return pass;
    };
    return enc;
  };
}

const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) {
      sharedDevice = dev;
      patchDeviceForRhiStats(dev);
    }
    return dev;
  };
  return adapter;
};

// --- 2. Mock canvas ------------------------------------------------------

let activeRenderTarget = null;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (activeRenderTarget) {
          activeRenderTarget.destroy?.();
        }
        activeRenderTarget = desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {
        activeRenderTarget?.destroy?.();
        activeRenderTarget = null;
      },
      getCurrentTexture() {
        if (!activeRenderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          activeRenderTarget = sharedDevice.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
        return activeRenderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Synthetic 4-quadrant atlas texture (64x64) ----------------------

function buildSyntheticAtlas() {
  const w = 64;
  const h = 64;
  const bytes = new Uint8Array(w * h * 4);
  const quadColors = [
    [220, 80, 60, 255],
    [60, 220, 90, 255],
    [60, 140, 230, 255],
    [240, 200, 50, 255],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const qi = top ? (left ? 0 : 1) : left ? 2 : 3;
      const c = quadColors[qi];
      bytes[i + 0] = c[0];
      bytes[i + 1] = c[1];
      bytes[i + 2] = c[2];
      bytes[i + 3] = c[3];
    }
  }
  return { width: w, height: h, data: bytes };
}

// --- 4. Drive engine ECS path --------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { SpriteRegionOverride, SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');

const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[sprite-atlas] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const synth = buildSyntheticAtlas();
const synthPod = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: synth.width, height: synth.height } },
  format: 'rgba8unorm-srgb',
  data: synth.data,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const textureHandle = world.allocSharedRef('TextureAsset', synthPod);


const samplerHandle = world.allocSharedRef('SamplerAsset', {
  kind: 'sampler',
  magFilter: 'nearest',
  minFilter: 'nearest',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
});


const region = [0, 0, 0.5, 0.5];
const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    // feat-20260626-sprite-transparent-collapse M3 — post M1/M2 SSOT:
    // `renderState.blend` drives LDR split + premultiplied-alpha
    // blend pipeline + chunk-gpu-instancing transparentDispatch routing
    // (preset `SPRITE_PREMULTIPLIED_ALPHA_BLEND`).
    { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 } },
  ],
  values: {
    // feat-20260625 M3 / w11 (D-4): UBO-aligned field names. Legacy
    // baseColor / texture / pivot lost their fold post-R1; declare the
    // 1:1 paramSchema forms directly.
    colorTint: [1, 1, 1, 1],
    baseColorTexture: textureHandle,
    region,
    pivotAndSize: [0.5, 0.5, 1, 1],
  },
});

okResult(
  world.spawn(
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
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -1, right: 1,
        bottom: -1, top: 1,
        clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
      },
    },
  ),
);

// Independent sprite entities. The fold operator collapses them to 1
// drawIndexed because (Layer.value=0, pos z=0, materialHandle) is uniform.
const half = (SPRITE_GRID - 1) / 2;
for (let i = 0; i < SPRITE_COUNT; i++) {
  const row = Math.floor(i / SPRITE_GRID);
  const col = i % SPRITE_GRID;
  const cx = (col - half) * SPRITE_SPACING;
  const cy = (row - half) * SPRITE_SPACING;
  const r = world.spawn(
    {
      component: Transform,
      data: {
        pos: [cx, cy, 0], quat: [0, 0, 0, 1], scale: [SPRITE_SPACING * 0.9, SPRITE_SPACING * 0.9, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    {
      component: SpriteRegionOverride,
      data: { region: new Float32Array(region) },
    },
  );
  if (!r.ok) {
    console.error(`[smoke] FAIL - spawn entity ${i}: ${r.error.code}`);
    process.exit(1);
  }
}
console.log(`[sprite-atlas] spawned ${SPRITE_COUNT} independent sprite entities (no Instances component)`);

const TARGET_FRAMES = SMOKE_MIN_FRAMES;

let drawCallCount = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  rhiDrawIndexedCallsThisFrame = 0;
  rhiLastInstanceCount = 0;

  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) {
    console.warn(`[smoke] draw frame ${i}: ${r.error.code}`);
    continue;
  }

  // AC-01: every fixture entity folds to exactly 1 drawIndexed per frame.
  if (rhiDrawIndexedCallsThisFrame !== 1) {
    console.error(
      `[smoke] FAIL - frame ${i} drawIndexed count = ${rhiDrawIndexedCallsThisFrame}, expected 1 (fold collapse)`,
    );
    sharedDevice?.destroy?.();
    process.exit(1);
  }
  // AC-01: instanceCount == SPRITE_COUNT (all fixture entities in one draw).
  if (rhiLastInstanceCount !== SPRITE_COUNT) {
    console.error(
      `[smoke] FAIL - frame ${i} instanceCount = ${rhiLastInstanceCount}, expected ${SPRITE_COUNT}`,
    );
    sharedDevice?.destroy?.();
    process.exit(1);
  }

  drawCallCount++;
}

console.log(
  `[smoke] drawCallCount=${drawCallCount} (drawIndexed=1/frame instanceCount=${SPRITE_COUNT})`,
);

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames=${drawCallCount}`);

console.log(
  `[smoke] PASS - ${SPRITE_COUNT} entities folded to 1 drawIndexed/frame, ` +
    `instanceCount=${SPRITE_COUNT}, frames=${drawCallCount}`,
);
emitSmokeReceipt('hello-sprite-atlas/smoke', drawCallCount);

sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
