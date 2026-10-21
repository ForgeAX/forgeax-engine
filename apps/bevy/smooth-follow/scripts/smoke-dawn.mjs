#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-smooth-follow headless dawn smoke — reproduces the app's smooth-follow World
// in node-dawn and asserts a real lit render THAT MOVES + CONVERGES: a red follower
// sphere smooth-damps toward a moving blue target sphere, so (1) frames differ over
// time (motion) and (2) the follower's distance to the target SHRINKS from an early
// frame to a late one (the smoothDamp chase actually closes the gap).
//
// Mirrors apps/bevy/translation/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World + step math are built by the SHARED src/smooth-follow.ts (imported here
// via Node's TS type-stripping) so this smoke and the browser app render the exact
// same scene + motion — no duplicate-scene drift (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// The smoke drives stepTarget(world, dt) then stepFollower(world, dt) between draws
// (Bevy's chained (move_target, move_follower)) with a fixed dt so the capture points
// are reproducible. Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NOT-BLACK: the late frame's brightest pixel exceeds a floor — the spheres +
//       lit plane rendered (a shader/camera break would leave an all-black frame).
//   (d) MOTION: the early capture differs from the late capture (mean per-pixel delta
//       > MOTION_THRESHOLD) — a static render (broken Time wiring) would be identical.
//   (e) CONVERGENCE: the follower's distance-to-target at the LATE capture is a clear
//       fraction of its distance at the EARLY capture — this is the smooth_follow
//       proof: vec3.smoothDamp actually pulls the follower toward the target. A no-op
//       smoothDamp (or a frozen follower) would keep the distance ~constant.
//   (f) Renderer.onError fired 0 times.
//
// Writes BOTH capture PNGs (artifacts/frame-early.png + frame-late.png) so the solo
// loop reads them with its own eyes and confirms the follower caught up (memory
// dawn-smoke-loose-threshold-masks-browser-black).
//
// Output literals (grep-stable): `[bevy-smooth-follow] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] motionMeanDelta=<f>`,
// `[smoke] earlyDist=<f> lateDist=<f>`, `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
// Not-black floor: the brightest pixel in a lit render is well above this; an all-black
// (broken shader/camera) frame is exactly 0.
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.15');
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
// Convergence: the late follower-target distance must be at most this fraction of the
// early one. The follower starts a full TARGET_RADIUS from the target and damps in;
// even accounting for the target's continued orbit, it closes the gap to well under
// half. The floor sits comfortably above the steady-state lag and below "did not move".
const CONVERGE_RATIO = Number.parseFloat(process.env.SMOKE_CONVERGE_RATIO ?? '0.6');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
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

// --- build the smooth-follow World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildSmoothFollowWorld, stepTarget, stepFollower, followerDistanceSq } = await import(
  resolve(here, '..', 'src', 'smooth-follow.ts')
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
console.log(`[bevy-smooth-follow] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildSmoothFollowWorld(world);

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

// --- drive the frame loop, capturing an EARLY frame and a LATE frame + the
// follower-target distance at each. The follower starts a full TARGET_RADIUS from
// the target and smooth-damps in; by the late capture it is tracking the target,
// so the distance has shrunk sharply.
const CAPTURE_EARLY = 5;
// Late capture near the end of the run so the follower has had maximum damping time.
// MUST be relative to SMOKE_MIN_FRAMES (not a hardcoded 250) — CI's smoke-fleet runs at
// SMOKE_MIN_FRAMES=100, and a fixed 250 > 100 would never fire, leaving lateFrame unset
// (the CI-only bug that a local default of 60 masked). At 100 frames this is frame 95 ≈
// 1.58 s of damping at decay=2 (>3 time constants), still a robust convergence margin.
const CAPTURE_LATE = SMOKE_MIN_FRAMES - 5;
let framesObserved = 0;
let earlyFrame;
let lateFrame;
let earlyDist = Number.NaN;
let lateDist = Number.NaN;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlyDist = Math.sqrt(followerDistanceSq(world));
  }
  if (i === CAPTURE_LATE) {
    lateFrame = await capture(sharedDevice);
    lateDist = Math.sqrt(followerDistanceSq(world));
  }
  // Bevy's chained (move_target, move_follower): target moves first, then the
  // follower damps toward its NEW position. Then propagate local Transform → world
  // matrix (the app gets this via createApp's world.update(1 / 60).unwrap(); the direct-draw smoke
  // must call it explicitly or the renderer reads stale world matrices — memory
  // transform-local-trs-world-mat4-unification + propagate-transforms-never-auto-registered).
  stepTarget(world, FIXED_DT);
  stepFollower(world, FIXED_DT);
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

// --- brightness (not-black), motion delta, convergence ---
let maxBright = 0;
for (let i = 0; i < lateFrame.length; i += 4) {
  const r = (lateFrame[i] ?? 0) / 255;
  const g = (lateFrame[i + 1] ?? 0) / 255;
  const b = (lateFrame[i + 2] ?? 0) / 255;
  const m = Math.max(r, g, b);
  if (m > maxBright) maxBright = m;
}
console.log(`[smoke] lateFrameMaxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

console.log(`[smoke] earlyDist=${earlyDist.toFixed(4)} lateDist=${lateDist.toFixed(4)} (ratio ${(lateDist / earlyDist).toFixed(3)}, must be <= ${CONVERGE_RATIO})`);

// --- dump both PNGs so the loop eyeballs the chase + compares to Bevy ---
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

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (maxBright <= SMOKE_BRIGHT_FLOOR) {
  failures.push(`(c) late frame brightest pixel ${maxBright.toFixed(4)} <= ${SMOKE_BRIGHT_FLOOR} — nothing lit rendered`);
}
if (motionMeanDelta <= MOTION_THRESHOLD) {
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — scene did NOT visibly move (Time wiring broken?)`);
}
if (!(lateDist <= earlyDist * CONVERGE_RATIO)) {
  failures.push(`(e) follower did NOT converge: lateDist ${lateDist.toFixed(4)} > earlyDist ${earlyDist.toFixed(4)} * ${CONVERGE_RATIO} — smoothDamp chase broken`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, lateFrameMaxBright=${maxBright.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, converge earlyDist=${earlyDist.toFixed(4)}->lateDist=${lateDist.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
