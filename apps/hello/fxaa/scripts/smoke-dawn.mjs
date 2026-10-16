#!/usr/bin/env node
// hello-fxaa headless smoke (feat-20260529-fxaa-demo-real-antialiasing-comparison-runtime-tog / M3 / w10).
//
// Strategy (dual-pass none-vs-fxaa pixel diff):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Spawn a static 4-geometry scene (triangle + cube + quad + sphere) +
//      DirectionalLight + Camera -- same layout as demo main.ts (PI-3).
//      All geometries are stationary (D-5), no rotation animation.
//   4. Two Worlds share the same renderer/device/renderTarget (RD-6):
//        - World-A: Camera.antialias = ANTIALIAS_NONE (baseline)
//        - World-B: Camera.antialias = ANTIALIAS_FXAA (FXAA active)
//      Each World renders, then pixels are read back via copyTextureToBuffer.
//      The renderTarget is reused across passes (test paradigm from
//      fxaa-pixel-diff.dawn.test.ts:181-208).
//   5. Diff: per-pixel byte comparison (4 bytes = 1 pixel). Any channel
//      difference counts as 1 diff pixel. Assert diffCount > 0.1% of total
//      pixels (800x600x0.001 = 480).
//   6. Both passes must be non-black individually (nonBlackCount > 0).
//   7. No reference PNG reads/writes (AC-09/AC-10). No PNG ever lands in the
//      engine repo worktree. No writeFileSync / existsSync that touches disk.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-fxaa] backend=webgpu`
//   - `[smoke] dualPassDiff={"diffCount":<N>,"threshold":<N>,"totalPixels":<N>,"pct":<N>}`
//   - `[smoke] PASS`
//
// Charter P3 explicit failure: on fail, output structured diagnostic with actual
// diffCount vs threshold so AI users can self-diagnose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import {
  DARK_GRADIENT_FIXTURE,
  DARK_GRADIENT_RESOLUTION,
  createDarkGradientFixtureReport,
} from './dark-gradient-fixture.mjs';
import { createDarkGradientTexture, darkGradientQuad } from './dark-gradient-scene.mjs';

const WIDTH = DARK_GRADIENT_RESOLUTION.width;
const HEIGHT = DARK_GRADIENT_RESOLUTION.height;
const CLEAR_RGBA = DARK_GRADIENT_FIXTURE.scene.clearColor;
const TOTAL_PIXELS = WIDTH * HEIGHT;
// AC-08: >0.1% of total pixels. floor(800*600*0.001) = 480.
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.001);
const VALIDATION_FRAME_COUNT = smokeFrameBudget();
const lane = process.env.FORGEAX_DARK_GRADIENT_LANE ?? 'direct';
if (lane !== 'direct' && lane !== 'clustered') {
  console.error(`[smoke] FAIL - unsupported dark-gradient lane=${lane}`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node setup ----------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-fxaa smoke');
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
    return dev;
  };
  return adapter;
};

// --- 2. Mock canvas with offscreen render target --------------------------

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
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

// --- 3. Engine imports + renderer bootstrap ---------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const {
  ANTIALIAS_NONE,
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  ShadowParticipation,
  TONEMAP_LINEAR,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: MANIFEST_URL },
  );
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-fxaa] backend=${renderer.inspect().capabilities.backendKind}`);
console.log(`[dark-gradient] fixture=${DARK_GRADIENT_FIXTURE.id} lane=${lane}`);

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 4. Scene spawn helper ---------------------------------------------------

/**
 * Spawn the dedicated dark-gradient scene into `world` with the given `antialias` value
 * for the Camera. Returns immediately; the caller is responsible for
 * registering components on the World before calling this.
 */
function spawnScene(world, antialias) {
  const gradientTexture = world.allocSharedRef('TextureAsset', createDarkGradientTexture());
  const gradientMaterial = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [1, 1, 1, 1],
    baseColorTexture: gradientTexture,
    metallic: 0,
    roughness: 1,
    renderState: { cullMode: 'none' },
  }));
  const gradientQuad = darkGradientQuad();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: gradientQuad.position,
        scale: gradientQuad.scale,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [gradientMaterial] } },
    { component: ShadowParticipation, data: { cast: false, receive: true } },
  );

  // Directional light.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: DARK_GRADIENT_FIXTURE.scene.lightDirection,
      color: [1, 1, 1],
      intensity: DARK_GRADIENT_FIXTURE.scene.lightIntensity,
    },
  });

  // Camera.
  world.spawn(
    {
      component: Transform,
      data: { pos: DARK_GRADIENT_FIXTURE.camera.position},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: DARK_GRADIENT_FIXTURE.camera.fovRadians, aspect: DARK_GRADIENT_FIXTURE.camera.aspect }),
        tonemap: TONEMAP_LINEAR,
        antialias,
      },
    },
  );
}

// --- 5. readback helper -----------------------------------------------------

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

/**
 * Copy the current `renderTarget` content into a tightly-packed Uint8Array
 * (RGBA, row-major, no padding). Performs BGRA-to-RGBA channel swap.
 * Mirrors the readback logic in the original smoke-dawn.mjs :269-305.
 */
async function doReadPixels() {
  if (!renderTarget) throw new Error('renderTarget never allocated');
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
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
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

// --- 6. Error tracker -----------------------------------------------------

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

// --- 7. Dual-pass render ---------------------------------------------------

async function renderAndRead(world, lease) {
  world.update().unwrap();
  const drawResult = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  if (!drawResult.ok) throw drawResult.error;
  (await drawResult.value.completed).unwrap();
  await device.queue.onSubmittedWorkDone();
  return doReadPixels();
}

// Pass 1: ANTIALIAS_NONE baseline.
const worldNone = new World();
const worldAttachment1 = renderer.attach(worldNone);
if (!worldAttachment1.ok) throw worldAttachment1.error;
spawnScene(worldNone, ANTIALIAS_NONE);
let pixelsNone;
let framesNone = 0;
for (let frame = 0; frame < VALIDATION_FRAME_COUNT; frame += 1) {
  try {
    pixelsNone = await renderAndRead(worldNone, worldAttachment1.value);
    framesNone += 1;
  } catch (error) {
    console.error(
      `[smoke] FAIL - draw (none) frame=${frame + 1}/${VALIDATION_FRAME_COUNT} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
const noneInspection = renderer.inspect();

// Pass 2: ANTIALIAS_FXAA -- reuses the same renderer / device / renderTarget.
// The second draw overwrites the renderTarget in place (same paradigm as
// fxaa-pixel-diff.dawn.test.ts:192-198). No state contamination between passes
// because each World is independent; the renderer's internal state (BGLs,
// pipelines, per-frame resources) is rebuilt from ECS data on each draw call.

const worldFxaa = new World();
const worldAttachment2 = renderer.attach(worldFxaa);
if (!worldAttachment2.ok) throw worldAttachment2.error;
spawnScene(worldFxaa, ANTIALIAS_FXAA);
let pixelsFxaa;
let framesFxaa = 0;
for (let frame = 0; frame < VALIDATION_FRAME_COUNT; frame += 1) {
  try {
    pixelsFxaa = await renderAndRead(worldFxaa, worldAttachment2.value);
    framesFxaa += 1;
  } catch (error) {
    console.error(
      `[smoke] FAIL - draw (fxaa) frame=${frame + 1}/${VALIDATION_FRAME_COUNT} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
console.log(`[smoke] frames observed=${Math.min(framesNone, framesFxaa)}`);
const fxaaInspection = renderer.inspect();

// --- 8. Verdict ------------------------------------------------------------

const failures = [];

// (a) Backend must be webgpu.
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}

// (b) Both passes must produce valid buffers.
if (pixelsNone.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) none pass pixel buffer size mismatch: ${pixelsNone.length} != ${TOTAL_PIXELS * 4}`);
}
if (pixelsFxaa.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) fxaa pass pixel buffer size mismatch: ${pixelsFxaa.length} != ${TOTAL_PIXELS * 4}`);
}

// (c) RhiError must be zero.
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (d) Both passes must be non-black (geometries rendered).
let nonBlackNone = 0;
for (let i = 0; i < pixelsNone.length; i += 4) {
  if (pixelsNone[i] !== 0 || pixelsNone[i + 1] !== 0 || pixelsNone[i + 2] !== 0) {
    nonBlackNone++;
  }
}
if (nonBlackNone === 0) {
  failures.push('(d) none pass frame is completely black (geometries not rendered)');
}

let nonBlackFxaa = 0;
for (let i = 0; i < pixelsFxaa.length; i += 4) {
  if (pixelsFxaa[i] !== 0 || pixelsFxaa[i + 1] !== 0 || pixelsFxaa[i + 2] !== 0) {
    nonBlackFxaa++;
  }
}
if (nonBlackFxaa === 0) {
  failures.push('(d) fxaa pass frame is completely black (geometries not rendered)');
}

// (e) Dual-pass pixel diff: count pixels (not bytes) where any channel differs.
// AC-08: diffCount > totalPixels * 0.001 (~480 for 800x600).
// Charter P3: output structured diagnostic on failure.
let diffCount = 0;
for (let i = 0; i < pixelsNone.length; i += 4) {
  if (
    pixelsNone[i] !== pixelsFxaa[i] ||
    pixelsNone[i + 1] !== pixelsFxaa[i + 1] ||
    pixelsNone[i + 2] !== pixelsFxaa[i + 2] ||
    pixelsNone[i + 3] !== pixelsFxaa[i + 3]
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
    nonBlackNone,
    nonBlackFxaa,
    validationFrames: Math.min(framesNone, framesFxaa),
    framesNone,
    framesFxaa,
    validationErrors: errors.length,
  })}`,
);

if (diffCount <= DIFF_THRESHOLD) {
  failures.push(
    `(e) dual-pass pixel diff ${diffCount} <= threshold ${DIFF_THRESHOLD} (${diffPct}%)` +
      ` -- FXAA may not be active or scene edges insufficient` +
      ` (charter P3: check FXAA pipeline, camera antialias value, scene geometry edges)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

const inspection = renderer.inspect();
const observationIdentity = (inspection) => ({
  observationId: inspection.observation.observationId,
  frameId: inspection.observation.frameId,
  rendererInspectionRef: `${inspection.observation.observationId}:frame-${inspection.observation.frameId}`,
  ...(inspection.observation.antialias === undefined ? {} : { antialias: inspection.observation.antialias }),
  ...(inspection.observation.surfaceProfile === undefined ? {} : { surfaceProfile: inspection.observation.surfaceProfile }),
  rgba16floatRenderable: inspection.observation.rgba16floatRenderable === true,
  passNames: inspection.observation.passNames ?? [],
  ...(inspection.observation.standardOutputColor === undefined
    ? {}
    : { standardOutputColor: inspection.observation.standardOutputColor }),
});
const fixtureReport = createDarkGradientFixtureReport({
  backendId: 'dawn',
  lane,
  bytes: pixelsFxaa,
  referenceBytes: pixelsNone,
  surface: {
    storageFormat: inspection.output.surfaceStorage,
    displayFormat: inspection.output.surfaceDisplay,
    intermediateFormat: fxaaInspection.output.intermediateFormat ?? '',
    domain: fxaaInspection.output.displayEncoded ? 'display-encoded' : 'linear',
    endpoint: fxaaInspection.output.endpoint,
  },
  presentationProof: fxaaInspection.output.presentationProof,
  identity: observationIdentity(fxaaInspection),
  referenceIdentity: observationIdentity(noneInspection),
  sampleFrameCount: Math.min(framesNone, framesFxaa),
});
console.log(`[dark-gradient] report=${JSON.stringify(fixtureReport)}`);

if (fixtureReport.status !== 'complete') {
  console.error(
    `[smoke] FAIL - dark-gradient fixture report is ${fixtureReport.status}; ` +
      'the real readback did not satisfy the frozen ROI and scanline thresholds',
  );
  device.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(2);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, lane=${lane}, RhiError count=${errors.length}, ` +
    `nonBlackNone=${nonBlackNone}, nonBlackFxaa=${nonBlackFxaa}, ` +
    `dualPassDiff=${diffCount} > threshold=${DIFF_THRESHOLD} (${diffPct}%)`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
