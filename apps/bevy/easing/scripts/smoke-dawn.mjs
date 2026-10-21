#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-easing headless dawn smoke — reproduces the app's easing World in node-dawn and asserts
// (1) the scene renders + moves and (2) the eased cube's motion is genuinely smoothstep-eased:
// at a normalized time u, the eased cube's x equals easedX(u) = lerp(x0,x1,smoothstep(u)) while
// the linear cube's x equals linearX(u), and the two DIFFER at the quarter points (the ease
// proof — a linear fallback would make them identical). The smoke drives stepEasing(world, u)
// itself with a swept u so it is deterministic.
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NOT-BLACK: the frame's brightest pixel exceeds a floor (cubes rendered).
//   (d) MOTION: an early capture differs from a late capture (cubes moved).
//   (e) EASED: at u=0.25 the eased cube's x < the linear cube's x, and at u=0.75 it's >
//       (smoothstep's slow-in/slow-out S-shape), each matching the closed-form within EPS.
//   (f) Renderer.onError fired 0 times.
//
// Writes BOTH capture PNGs (artifacts/frame-early.png + frame-late.png) for the eyeball.
//
// Output literals (grep-stable): `[bevy-easing] backend=webgpu`, `[smoke] frames observed=<N>`,
// `[smoke] motionMeanDelta=<f>`, `[smoke] easeCheck=<json>`, `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.15');
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const X_EPS = Number.parseFloat(process.env.SMOKE_X_EPS ?? '1e-4');
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

// --- build the easing World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms, Transform } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildEasingWorld, stepEasing, linearX, easedX, Mover } = await import(
  resolve(here, '..', 'src', 'easing-demo.ts')
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
console.log(`[bevy-easing] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildEasingWorld(world);

// --- read the two movers' x by mode (0=linear, 1=eased) ---
function moverXs() {
  const query = world.query({ read: [Transform, Mover] }).unwrap();
  const out = { linear: Number.NaN, eased: Number.NaN };
  for (const row of query) {
    const position = row.get(Transform).pos[0] ?? 0;
    if (row.get(Mover).mode === 1) out.eased = position;
    else out.linear = position;
  }
  return out;
}

// --- readback helper ---
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

// --- ease-correctness probe: place at u=0.25 and u=0.75, read x, compare to closed-form ---
stepEasing(world, 0.25);
const at25 = moverXs();
stepEasing(world, 0.75);
const at75 = moverXs();
const easeCheck = {
  u25: { linear: at25.linear, eased: at25.eased, expEased: easedX(0.25), expLinear: linearX(0.25) },
  u75: { linear: at75.linear, eased: at75.eased, expEased: easedX(0.75), expLinear: linearX(0.75) },
};
console.log(`[smoke] easeCheck=${JSON.stringify(easeCheck)}`);

// --- drive the render loop with a swept u; capture early + late frames ---
const CAPTURE_EARLY = 5;
const CAPTURE_LATE = SMOKE_MIN_FRAMES - 5;
let framesObserved = 0;
let earlyFrame;
let lateFrame;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const u = i / (SMOKE_MIN_FRAMES - 1); // Cover both easing endpoints.
  stepEasing(world, u);
  propagateTransforms(world);
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) earlyFrame = await capture(sharedDevice);
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
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

// --- brightness + motion ---
let maxBright = 0;
for (let i = 0; i < lateFrame.length; i += 4) {
  const m = Math.max((lateFrame[i] ?? 0) / 255, (lateFrame[i + 1] ?? 0) / 255, (lateFrame[i + 2] ?? 0) / 255);
  if (m > maxBright) maxBright = m;
}
console.log(`[smoke] lateFrameMaxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

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
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — cubes did NOT move`);
}
// (e) EASED: eased x matches closed-form + S-shape (eased < linear at 0.25, eased > linear at 0.75).
const e = easeCheck;
if (Math.abs(e.u25.eased - e.u25.expEased) > X_EPS || Math.abs(e.u75.eased - e.u75.expEased) > X_EPS) {
  failures.push(`(e) eased x != easedX(u): ${JSON.stringify(e)}`);
}
if (!(e.u25.eased < e.u25.linear - 0.05)) {
  failures.push(`(e) at u=0.25 eased x ${e.u25.eased.toFixed(3)} not clearly < linear x ${e.u25.linear.toFixed(3)} — smoothstep slow-in missing`);
}
if (!(e.u75.eased > e.u75.linear + 0.05)) {
  failures.push(`(e) at u=0.75 eased x ${e.u75.eased.toFixed(3)} not clearly > linear x ${e.u75.linear.toFixed(3)} — smoothstep slow-out missing`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((er) => er.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, lateFrameMaxBright=${maxBright.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, easedShape OK (u.25 eased<lin, u.75 eased>lin), RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
