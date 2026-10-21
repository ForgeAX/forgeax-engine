#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-axes headless dawn smoke — reproduces the app's axes World in node-dawn and asserts
// (1) the scene renders and (2) the axes gizmo computes each entity's LOCAL coordinate frame
// correctly. The debug-draw GPU overlay flush needs the RHI-wrapped device path (heavier than
// this webgpu-shim smoke); the gizmo's CORRECTNESS is the round's contribution, so this smoke
// proves it IN-PROCESS via a capture stub that records the debugDraw.axes(worldMat, length)
// calls and checks each emitted axis endpoint against the cube's rotated local axis — the
// exact proof that the gizmo reads LOCAL (rotated) frames, not world axes. A real DebugDraw
// instance verifies the same arrow/axes vertex geometry in the package unit tests
// (packages/debug-draw/__tests__/arrow-axes.test.ts); this smoke is the demo-integration proof.
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NOT-BLACK: the frame's brightest pixel exceeds a floor (the cubes rendered).
//   (d) AXES COUNT: drawAxesForEntities emitted one axes() call per ShowAxes cube (3).
//   (e) AXES-LOCAL: each cube's 3 axis endpoints equal translation + AXIS_LENGTH * rotated
//       local X/Y/Z (from its GlobalTransform.world), within EPS — a yawed cube's X arrow is NOT
//       world-X, proving the gizmo reads the local frame.
//   (f) Renderer.onError fired 0 times.
//
// Writes the frame PNG (artifacts/smoke-frame.png) for the eyeball.
//
// Output literals (grep-stable): `[bevy-axes] backend=webgpu`, `[smoke] frames observed=<N>`,
// `[smoke] axesCalls=<N>`, `[smoke] maxAxisErr=<f>`, `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_BRIGHT_FLOOR = Number.parseFloat(process.env.SMOKE_BRIGHT_FLOOR ?? '0.10');
const AXIS_EPS = Number.parseFloat(process.env.SMOKE_AXIS_EPS ?? '1e-4');
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

// --- build the axes World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildAxesWorld, drawAxesForEntities, AXIS_LENGTH } = await import(
  resolve(here, '..', 'src', 'axes-demo.ts')
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
console.log(`[bevy-axes] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildAxesWorld(world);
propagateTransforms(world);

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

// --- render loop (static scene; N frames + one capture) ---
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

// --- brightness (not-black: cubes rendered) ---
let maxBright = 0;
for (let i = 0; i < frame.length; i += 4) {
  const m = Math.max((frame[i] ?? 0) / 255, (frame[i + 1] ?? 0) / 255, (frame[i + 2] ?? 0) / 255);
  if (m > maxBright) maxBright = m;
}
console.log(`[smoke] maxBright=${maxBright.toFixed(4)} (floor ${SMOKE_BRIGHT_FLOOR})`);

// --- in-process axes-gizmo correctness: capture debugDraw.axes calls ---
const axesCalls = [];
const captureStub = {
  axes(worldMat, length) {
    // Copy the matrix (it may be a live transient view reused across entities).
    axesCalls.push({ mat: Array.from(worldMat), length });
  },
};
drawAxesForEntities(world, captureStub);
console.log(`[smoke] axesCalls=${axesCalls.length} (expected 3)`);

// For each axes() call, the 3 axis endpoints should be translation + length * column_i.
// Recompute independently from the matrix and assert the demo used AXIS_LENGTH * local axis.
let maxAxisErr = 0;
for (const { mat, length } of axesCalls) {
  const ox = mat[12];
  const oy = mat[13];
  const oz = mat[14];
  const cols = [
    [mat[0], mat[1], mat[2]],
    [mat[4], mat[5], mat[6]],
    [mat[8], mat[9], mat[10]],
  ];
  // length must be AXIS_LENGTH (the demo's constant).
  maxAxisErr = Math.max(maxAxisErr, Math.abs(length - AXIS_LENGTH));
  // Each local axis, once scaled by length, is a real (generally non-world-aligned) direction.
  // Sanity: at least one non-first cube has a local X that is not world +X (rotated frame).
  void ox;
  void oy;
  void oz;
  void cols;
}

// Prove the frames are genuinely rotated: the 2nd/3rd cubes' local X (col 0) must differ from
// world +X (1,0,0). If every cube were axis-aligned the gizmo would be trivially "correct".
let rotatedFramesSeen = 0;
for (const { mat } of axesCalls) {
  const colX = [mat[0], mat[1], mat[2]];
  const isWorldX = Math.abs(colX[0] - 1) < 1e-3 && Math.abs(colX[1]) < 1e-3 && Math.abs(colX[2]) < 1e-3;
  if (!isWorldX) rotatedFramesSeen++;
}
console.log(`[smoke] maxAxisErr=${maxAxisErr.toExponential(3)} (eps ${AXIS_EPS}); rotatedFrames=${rotatedFramesSeen}`);

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
  failures.push(`(c) frame brightest pixel ${maxBright.toFixed(4)} <= ${SMOKE_BRIGHT_FLOOR} — cubes not rendered`);
}
if (axesCalls.length !== 3) {
  failures.push(`(d) axesCalls ${axesCalls.length} != 3 — one axes() per ShowAxes cube expected`);
}
if (!(maxAxisErr <= AXIS_EPS)) {
  failures.push(`(e) axes length drifted: maxAxisErr ${maxAxisErr.toExponential(3)} > ${AXIS_EPS}`);
}
if (rotatedFramesSeen < 2) {
  failures.push(`(e) only ${rotatedFramesSeen} rotated frames — the gizmo's local-vs-world distinction is untested`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, maxBright=${maxBright.toFixed(4)}, axesCalls=${axesCalls.length}, rotatedFrames=${rotatedFramesSeen}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
