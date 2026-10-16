#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-translation headless dawn smoke — reproduces the app's translation World
// in node-dawn and asserts a real lit render THAT MOVES: the cube slides along
// its local X axis, so a frame early in the slide and a frame later must differ.
//
// Mirrors apps/bevy/3d-rotation/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World + move math are built by the SHARED src/translation.ts (imported here
// via Node's TS type-stripping) so this smoke and the browser app render the
// exact same scene + motion — no duplicate-scene drift (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// The smoke drives stepMove(world, dt) between draws to advance the slide
// deterministically (the app gets dt from createApp's frame-loop; here we inject
// a fixed dt so the two capture points are reproducible). Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) the cube observation window contains a lit pixel at the EARLY capture.
//       The yawed cube puts one dark face over the exact center pixel, so a
//       small projected window is the stable visibility witness.
//   (d) MOTION: the frame captured near t=0 differs from a frame captured after
//       the cube has slid ~2 units along local X (mean per-pixel delta >
//       MOTION_THRESHOLD). A static render (broken Time wiring / quat.right
//       no-op / frozen pos) would make the two frames identical.
//   (e) Renderer.onError fired 0 times.
//
// Writes BOTH capture PNGs (artifacts/frame-early.png + frame-late.png) so the
// solo loop reads them with its own eyes and confirms the cube actually slid
// (memory dawn-smoke-loose-threshold-masks-browser-black: a not-black pixel is
// not proof the RIGHT thing rendered — and here, not proof it MOVED).
//
// Output literals (grep-stable): `[bevy-translation] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] motionMeanDelta=<f>`,
// `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
// Motion floor: the cube is a small fraction of the 320×180 frame, so even a
// clear ~2-unit slide (verified by eye) moves the mean pixel by a few 1e-3. A
// static render (broken Time / quat.right no-op / stale world matrix) is EXACTLY
// 0. The floor sits an order of magnitude below the observed motion and an order
// above numerical zero, so it decisively separates "slid" from "frozen" without
// flaking on the exact slide amount.
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
// Preserve the original simulation horizon and two-unit distance between captures.
const FIXED_DT = (100 / 60) / SMOKE_MIN_FRAMES;

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

// --- build the translation World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildTranslationWorld, stepMove } = await import(resolve(here, '..', 'src', 'translation.ts'));

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
console.log(`[bevy-translation] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildTranslationWorld(world);

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
// The cube slides via stepMove(world, FIXED_DT) between draws. We capture just
// after the first draw (cube near the origin) and again after ~2 units of slide
// along local X, a clearly different on-screen position.
const CAPTURE_EARLY = Math.max(1, Math.floor(SMOKE_MIN_FRAMES * 0.05));
const CAPTURE_LATE = Math.max(CAPTURE_EARLY + 1, Math.floor(SMOKE_MIN_FRAMES * 0.65));
let framesObserved = 0;
let earlyFrame;
let lateFrame;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) earlyFrame = await capture(sharedDevice);
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
  // Advance the slide, then propagate local Transform → world matrix (the app
  // gets this via createApp's world.update(1 / 60).unwrap() each frame; the direct-draw smoke
  // must call it explicitly or the renderer reads stale world matrices and the
  // cube never moves — memory transform-local-trs-world-mat4-unification +
  // propagate-transforms-never-auto-registered).
  stepMove(world, FIXED_DT);
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
const cubeWindow = {
  xMin: Math.floor(WIDTH * 0.4),
  xMax: Math.floor(WIDTH * 0.65),
  yMin: Math.floor(HEIGHT * 0.35),
  yMax: Math.floor(HEIGHT * 0.62),
};
const ndcCenter = readRgba(earlyFrame, Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const corner = readRgba(earlyFrame, Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
let cubeWindowPeak = 0;
let cubeWindowPeakColor = [0, 0, 0];
let cubeWindowMotion = 0;
let cubeWindowPixels = 0;
for (let y = cubeWindow.yMin; y < cubeWindow.yMax; y++) {
  for (let x = cubeWindow.xMin; x < cubeWindow.xMax; x++) {
    const early = readRgba(earlyFrame, x, y);
    const luma = early[0] * 0.2126 + early[1] * 0.7152 + early[2] * 0.0722;
    if (luma > cubeWindowPeak) {
      cubeWindowPeak = luma;
      cubeWindowPeakColor = early;
    }
    const late = readRgba(lateFrame, x, y);
    cubeWindowMotion +=
      Math.abs(early[0] - late[0]) +
      Math.abs(early[1] - late[1]) +
      Math.abs(early[2] - late[2]);
    cubeWindowPixels++;
  }
}
const cubeWindowMotionMean = cubeWindowMotion / (cubeWindowPixels * 3);
console.log(
  `[smoke] pixelSamples=${JSON.stringify({ ndcCenter, corner, cubeWindowPeak: cubeWindowPeakColor })}`,
);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(
  `[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} cubeWindowMotionMean=${cubeWindowMotionMean.toFixed(5)} (threshold ${MOTION_THRESHOLD})`,
);

// --- dump both PNGs so the loop eyeballs the slide + compares to Bevy ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const earlyOut = resolve(outDir, 'frame-early.png');
  const lateOut = resolve(outDir, 'frame-late.png');
  writeFileSync(earlyOut, writeReferencePng(earlyFrame, WIDTH, HEIGHT));
  writeFileSync(lateOut, writeReferencePng(lateFrame, WIDTH, HEIGHT));
  console.log(`[smoke] wrote PNG=${earlyOut}`);
  console.log(`[smoke] wrote PNG=${lateOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (cubeWindowPeak <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(c) cube observation window peak ${cubeWindowPeak.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD} — lit cube not visible`,
  );
}
if (cubeWindowMotionMean <= MOTION_THRESHOLD) {
  failures.push(
    `(d) cubeWindowMotionMean ${cubeWindowMotionMean.toFixed(5)} <= ${MOTION_THRESHOLD} — cube did NOT visibly slide (Time/quat.right wiring broken?)`,
  );
}
if (errors.length > 0) failures.push(`(e) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 5 criteria GREEN: backend=webgpu, frames=${framesObserved}, cubeWindowPeak=${cubeWindowPeak.toFixed(4)}, cubeWindowMotionMean=${cubeWindowMotionMean.toFixed(5)}, RhiError count=0`,
);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
