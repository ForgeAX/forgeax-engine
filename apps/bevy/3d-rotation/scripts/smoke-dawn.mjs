#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-3d-rotation headless dawn smoke — reproduces the app's 3d_rotation World
// in node-dawn and asserts a real lit render THAT MOVES: the cube spins about +Y,
// so a frame early in the spin and a frame a quarter-turn later must differ.
//
// Mirrors apps/bevy/3d-shapes/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World + spin math are built by the SHARED src/rotation.ts (imported here
// via Node's TS type-stripping) so this smoke and the browser app render the
// exact same scene + motion — no duplicate-scene drift (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Unlike the static demos, the smoke drives stepSpin(world, dt) between draws to
// advance the rotation deterministically (the app gets dt from createApp's
// frame-loop; here we inject a fixed dt so the two capture points are
// reproducible). Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NDC-center pixel is NOT black — the spinning cube sits at the origin
//       (row center), so a not-black center proves it rendered lit.
//   (d) MOTION: the frame captured near t=0 differs from the frame captured
//       after a quarter-turn of spin (mean per-pixel delta > MOTION_THRESHOLD).
//       A static render (broken Time wiring / rotateAxis no-op / frozen quat)
//       would make the two frames identical → this is the check the static
//       demos structurally could not have.
//   (e) Renderer.onError fired 0 times.
//
// Writes BOTH capture PNGs (artifacts/frame-early.png + frame-late.png) so the
// solo loop reads them with its own eyes and confirms the cube actually turned
// (memory dawn-smoke-loose-threshold-masks-browser-black: a not-black pixel is
// not proof the RIGHT thing rendered — and here, not proof it MOVED).
//
// Output literals (grep-stable): `[bevy-3d-rotation] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] motionMeanDelta=<f>`,
// `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
// Motion floor: the cube is a small fraction of the 320×180 frame, so even a
// clear 45° turn (face-on → corner-on, verified by eye) moves the mean pixel by
// ~2e-3. A static render (broken Time / rotateAxis no-op / stale world matrix)
// is EXACTLY 0. The floor sits an order of magnitude below the observed motion
// and an order above numerical zero, so it decisively separates "spun" from
// "frozen" without flaking on the exact turn amount.
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
// Fixed per-frame dt (seconds). SPIN_SPEED=0.3 rot/s → over CAPTURE_GAP frames
// at this dt the cube turns ~a quarter turn, a clearly different silhouette.
const FIXED_DT = 1 / 60;

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

// --- build the 3d_rotation World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildRotationWorld, stepSpin } = await import(resolve(here, '..', 'src', 'rotation.ts'));

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
console.log(`[bevy-3d-rotation] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildRotationWorld(world);

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

// --- drive the frame loop, capturing an EARLY frame and a LATE frame ---
// The cube spins via stepSpin(world, FIXED_DT) between draws. We capture just
// after the first draw (near t=0) and again after ~an eighth turn (45°).
// NOTE: a cube has 4-fold rotational symmetry about Y — a 90° turn looks
// IDENTICAL. Capturing at 45° (corner-on vs face-on) maximizes the silhouette
// change instead, so the motion check measures real rotation, not a symmetric
// no-op. angle/frame = SPIN_SPEED*TAU*FIXED_DT ≈ 0.0314 rad → 25 frames ≈ 45°.
const CAPTURE_EARLY = 5;
const CAPTURE_LATE = 30; // 25 frames after early ≈ 45° turn (face-on → corner-on)
let framesObserved = 0;
let earlyFrame;
let lateFrame;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) earlyFrame = await capture(sharedDevice);
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
  // Advance the spin, then propagate local Transform → world matrix (the app
  // gets this via createApp's world.update(1 / 60).unwrap() each frame; the direct-draw smoke
  // must call it explicitly or the renderer reads stale world matrices and the
  // cube never moves — memory transform-local-trs-world-mat4-unification +
  // propagate-transforms-never-auto-registered).
  stepSpin(world, FIXED_DT);
  propagateTransforms(world);
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);

if (!earlyFrame || !lateFrame) {
  console.error('[smoke] FAIL - capture frames not taken (renderTarget never allocated?)');
  process.exit(1);
}

// --- pixel samples + motion delta ---
const readRgba = (buf, px, py) => {
  const off = (py * WIDTH + px) * 4;
  return [(buf[off] ?? 0) / 255, (buf[off + 1] ?? 0) / 255, (buf[off + 2] ?? 0) / 255];
};
const ndcCenter = readRgba(lateFrame, Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const corner = readRgba(lateFrame, Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter, corner })}`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

// --- dump both PNGs so the loop eyeballs the rotation + compares to Bevy ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const earlyOut = resolve(outDir, 'frame-early.png');
  const lateOut = resolve(outDir, 'frame-late.png');
  writeFileSync(earlyOut, encodePng(WIDTH, HEIGHT, earlyFrame));
  writeFileSync(lateOut, encodePng(WIDTH, HEIGHT, lateFrame));
  console.log(`[smoke] wrote PNG=${earlyOut}`);
  console.log(`[smoke] wrote PNG=${lateOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const dist = distance(ndcCenter, [0, 0, 0]);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) — lit cube not visible`);
}
if (motionMeanDelta <= MOTION_THRESHOLD) {
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — cube did NOT visibly rotate (Time/rotateAxis wiring broken?)`);
}
if (errors.length > 0) failures.push(`(e) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 5 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${dist.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
