#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-text headless smoke (feat-20260531 + tweak-20260610-hello-text-real-msdf-bake).
//
// Strategy: load the pre-baked DejaVu Sans Mono MSDF atlas + glyph metrics from
// forgeax-engine-assets/dejavu-fonts/, register them inline (texture +
// sampler + FontAsset POD), spawn the four world-space text scenes via the
// shared text-scenes.ts module, run N frames, assert the GlyphText pipeline
// rendered visible glyph pixels. Inline-register because dawn-node has no
// vite middleware, no Web Worker, no pluginPack catalog fetch — but the runtime
// fontLoader's POD shape is identical regardless of how the asset was registered.
//
// Verdict criteria:
//   (a) createApp + host initialization + app.start succeed.
//   (b) app.onError fires 0 times.
//   (c) console.error fires 0 times (modulo the smoke's own '[smoke]' lines).
//   (d) frames >= SMOKE_MIN_FRAMES.
//   (e) AC-07: every spawned GlyphText entity gained MeshFilter + MeshRenderer
//       after the first frame's glyphTextLayoutSystem pass.
//   (f) AC-09 single-mesh / single-draw PROXY: deferred-to-PR (no engine
//       draw-call counter; unit-proven by w19).
//   (g) AC-19 visible-text PIXEL readback (default ON; TEXT_SMOKE_REQUIRE_VISIBLE=0
//       to override). Counts text pixels across the whole frame; the real
//       baked DejaVu atlas + multi-channel MSDF reconstruction makes glyphs
//       visible with no engine workaround needed.
//
// Falsification variants (FALSIFY env, local-only, NOT in CI):
//   - FALSIFY=atlas-empty : skip font registration -> no fontHandle, layout
//       system skips every GlyphText entity (no mesh baked) -> criterion (e)
//       FAILs (proves (e) is sensitive to the text path being wired).
//
// Charter P3 explicit failure: on fail, output a structured diagnostic with
// the actual codes + frame count + criterion id so AI users can self-diagnose.

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const REQUIRE_VISIBLE = process.env.TEXT_SMOKE_REQUIRE_VISIBLE !== '0';

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

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
const realPerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
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

const { createApp } = await import('@forgeax/engine-app/browser');
const runtimePkg = await import('@forgeax/engine-runtime');
const { GlyphText } = await import('@forgeax/engine-render/authoring');
const { BLOOM_ENABLED, Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective, TONEMAP_REINHARD_EXTENDED } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

// MUST stay in sync with apps/hello/text/src/text-scenes.ts (lesson:
// smoke-script-duplicate-scene-must-stay-in-sync-with-main). dawn-node cannot
// import the .ts source directly so we duplicate the constants + scene table.
// The font asset is loaded inline below from forgeax-engine-assets/dejavu-fonts/
// (dawn-node has no vite plugin-pack middleware, so we mimic what
// loadByGuid<FontAsset> does at runtime: read the baked .pack.json payload,
// decode the atlas PNG to RGBA, register the texture / sampler / FontAsset
// assets directly). The runtime POD shape is identical regardless of path.

const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
const SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';

const TEXT_SCENES = [
  { p: { pos: [-3, 2.5, 0], quat: [0, 0, 0, 1] }, text: 'PLAYER 1', color: [1, 1, 1, 1] },
  { p: { pos: [-3, 0, 0], quat: [0, 0, 0, 1] }, text: 'HP\nMANA', color: [0.6, 0.9, 1, 1] },
  { p: { pos: [1, 2.5, 0], quat: [0, 0, 0, 1] }, text: 'BLOOM', color: [3, 2.4, 1.2, 1] },
  { p: { pos: [1.6, -1.0, 0], quat: [0, 0, 0, 1] }, text: 'HIDDEN', color: [1, 0.8, 0.2, 1] },
];

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-text] backend=${app.renderer.inspect().capabilities.backendKind}`);

const world = app.world;

const assets = app.assets;
if (assets === null) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// FALSIFY=atlas-empty skips font registration -> fontHandle 0 -> the layout
// system skips every GlyphText entity (no mesh baked) -> criterion (e) FAILs.
let fontHandle;
if (FALSIFY === 'atlas-empty') {
  fontHandle = 0;
} else {
  await registerSharedSampler(assets);
  fontHandle = await registerBakedFont(world, assets);
}

const textEntities = spawnTextScenes(world, fontHandle).map((e) => e);

// Occluder cube (AC-11) + light + camera mirror the demo.
const cubeMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: { baseColor: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 },
});
world.spawn(
  { component: Transform, data: { pos: [2.2, -1.0, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]} },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [cubeMat.value] } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.3, -0.5, -0.8], color: [1, 1, 1], intensity: 1.2 },
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
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
    },
  },
);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));


let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

let totalFrames = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  totalFrames++;
  // Yield to the microtask + timer queue between frames so the engine's
  // async shader-module warmup resolves. The per-MaterialShader pipeline
  // cache first returns rhi-not-available and compiles the module on a
  // microtask (1-frame-warmup idiom); a tight synchronous loop never lets
  // that `.then` land, so the forgeax::msdf-text pipeline would never become
  // available and text would render via the PBR fallback. Real-browser rAF
  // is naturally spaced across the event loop, so this mirrors production.
  await delay(0);
}

globalThis.performance.now = realPerformanceNow;
await delay(2000);

console.log(`[smoke] frames observed=${totalFrames}`);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

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
  failures.push(`(d) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// (e) AC-07: each GlyphText entity gained MeshFilter + MeshRenderer
// (the glyphTextLayoutSystem auto-baked + attached on the first frame).
let attachedCount = 0;
for (const e of textEntities) {
  const hasFilter = world.get(e, MeshFilter).ok;
  const hasRenderer = world.get(e, MeshRenderer).ok;
  if (hasFilter && hasRenderer) attachedCount++;
}
if (FALSIFY === 'atlas-empty') {
  // Falsification expectation: no font -> no mesh attached.
  if (attachedCount !== 0) {
    failures.push(`(FALSIFY atlas-empty) expected 0 attached, got ${attachedCount} -- criterion (e) not sensitive to atlas binding`);
  } else {
    console.log('[smoke] FALSIFY atlas-empty PASS - 0 text meshes baked (e) is sensitive');
  }
} else if (attachedCount !== textEntities.length) {
  failures.push(`(e) AC-07: ${attachedCount}/${textEntities.length} GlyphText entities gained MeshFilter+MeshRenderer`);
} else {
  console.log(`[smoke] (e) AC-07 PASS - ${attachedCount}/${textEntities.length} GlyphText entities auto-gained MeshFilter+MeshRenderer`);
}

// (f) AC-09 single-mesh / single-draw: DEFERRED-TO-PR. The engine exposes no
// per-frame draw-call counter (no DrawCallCounter resource); a reliable
// distinct-baked-mesh read is also unavailable through the public ECS get
// path in the dawn build. Per w26, AC-09 is verified at PR time by the
// orchestrator reading the screenshot to confirm single-mesh rendering. The
// per-entity single-mesh bake is unit-proven by w19 (glyph-layout-system).
console.log('[smoke] (f) AC-09 single-mesh/single-draw: deferred-to-PR (no engine draw-call counter; unit-proven by w19)');

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
if (REQUIRE_VISIBLE && FALSIFY === '') {
  const textPixels = await countTextPixels().catch(() => -1);
  if (textPixels < 0) {
    failures.push('(g) AC-19: pixel readback failed (copyTextureToBuffer/map error)');
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

console.log(`[smoke] PASS - frames=${totalFrames}, onError=0, textEntities=${textEntities.length}, backend=${app.renderer.inspect().capabilities.backendKind}`);
if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);

// === helpers ================================================================
//
// MUST stay in sync with apps/hello/text/src/text-scenes.ts.

async function registerSharedSampler(assets) {
  const { AssetGuid } = await import('@forgeax/engine-pack/guid');
  const guidParsed = AssetGuid.parse(SAMPLER_GUID);
  if (!guidParsed.ok) throw new Error(`SAMPLER_GUID parse failed: ${guidParsed.error.code}`);
  // D-19: catalog the sampler under its GUID so the FontAsset's samplerGuid
  // resolves via assets.lookup at glyph-layout time. catalog stores payload.
  assets.catalog(guidParsed.value, {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  });
}

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

async function registerBakedFont(world, assets) {
  // Read pre-baked DejaVu Sans Mono atlas + payload from forgeax-engine-assets.
  // The .font.pack.json shape is what loadFontAsset expects (atlasGuid +
  // samplerGuid + glyphs + common); we just need to register the same POD
  // directly through world.allocSharedRef('FontAsset', ...). The atlas PNG is
  // decoded to RGBA via @forgeax/engine-image (loadUpng).
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const fontDir = resolve(repoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
  const atlasPngBytes = readFileSync(resolve(fontDir, 'DejaVuSansMono.atlas.png'));
  const packJson = JSON.parse(readFileSync(resolve(fontDir, 'DejaVuSansMono.font.pack.json'), 'utf8'));

  const { loadUpng } = await import('@forgeax/engine-image');
  const upng = await loadUpng();
  const decoded = upng.decode(atlasPngBytes, { useTArray: true, formatAsRGBA: true });

  // D-19: FontAsset.atlas / .sampler are GUID strings (resolved via
  // assets.lookup at glyph-layout time), so catalog the atlas texture under
  // the pack payload's atlasGuid and reuse the payload's GUID fields directly.
  const fontPayload = packJson.assets[0].payload;
  const { AssetGuid } = await import('@forgeax/engine-pack/guid');
  const atlasGuidParsed = AssetGuid.parse(fontPayload.atlasGuid);
  if (!atlasGuidParsed.ok) throw new Error(`atlasGuid parse failed: ${atlasGuidParsed.error.code}`);
  const samplerGuidParsed = AssetGuid.parse(fontPayload.samplerGuid);
  if (!samplerGuidParsed.ok) throw new Error(`samplerGuid parse failed: ${samplerGuidParsed.error.code}`);
  assets.catalog(atlasGuidParsed.value, {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
    format: 'rgba8unorm',
    data: decoded.data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  });

  return world.allocSharedRef('FontAsset', {
    kind: 'font',
    atlas: atlasGuidParsed.value,
    sampler: samplerGuidParsed.value,
    glyphs: fontPayload.glyphs,
    common: fontPayload.common,
  });
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
