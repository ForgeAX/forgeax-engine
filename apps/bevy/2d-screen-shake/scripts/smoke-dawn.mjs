#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-2d-screen-shake headless dawn smoke — proves Bevy 2d_screen_shake
// behavior: trauma-driven camera shake via 1D Perlin noise, Space to increase
// trauma, automatic decay. Shared scene from src/screen-shake.ts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
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

// --- mock canvas ---
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
  width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
        return renderTarget;
      },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

// --- build ---
const { World } = await import('@forgeax/engine-ecs');
const { Camera } = await import('@forgeax/engine-render');
const { Transform, propagateTransforms } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const { buildScreenShakeWorld, cameraPosition, cameraTrauma, stepScreenShake } = await import(resolve(here, '..', 'src', 'screen-shake.ts'));

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-2d-screen-shake] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildScreenShakeWorld(world);

// --- readback ---
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const buf = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: renderTarget }, { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

// --- drive: press Space at frame 5, and again at SMOKE_MIN_FRAMES-10 so trauma>0 at end ---
// NOISE_SPEED=20, dt=1/60 → t = frame*(20/60) = frame/3. Frames 3,6,9,12... hit integer t.
const SPACE_FRAMES = new Set([5, SMOKE_MIN_FRAMES - 10]);
const CAPTURE_EARLY = 5;
const CAPTURE_LATE = 11;  // frame 10 step used t=3.333, camera is displaced
const CAPTURE_FINAL_POS = 12;  // read position at frame 12 (still mid-shake, trauma ~0.35)
let framesObserved = 0;
let earlyFrame;
let lateFrame;
let earlyPos;
let finalPos;
let elapsed = 0;
let finalTrauma;

function noInputSnapshot() {
  return {
    keyboard: { down: () => false, up: () => true },
    mouse: { movementDelta: { x: 0, y: 0 }, wheelDelta: 0, button: () => false },
    gamepad: { button: () => false, axis: () => 0 },
    timestamp: 0,
  };
}
function spaceSnapshot() {
  return {
    keyboard: { down: (k) => k === ' ', up: (k) => k !== ' ' },
    mouse: { movementDelta: { x: 0, y: 0 }, wheelDelta: 0, button: () => false },
    gamepad: { button: () => false, axis: () => 0 },
    timestamp: 0,
  };
}

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;

  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlyPos = cameraPosition(world);
  }
  if (i === CAPTURE_LATE) {
    lateFrame = await capture(sharedDevice);
  }
  if (i === CAPTURE_FINAL_POS) {
    finalPos = cameraPosition(world);
  }

  const snap = SPACE_FRAMES.has(i) ? spaceSnapshot() : noInputSnapshot();
  stepScreenShake(world, FIXED_DT, elapsed, snap);
  propagateTransforms(world);
  elapsed += FIXED_DT;
}

if (!finalPos) finalPos = cameraPosition(world);
finalTrauma = cameraTrauma(world);

const device = sharedDevice;
if (!device) { console.error('[smoke] FAIL - no shared device'); process.exit(1); }
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);

if (!earlyFrame || !lateFrame) {
  console.error('[smoke] FAIL - capture frames not taken');
  process.exit(1);
}

// --- checks ---
let earlyMaxBright = 0;
for (let i = 0; i < earlyFrame.length; i += 4) earlyMaxBright = Math.max(earlyMaxBright, earlyFrame[i] ?? 0, earlyFrame[i + 1] ?? 0, earlyFrame[i + 2] ?? 0);
console.log(`[smoke] earlyMaxBright=${(earlyMaxBright / 255).toFixed(4)} (floor 0.15)`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

console.log(`[smoke] earlyPos=${JSON.stringify(earlyPos)} finalPos=${JSON.stringify(finalPos)} finalTrauma=${finalTrauma}`);

// --- PNGs ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'frame-early.png'), encodePng(WIDTH, HEIGHT, earlyFrame));
  writeFileSync(resolve(outDir, 'frame-late.png'), encodePng(WIDTH, HEIGHT, lateFrame));
  console.log(`[smoke] wrote PNGs to ${outDir}`);
} catch (err) { console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`); }

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (earlyMaxBright / 255 <= 0.15) failures.push(`(c) earlyMaxBright ${(earlyMaxBright / 255).toFixed(4)} <= 0.15`);
if (motionMeanDelta <= MOTION_THRESHOLD) failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD}`);
// Shake should displace the camera: early and late positions should differ (noise displacement).
const posChanged = earlyPos !== undefined && finalPos !== undefined &&
  (Math.abs((earlyPos[0] ?? 0) - (finalPos[0] ?? 0)) > 1e-3 ||
   Math.abs((earlyPos[1] ?? 0) - (finalPos[1] ?? 0)) > 1e-3);
if (!posChanged) failures.push(`(e) camera position did not change: early=${JSON.stringify(earlyPos)} final=${JSON.stringify(finalPos)}`);
// Trauma should be > 0 at the end (Space was pressed, decay hasn't erased it).
if (finalTrauma === undefined || finalTrauma <= 0) failures.push(`(f) finalTrauma=${finalTrauma} <= 0`);
if (errors.length > 0) failures.push(`(g) RhiError ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 7 criteria GREEN: backend=webgpu, frames=${framesObserved}, earlyMaxBright=${(earlyMaxBright / 255).toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, position-changed OK, trauma>0, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);