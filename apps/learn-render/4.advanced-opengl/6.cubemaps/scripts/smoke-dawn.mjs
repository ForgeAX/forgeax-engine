#!/usr/bin/env node
// apps/learn-render/4.advanced-opengl/6.cubemaps/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 4.advanced-opengl 6.cubemaps dawn-node smoke.
//
// Strategy (dual-state skybox-on vs skybox-off pixel diff, fxaa two-World pattern):
//   1. Inject globalThis.navigator.gpu via `webgpu` npm package (dawn-node).
//   2. Mock canvas + offscreen render target (bgra8unorm storage).
//   3. Decode real newport_loft.hdr from vendor submodule, build the equirect
//      POD; the equirect->cubemap projection is internal to the engine record arm.
//   4. Two Worlds share the same renderer/device/renderTarget:
//        - World-A (skybox-on):  Skylight + SkyboxBackground(SKYBOX_MODE_CUBEMAP)
//          + reflective cube (metallic=1, roughness=0) + non-reflective cube
//          (metallic=0) + DirectionalLight + Camera(tonemap).
//        - World-B (skybox-off): SAME scene minus SkyboxBackground spawn
//          (plan D-1 minimal delta -- every other field byte-identical).
//   5. Each World renders N>=60 frames, then readback via copyTextureToBuffer.
//   6. Diff: per-pixel byte comparison (4 bytes = 1 pixel). Any channel
//      difference counts as 1 diff pixel. Assert diffCount > threshold
//      (0.05% = 131 for 512x512) AND both states have 0 RhiError.
//   7. No reference PNG reads/writes (AC-03 dual-state, not single-state
//      baseline anti-pattern per memory-lesson comparison-demo-exposes-frozen-
//      fxaa-shader).
//   8. FALSIFY=skybox-reuse-buffer: inject branch where skybox-off state
//      reuses skybox-on readback buffer (byte-identical) -- asserts smoke
//      FAIL, proving sensitivity to the skybox variable (local-only, not CI).
//
// Output literals (preserved for grep tooling):
//   `[learn-render-6-cubemaps] backend=webgpu`
//   `[smoke] dualPassDiff={"diffCount":<N>,"threshold":<N>,"totalPixels":<N>,"pct":<N>}`
//   `[smoke] PASS`
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual diffCount vs threshold so AI users can self-diagnose.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;
const TOTAL_PIXELS = WIDTH * HEIGHT;
const CLEAR_RGBA = [0.1, 0.1, 0.1, 1.0];
// 0.05% of total pixels. floor(512*512*0.0005) = 131.
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.0005);

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const HDR_PATH = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets', 'learn-opengl', 'textures', 'newport_loft.hdr',
);
const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

const FALSIFY = process.env.FALSIFY ?? '';

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps' smoke",
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
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

// --- 3. Asset fixture check ---

if (!existsSync(HDR_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${HDR_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets must be checked out)',
  );
  process.exit(1);
}

// --- 4. Engine imports + renderer bootstrap ---

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { SkyboxBackground, Skylight } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, TONEMAP_REINHARD_EXTENDED } = await import('@forgeax/engine-render');
const { SKYBOX_MODE_CUBEMAP } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
const { decodeHdr } = await import('@forgeax/engine-image/hdr-decoder');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

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
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[learn-render-6-cubemaps] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// --- 5. Load real newport_loft.hdr + upload cubemap ---

let hdrBytes;
try {
  const buf = await readFile(HDR_PATH);
  hdrBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
} catch (err) {
  console.error(
    `[smoke] FAIL - newport_loft.hdr unreadable: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
const hdrRes = decodeHdr(hdrBytes);
if (!hdrRes.ok) {
  console.error(`[smoke] FAIL - decodeHdr: ${hdrRes.error.code} - ${hdrRes.error.hint}`);
  process.exit(1);
}
const hdr = hdrRes.value;
console.log(`[learn-render-6-cubemaps] decoded HDR ${hdr.width}x${hdr.height}`);

const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
if (!guidRes.ok) {
  console.error(`[smoke] FAIL - GUID parse: ${guidRes.error.code}`);
  process.exit(1);
}
const floatBytes = new Uint8Array(hdr.data.buffer, hdr.data.byteOffset, hdr.data.byteLength);
const equirectPod = {
  kind: 'equirect',
  width: hdr.width,
  height: hdr.height,
  format: 'rgba32float',
  data: floatBytes,
  colorSpace: 'linear',
};
// --- 6. Material descriptors (minted per-world inside spawnScene) ---
// Handles are minted via world.allocSharedRef (M8 D-19), so each of the two
// dual-state Worlds gets its own column handles for the equirect cubemap and
// the two PBR materials. The descriptor payloads below are shared inputs.

const reflectiveMatPayload = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.8, 0.8, 0.8, 1.0],
    metallic: 1.0,
    roughness: 0.0,
  },
};

const nonReflectiveMatPayload = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.8, 0.8, 0.8, 1.0],
    metallic: 0.0,
    roughness: 0.5,
  },
};

// --- 7. Scene spawn helper ---

/**
 * Build a cubemaps scene in `world`. The `spawnSkybox` flag is the ONLY
 * variable between the two states (plan D-1 minimal delta).
 *
 * Scene layout:
 *   - Skylight (always spawned -- needed for PBR IBL diffuse+specular)
 *   - SkyboxBackground (only when spawnSkybox=true -- the test variable)
 *   - Reflective cube (metallic=1, roughness=0) at x=-1.5
 *   - Non-reflective cube (metallic=0) at x=+1.5
 *   - DirectionalLight
 *   - Camera at pos z=6, tonemap=REINHARD_EXTENDED
 */
async function spawnScene(world, spawnSkybox) {
  // Mint this world's column handles (M8 D-19): equirect source + two PBR
  // materials. The equirect->cubemap + IBL projection is INTERNAL to the engine
  // (lazy, in the render record arm) -- the Skylight holds the equirect handle.
  const equirect = world.allocSharedRef('EquirectAsset', equirectPod);
  const reflectiveMatHandle = world.allocSharedRef('MaterialAsset', reflectiveMatPayload);
  const nonReflectiveMatHandle = world.allocSharedRef('MaterialAsset', nonReflectiveMatPayload);

  world.spawn({
    component: Skylight,
    data: { equirect, intensity: 1.0 },
  });

  if (spawnSkybox) {
    world.spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    });
  }

  // Reflective cube (metallic=1, roughness=0) at left.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-1.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [reflectiveMatHandle] } },
  );

  // Non-reflective cube (metallic=0) at right.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [1.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [nonReflectiveMatHandle] } },
  );

  // DirectionalLight.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  });

  // Camera with HDR tonemap (skybox requires HDR target).
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 6]},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 3,
        aspect: WIDTH / HEIGHT,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_REINHARD_EXTENDED,
        clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
      },
    },
  );
}

// --- 8. Readback helper ---

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function readbackPixels(device) {
  if (!renderTarget) throw new Error('renderTarget never allocated');
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(0x01);
  const mapped = buf.getMappedRange();
  const raw = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();

  // BGRA -> RGBA repack + pad removal.
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tight[dst + 0] = raw[off + 0] ?? 0;
      tight[dst + 1] = raw[off + 1] ?? 0;
      tight[dst + 2] = raw[off + 2] ?? 0;
      tight[dst + 3] = raw[off + 3] ?? 0;
    }
  }
  return tight;
}

// --- 9. Draw frames helper ---

async function drawFrames(world, frames, label) {
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const lease = attachment.value;
  let framesObserved = 0;
  let drawFailures = 0;
  for (let i = 0; i < frames; i++) {
    world.update(1 / 60).unwrap();
    const r = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!r.ok) {
      drawFailures++;
      errors.push({ code: r.error.code, hint: r.error.hint, label, frame: i });
      continue;
    }
    const completed = await r.value.completed;
    if (!completed.ok) {
      drawFailures++;
      errors.push({ code: completed.error.code, hint: completed.error.hint, label, frame: i });
      continue;
    }
    framesObserved++;
  }
  await sharedDevice.queue.onSubmittedWorkDone();
  return { framesObserved, drawFailures };
}

// --- 10. Dual-state render ---

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// State A: skybox-on (full IBL skybox + Skylight + two cubes)
const worldOn = new World();
await spawnScene(worldOn, true);
const onFrames = await drawFrames(worldOn, SMOKE_MIN_FRAMES, 'skybox-on');
const pixelsOn = await readbackPixels(device);

// FALSIFY injection: if FALSIFY=skybox-reuse-buffer, force skybox-off to
// reuse the on-state buffer (making the two states byte-identical). This
// should cause the diff assertion to FAIL, proving sensitivity.
let pixelsOff;
let offFrames = { framesObserved: 0, drawFailures: 0 };
if (FALSIFY === 'skybox-reuse-buffer') {
  console.warn('[smoke] FALSIFY=skybox-reuse-buffer active: reusing skybox-on buffer for skybox-off');
  pixelsOff = pixelsOn;
} else {
  // State B: skybox-off (same scene, no SkyboxBackground).
  // Recreate renderTarget so the second render starts fresh.
  // (The renderer writes to getCurrentTexture() which returns renderTarget.)
  // We need a fresh draw: destroy old renderTarget so configure creates a new one.
  renderTarget = null;
  const worldOff = new World();
  await spawnScene(worldOff, false);
  offFrames = await drawFrames(worldOff, SMOKE_MIN_FRAMES, 'skybox-off');
  pixelsOff = await readbackPixels(device);
}

// --- 11. Verdict ---

const failures = [];

if (onFrames.framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(
    `(a) skybox-on completed frames=${onFrames.framesObserved} < ${SMOKE_MIN_FRAMES}`,
  );
}
if (FALSIFY !== 'skybox-reuse-buffer' && offFrames.framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(
    `(a) skybox-off completed frames=${offFrames.framesObserved} < ${SMOKE_MIN_FRAMES}`,
  );
}
if (onFrames.drawFailures > 0 || offFrames.drawFailures > 0) {
  failures.push(
    `(b) draw completion failures: skybox-on=${onFrames.drawFailures}, skybox-off=${offFrames.drawFailures}`,
  );
}

// (c) Backend must be webgpu.
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}

// (d) Both passes must produce valid buffers.
if (pixelsOn.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) skybox-on pixel buffer size mismatch: ${pixelsOn.length} != ${TOTAL_PIXELS * 4}`);
}
if (pixelsOff.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) skybox-off pixel buffer size mismatch: ${pixelsOff.length} != ${TOTAL_PIXELS * 4}`);
}

// (e) RhiError must be zero for both states.
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (f) Both passes must be non-black (geometries rendered).
let nonBlackOn = 0;
for (let i = 0; i < pixelsOn.length; i += 4) {
  if (pixelsOn[i] !== 0 || pixelsOn[i + 1] !== 0 || pixelsOn[i + 2] !== 0) {
    nonBlackOn++;
  }
}
if (nonBlackOn === 0) {
  failures.push('(d) skybox-on frame is completely black (geometries not rendered)');
}

let nonBlackOff = 0;
for (let i = 0; i < pixelsOff.length; i += 4) {
  if (pixelsOff[i] !== 0 || pixelsOff[i + 1] !== 0 || pixelsOff[i + 2] !== 0) {
    nonBlackOff++;
  }
}
if (nonBlackOff === 0) {
  failures.push('(d) skybox-off frame is completely black (geometries not rendered)');
}

// (g) Dual-state pixel diff: count pixels where any channel differs.
// If FALSIFY=skybox-reuse-buffer is active, buffers are identical and
// this assertion MUST fail (proving sensitivity).
let diffCount = 0;
for (let i = 0; i < pixelsOn.length; i += 4) {
  if (
    pixelsOn[i] !== pixelsOff[i] ||
    pixelsOn[i + 1] !== pixelsOff[i + 1] ||
    pixelsOn[i + 2] !== pixelsOff[i + 2] ||
    pixelsOn[i + 3] !== pixelsOff[i + 3]
  ) {
    diffCount++;
  }
}

const diffPct = ((diffCount / TOTAL_PIXELS) * 100).toFixed(4);
console.log(
  `[smoke] dualPassDiff=${JSON.stringify({
    diffCount,
    threshold: DIFF_THRESHOLD,
    totalPixels: TOTAL_PIXELS,
    pct: diffPct,
    nonBlackOn,
    nonBlackOff,
    falsify: FALSIFY || 'none',
  })}`,
);

if (FALSIFY === 'skybox-reuse-buffer') {
  // FALSIFY mode: diff MUST be zero (byte-identical buffers) -> smoke FAILS.
  if (diffCount > 0) {
    console.error(
      `[smoke] FAIL (FALSIFY) - expected 0 diff (byte-identical buffers), got ${diffCount} diff pixels. ` +
        'The FALSIFY=skybox-reuse-buffer injection was supposed to make buffers identical; ' +
        'check that the reuse-buffer branch is active.',
    );
    device.destroy?.();
    process.exit(1);
  }
  console.error(
    `[smoke] FAIL (FALSIFY) - skybox-reuse-buffer: diffCount=${diffCount} <= threshold=${DIFF_THRESHOLD} ` +
      `(${diffPct}%). FALSIFY injection WORKS -- the smoke IS sensitive to the skybox variable.`,
  );
  device.destroy?.();
  process.exit(1);
}

if (diffCount <= DIFF_THRESHOLD) {
  failures.push(
    `(e) dual-state pixel diff ${diffCount} <= threshold ${DIFF_THRESHOLD} (${diffPct}%)` +
      ' -- skybox may not be visible or pixel difference below detection threshold' +
      ' (charter P3: check Skylight + SkyboxBackground spawn, equirect handle binding, camera tonemap)',
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, frames=${Math.min(onFrames.framesObserved, offFrames.framesObserved)}, ` +
    `RhiError count=${errors.length}, nonBlackOn=${nonBlackOn}, nonBlackOff=${nonBlackOff}, ` +
    `dualPassDiff=${diffCount} > threshold=${DIFF_THRESHOLD} (${diffPct}%)`,
);

emitSmokeReceipt(
  'app-learn-render-4-advanced-opengl-6-cubemaps/smoke',
  Math.min(onFrames.framesObserved, offFrames.framesObserved),
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
