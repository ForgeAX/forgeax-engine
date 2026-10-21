#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-cubic-splines headless dawn smoke — reproduces the app's cubic-splines World in
// node-dawn and asserts a real lit render of the curve PLUS an in-process correctness
// check on the Catmull-Rom sampler itself: the sampled curve must pass through the
// control points and bend smoothly (no straight-segment kinks).
//
// Mirrors apps/bevy/smooth-follow/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World + curve sampler are built by the SHARED src/cubic-splines.ts (imported here
// via Node's TS type-stripping) so this smoke and the browser app render the exact same
// scene — no duplicate-scene drift (memory smoke-script-duplicate-scene-must-stay-in-
// sync-with-main).
//
// This is a STATIC demo (the curve is baked once), so there is no motion criterion —
// instead the smoke adds a CURVE-SHAPE criterion computed in-process from sampleCurve:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NOT-BLACK: the frame's brightest pixel exceeds a floor — the beads + control
//       markers rendered (a shader/camera break would leave an all-black frame).
//   (d) CURVE PASSES THROUGH CONTROL POINTS: the first sample == the first control point
//       and the last sample == the last control point, and every control point has a
//       sample within a small radius (the defining Catmull-Rom interpolation property —
//       a broken sampler / lerp-only fallback would miss the interior control points).
//   (e) CURVE IS SMOOTH: the max turning angle between consecutive sample segments is
//       below a ceiling — a straight-line (lerp) fallback would show sharp kinks at the
//       control points; a correct spline bends gently.
//   (f) Renderer.onError fired 0 times.
//
// Writes the frame PNG (artifacts/smoke-frame.png) so the solo loop reads it with its
// own eyes + compares the curve shape to Bevy's cubic_splines reference.
//
// Output literals (grep-stable): `[bevy-cubic-splines] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] maxThroughDist=<f>`,
// `[smoke] maxTurnDeg=<f>`, `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.15');
// Max distance a control point may be from its nearest curve sample (world units). The
// endpoints are exact; interior control points are sample-density-limited but the curve
// passes through them, so the nearest sample is well within this.
const THROUGH_TOL = Number.parseFloat(process.env.SMOKE_THROUGH_TOL ?? '0.35');
// Max turning angle (degrees) between consecutive curve segments. A correct Catmull-Rom
// through these control points bends gently; a lerp-only fallback kinks ~50-90° at each
// interior control point. The ceiling sits well below such a kink.
const MAX_TURN_DEG = Number.parseFloat(process.env.SMOKE_MAX_TURN_DEG ?? '35');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;

// --- dawn.node binding setup ---
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
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- mock canvas + offscreen render target ---
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

// --- build the cubic-splines World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildCubicSplinesWorld, sampleCurve, CONTROL_POINTS, SAMPLES_PER_SEGMENT } = await import(
  resolve(here, '..', 'src', 'cubic-splines.ts')
);

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-cubic-splines] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildCubicSplinesWorld(world);
propagateTransforms(world);

// --- readback helper (copy renderTarget → mapped buffer → tight RGBA) ---
const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(0x01);
  const raw = new Uint8Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}

// --- render loop (static; just needs N frames + one capture) ---
let framesObserved = 0;
let frame;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === 5) frame = await capture(sharedDevice);
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);
if (!frame) {
  console.error('[smoke] FAIL - capture frame not taken (renderTarget never allocated?)');
  process.exit(1);
}

// --- brightness (not-black) ---
let maxBright = 0;
for (let i = 0; i < frame.length; i += 4) {
  const rr = (frame[i] ?? 0) / 255;
  const g = (frame[i + 1] ?? 0) / 255;
  const b = (frame[i + 2] ?? 0) / 255;
  const m = Math.max(rr, g, b);
  if (m > maxBright) maxBright = m;
}
console.log(`[smoke] maxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

// --- in-process curve-shape check (the Catmull-Rom correctness proof) ---
const samples = sampleCurve(CONTROL_POINTS, SAMPLES_PER_SEGMENT);
const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

// (d) every control point has a sample within THROUGH_TOL.
let maxThroughDist = 0;
for (const cp of CONTROL_POINTS) {
  let nearest = Infinity;
  for (const s of samples) nearest = Math.min(nearest, dist(cp, s));
  maxThroughDist = Math.max(maxThroughDist, nearest);
}
console.log(`[smoke] maxThroughDist=${maxThroughDist.toFixed(4)} (tol ${THROUGH_TOL})`);

// (e) max turning angle between consecutive segments.
let maxTurnDeg = 0;
for (let i = 1; i < samples.length - 1; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  const c = samples[i + 1];
  const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const l1 = Math.hypot(v1[0], v1[1], v1[2]);
  const l2 = Math.hypot(v2[0], v2[1], v2[2]);
  if (l1 < 1e-6 || l2 < 1e-6) continue;
  const cosA = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2)));
  const deg = (Math.acos(cosA) * 180) / Math.PI;
  if (deg > maxTurnDeg) maxTurnDeg = deg;
}
console.log(`[smoke] maxTurnDeg=${maxTurnDeg.toFixed(2)} (ceiling ${MAX_TURN_DEG})`);

// --- dump PNG for the eyeball ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const out = process.env.SMOKE_PNG_OUT ?? resolve(outDir, 'smoke-frame.png');
  writeFileSync(out, encodePng(WIDTH, HEIGHT, frame));
  console.log(`[smoke] wrote PNG=${out}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (maxBright <= SMOKE_BRIGHT_FLOOR) {
  failures.push(`(c) frame brightest pixel ${maxBright.toFixed(4)} <= ${SMOKE_BRIGHT_FLOOR} — nothing lit rendered`);
}
if (!(maxThroughDist <= THROUGH_TOL)) {
  failures.push(`(d) curve misses a control point: maxThroughDist ${maxThroughDist.toFixed(4)} > ${THROUGH_TOL} — catmullRom not interpolating`);
}
if (!(maxTurnDeg <= MAX_TURN_DEG)) {
  failures.push(`(e) curve kinks: maxTurnDeg ${maxTurnDeg.toFixed(2)} > ${MAX_TURN_DEG} — lerp-fallback not a smooth spline`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, maxBright=${maxBright.toFixed(4)}, maxThroughDist=${maxThroughDist.toFixed(4)}, maxTurnDeg=${maxTurnDeg.toFixed(2)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
