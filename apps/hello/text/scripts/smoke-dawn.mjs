#!/usr/bin/env node
import { smokeFrameBudget, emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
// Complete 60 presented Renderer submissions using the baked DejaVu Font closure.
// Native GlyphText must remain free of generated ECS Mesh components and render
// at least 200 visible text pixels. FALSIFY=atlas-empty removes the Font binding
// and must fall below that threshold. SMOKE_PIPELINE_DELAY_MS delays every async
// pipeline completion, reproducing a slow (lavapipe) compiler on any machine.

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();


const SMOKE_MIN_FRAMES = smokeFrameBudget();
const FALSIFY = process.env.FALSIFY ?? '';
const REQUIRE_VISIBLE = process.env.TEXT_SMOKE_REQUIRE_VISIBLE !== '0';
const PIPELINE_DELAY_MS = Number(process.env.SMOKE_PIPELINE_DELAY_MS ?? 0);
// Pending frames wait on pipeline preparation; they are not presented frames.
const READY_DEADLINE_MS = 120_000;

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    if (PIPELINE_DELAY_MS > 0) {
      for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
        const create = dev[name].bind(dev);
        dev[name] = async (descriptor) => {
          const pipeline = await create(descriptor);
          await delay(PIPELINE_DELAY_MS);
          return pipeline;
        };
      }
    }
    return dev;
  };
  return adapter;
};

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
  tagName: 'CANVAS',
  isConnected: true,
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

const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { World } = await import('@forgeax/engine-ecs');
const { GlyphText } = await import('@forgeax/engine-render/authoring');
const { BLOOM_ENABLED, Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective, TONEMAP_REINHARD_EXTENDED } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');


// Same four authored scenes as src/text-scenes.ts.
const TEXT_SCENES = [
  { p: { pos: [-3, 2.5, 0], quat: [0, 0, 0, 1] }, text: 'PLAYER 1', color: [1, 1, 1, 1] },
  { p: { pos: [-3, 0, 0], quat: [0, 0, 0, 1] }, text: 'HP\nMANA', color: [0.6, 0.9, 1, 1] },
  { p: { pos: [1, 2.5, 0], quat: [0, 0, 0, 1] }, text: 'BLOOM', color: [3, 2.4, 1.2, 1] },
  { p: { pos: [1.6, -1.0, 0], quat: [0, 0, 0, 1] }, text: 'HIDDEN', color: [1, 0.8, 0.2, 1] },
];

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!constructed.ok) throw constructed.error;
const { renderer, assets } = constructed.value;
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
console.log(`[hello-text] backend=${renderer.inspect().capabilities.backendKind}`);
const world = new World({ assets });
const lease = renderer.attach(world).unwrap();
const onErrorEvents = [];
renderer.subscribe(event => { if (event.kind === 'error') onErrorEvents.push({code:event.error.code,hint:event.error.hint}); });

// An absent Font binding intentionally produces no text pixels.
let fontHandle;
if (FALSIFY === 'atlas-empty') {
  fontHandle = 0;
} else {
  fontHandle = await registerBakedFont(assets);
}

const textEntities = spawnTextScenes(world, fontHandle).map((e) => e);

// Occluder cube (AC-11) + light + camera mirror the demo.
const cubeMat = assets.create({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: { baseColor: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [2.2, -1.0, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]} },
  { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
  { component: MeshRenderer, data: { materials: [cubeMat] } },
);
world.spawn({
  component: DirectionalLight,
  data: { castShadow: true, direction: [-0.3, -0.5, -0.8], color: [1, 1, 1], intensity: 1.2 },
});
world.spawn(
  { component: Transform, data: { pos: [0, 0, 8]} },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      tonemap: TONEMAP_REINHARD_EXTENDED,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomSmoothWidth: 0.01,
      bloomRadius: 0,
    },
  },
);

let totalFrames = 0;
let pendingFrames = 0;
let pendingReason;
const loopStarted = performance.now();
while (totalFrames < SMOKE_MIN_FRAMES && performance.now() - loopStarted < READY_DEADLINE_MS) {
  world.update(1/60).unwrap();
  const draw = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }).unwrap();
  (await draw.completed).unwrap();
  if (draw.presentation === 'ready') {
    totalFrames++;
  } else {
    pendingFrames++;
    pendingReason ??= draw.presentationPendingReason;
  }
}
await sharedDevice.queue.onSubmittedWorkDone();
console.log(`[smoke] completed frames=${totalFrames} pendingFrames=${pendingFrames}`);

const failures = [];

// (b) onError.
if (onErrorEvents.length > 0) {
  failures.push(`(b) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}

// (c) console.error.
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(`(c) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
}

// (d) frame count.
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(
    `(d) presented frames=${totalFrames} < ${SMOKE_MIN_FRAMES} within ${READY_DEADLINE_MS} ms (pending=${pendingFrames}, first reason=${JSON.stringify(pendingReason)})`,
  );
}

// GlyphText remains native authoring state; the Renderer owns its derived geometry.
if (textEntities.some(entity => world.hasComponent(entity, MeshFilter) || world.hasComponent(entity, MeshRenderer)))
  failures.push('(e) GlyphText unexpectedly introduced derived Mesh components');

// (g) AC-19 visible-text pixel readback (gated by TEXT_SMOKE_REQUIRE_VISIBLE).
// The four text scenes are positioned off-center in world space, so a single
// center-pixel probe is the wrong sample point. Instead, scan the whole frame
// and count text pixels: a pixel is "text" when it is bright AND distinct from
// both the black background and the flat-grey occluder cube (which renders a
// uniform ~(111,111,111) under the directional light). White / light-blue /
// HDR-bright / yellow text all clear this bar; the cube and background do not.
// This is robust to scene layout yet stays sensitive to the text path -- the
// FALSIFY=atlas-empty variant (no font, no text mesh) drops the count to ~0
// (verified locally), so a regression that unbinds the atlas or zeroes alpha
// fails this gate.
if (REQUIRE_VISIBLE) {
  const textPixels = await countTextPixels().catch(() => -1);
  if (textPixels < 0) {
    failures.push('(g) AC-19: pixel readback failed (copyTextureToBuffer/map error)');
  } else if (FALSIFY === 'atlas-empty') {
    if (textPixels >= 200) failures.push(`atlas-empty falsifier still found ${textPixels} text pixels`);
    else console.log(`[smoke] FALSIFY atlas-empty PASS: textPixels=${textPixels}`);
  } else if (textPixels < 200) {
    failures.push(
      `(g) AC-19: only ${textPixels} text pixels (< 200) -- world-space text not visible`,
    );
  } else {
    console.log(`[smoke] (g) AC-19 PASS - ${textPixels} world-space text pixels visible`);
  }
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, onError=0, textEntities=${textEntities.length}, backend=${renderer.inspect().capabilities.backendKind}`);
if (FALSIFY === '') emitSmokeReceipt('hello-text/smoke', totalFrames);
renderer.dispose();
if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);

// === helpers ================================================================
//
// MUST stay in sync with apps/hello/text/src/text-scenes.ts.

function spawnTextScenes(world, fontHandle) {
  const out = [];
  for (const s of TEXT_SCENES) {
    out.push(
      world.spawn(
        { component: Transform, data: s.p },
        {
          component: GlyphText,
          data: { fontHandle, text: s.text, fontSize: 0.025, color: s.color },
        },
      ).unwrap(),
    );
  }
  return out;
}

async function registerBakedFont(assets) {
  // Reuse the source Pack metrics and decode its atlas into the managed runtime closure.
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const fontDir = resolve(repoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
  const atlasPngBytes = readFileSync(resolve(fontDir, 'DejaVuSansMono.atlas.png'));
  const packJson = JSON.parse(readFileSync(resolve(fontDir, 'DejaVuSansMono.font.pack.json'), 'utf8'));

  const { parseImage } = await import('@forgeax/engine-image/parse-image');
  const result = parseImage(atlasPngBytes, 'image/png', { colorSpace: 'linear', mipmap: false });
  if (!result.ok) throw result.error;
  const decoded = result.value;

  const fontPayload = packJson.assets[0].payload;
  const atlas = assets.create({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
    format: 'rgba8unorm',
    data: decoded.bytes,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  }).unwrap();
  const sampler = assets.create({kind:'sampler',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',magFilter:'linear',minFilter:'linear'}).unwrap();

  return assets.create({
    kind: 'font',
    atlas,
    sampler,
    glyphs: fontPayload.glyphs,
    common: fontPayload.common,
  }).unwrap();
}

// Count "text" pixels across the whole frame: bright pixels that are NOT the
// flat-grey occluder cube. The cube renders a near-uniform grey (~111,111,111)
// under the directional light; text renders white / light-blue / HDR-bright /
// yellow -- all of which are either much brighter than the cube or noticeably
// chromatic (max-min channel spread). Background is black. Returns -1 on
// readback failure. bgra8unorm: r=o+2, g=o+1, b=o+0.
async function countTextPixels() {
  if (!sharedDevice || !renderTarget) return -1;
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x0001 | 0x0008 });
  const enc = sharedDevice.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: renderTarget }, { buffer, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  sharedDevice.queue.submit([enc.finish()]);
  await buffer.mapAsync(0x0001);
  const arr = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = y * bytesPerRow + x * 4;
      const r = arr[o + 2];
      const g = arr[o + 1];
      const b = arr[o];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      // Brighter than the cube grey (>140) OR chromatic (channel spread >40).
      if (mx > 140 || mx - mn > 40) count++;
    }
  }
  return count;
}
