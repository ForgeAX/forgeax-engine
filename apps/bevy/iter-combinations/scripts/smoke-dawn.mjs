#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-iter-combinations headless dawn smoke — reproduces the app's N-body World in
// node-dawn and asserts a real lit render THAT MOVES + CLUMPS: a ring of bodies
// attract each other (each unordered pair's force applied once via Query.combinations)
// and fall toward the central star, so (1) frames differ over time (motion) and
// (2) the bodies' spread (max distance from origin) SHRINKS from an early frame to
// a late one (the pairwise gravity actually pulls them together).
//
// Mirrors apps/bevy/smooth-follow/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World + step math are built by the SHARED src/iter-combinations.ts (imported
// here via Node's TS type-stripping) so this smoke and the browser app render the
// exact same scene + motion — no duplicate-scene drift (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// The smoke drives stepInteract(world) then stepIntegrate(world, dt) between draws
// (Bevy's (interact_bodies, integrate)) with a fixed dt so the capture points are
// reproducible. Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NOT-BLACK: the late frame's brightest pixel exceeds a floor — the bodies +
//       lit star rendered (a shader/camera break would leave an all-black frame).
//   (d) MOTION: the early capture differs from the late capture (mean per-pixel
//       delta > MOTION_THRESHOLD) — a static render (broken Time wiring) is identical.
//   (e) CLUMP: the bodies' spread (max distance from origin) at the LATE capture is a
//       clear fraction of its spread at the EARLY capture — the iter_combinations
//       proof: Query.combinations pairwise gravity actually pulls the ring inward. A
//       no-op combinations iterator (or frozen bodies) would keep the spread ~constant.
//   (f) Renderer.onError fired 0 times.
//
// Writes BOTH capture PNGs (artifacts/frame-early.png + frame-late.png) so the solo
// loop reads them with its own eyes and confirms the clump (memory
// dawn-smoke-loose-threshold-masks-browser-black).
//
// Output literals (grep-stable): `[bevy-iter-combinations] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] motionMeanDelta=<f>`,
// `[smoke] earlySpread=<f> lateSpread=<f>`, `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.15');
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
// Clump: the late spread must be at most this fraction of the early spread. Bodies
// start on a radius-6 ring and fall toward the star; by the late capture they have
// collapsed well inward. Floor sits above the settled clump radius and below "did
// not move".
const CLUMP_RATIO = Number.parseFloat(process.env.SMOKE_CLUMP_RATIO ?? '0.8');
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

// --- build the N-body World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildIterCombinationsWorld, stepInteract, stepIntegrate, bodySpread } = await import(
  resolve(here, '..', 'src', 'iter-combinations.ts')
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
console.log(`[bevy-iter-combinations] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildIterCombinationsWorld(world);

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

// --- drive the frame loop, capturing an EARLY frame and a LATE frame + the body
// spread at each. Capture indices are RELATIVE to SMOKE_MIN_FRAMES (CI's smoke-fleet
// runs at 100, local default 300 — a hardcoded index > the CI budget would never fire;
// solo LESSONS L6). CAPTURE_LATE near the end gives maximum clump time.
const CAPTURE_EARLY = 5;
const CAPTURE_LATE = SMOKE_MIN_FRAMES - 5;
let framesObserved = 0;
let earlyFrame;
let lateFrame;
let earlySpread = Number.NaN;
let lateSpread = Number.NaN;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlySpread = bodySpread(world);
  }
  if (i === CAPTURE_LATE) {
    lateFrame = await capture(sharedDevice);
    lateSpread = bodySpread(world);
  }
  // Bevy's (interact_bodies, integrate): accumulate pairwise forces first, then
  // verlet-integrate. Then propagate local Transform → world matrix (the app gets
  // this via createApp's world.update(1 / 60).unwrap(); the direct-draw smoke must call it
  // explicitly or the renderer reads stale world matrices — memory
  // transform-local-trs-world-mat4-unification + propagate-transforms-never-auto-registered).
  stepInteract(world);
  stepIntegrate(world, FIXED_DT);
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

// --- brightness (not-black), motion delta, clump ---
let maxBright = 0;
for (let i = 0; i < lateFrame.length; i += 4) {
  const rr = (lateFrame[i] ?? 0) / 255;
  const g = (lateFrame[i + 1] ?? 0) / 255;
  const b = (lateFrame[i + 2] ?? 0) / 255;
  const m = Math.max(rr, g, b);
  if (m > maxBright) maxBright = m;
}
console.log(`[smoke] lateFrameMaxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

console.log(`[smoke] earlySpread=${earlySpread.toFixed(4)} lateSpread=${lateSpread.toFixed(4)} (ratio ${(lateSpread / earlySpread).toFixed(3)}, must be <= ${CLUMP_RATIO})`);

// --- dump both PNGs so the loop eyeballs the clump + compares to Bevy ---
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
if (!(lateSpread <= earlySpread * CLUMP_RATIO)) {
  failures.push(`(e) bodies did NOT clump: lateSpread ${lateSpread.toFixed(4)} > earlySpread ${earlySpread.toFixed(4)} * ${CLUMP_RATIO} — pairwise gravity broken`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, lateFrameMaxBright=${maxBright.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, clump earlySpread=${earlySpread.toFixed(4)}->lateSpread=${lateSpread.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
