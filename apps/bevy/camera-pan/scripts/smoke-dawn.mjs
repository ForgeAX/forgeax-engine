import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-camera-pan headless dawn smoke — proves Bevy pan_camera_controller
// behavior: synthetic WASD/arrows pan an orthographic camera and wheel notches
// zoom symmetric frustum extents within bounds. Browser and smoke share the same
// src/camera-pan.ts scene and controller.
//
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
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

// --- build the camera-orbit World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { Camera } = await import('@forgeax/engine-render');
const { Transform, propagateTransforms } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const { buildCameraPanWorld, cameraHalfHeight, PanCamera, stepCameraPan } = await import(resolve(here, '..', 'src', 'camera-pan.ts'));

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
console.log(`[bevy-camera-pan] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildCameraPanWorld(world);

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

// --- drive shared pan/zoom controller and capture early/late views ---
const CAPTURE_EARLY = Math.max(1, Math.floor(SMOKE_MIN_FRAMES * 0.05));
const CAPTURE_LATE = Math.max(CAPTURE_EARLY + 1, Math.floor(SMOKE_MIN_FRAMES * 0.65));
const cameraQuery = world.query({ read: [Camera, Transform], with: [PanCamera] }).unwrap();
let framesObserved = 0;
let earlyFrame;
let lateFrame;
let earlyHalfHeight = Number.NaN;
let earlyCameraPos;
let finalCameraPos;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlyHalfHeight = cameraHalfHeight(world);
    for (const row of cameraQuery) {
      earlyCameraPos = Array.from(row.get(Transform).pos);
      break;
    }
  }
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
  stepCameraPan(world, FIXED_DT, {
    left: i < Math.floor(SMOKE_MIN_FRAMES * 0.2),
    right: false,
    up: false,
    down: false,
    wheelDelta: i >= Math.floor(SMOKE_MIN_FRAMES * 0.4) && i < Math.floor(SMOKE_MIN_FRAMES * 0.45) ? -1 : 0,
  });
  propagateTransforms(world);
}
const finalHalfHeight = cameraHalfHeight(world);
let finalExtents;
for (const row of cameraQuery) {
  const transform = row.get(Transform);
  const camera = row.get(Camera);
  finalCameraPos = Array.from(transform.pos);
  finalExtents = [camera.left, camera.right, camera.bottom, camera.top];
  break;
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
// The colourful field can be off-center after a pan, so use the brightest pixel
// across the actual capture rather than a fragile fixed coordinate.
let earlyMaxBright = 0;
for (let i = 0; i < earlyFrame.length; i += 4) {
  earlyMaxBright = Math.max(earlyMaxBright, earlyFrame[i] ?? 0, earlyFrame[i + 1] ?? 0, earlyFrame[i + 2] ?? 0);
}
console.log(`[smoke] earlyMaxBright=${(earlyMaxBright / 255).toFixed(4)} (floor 0.15)`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);
console.log(`[smoke] halfHeight=${finalHalfHeight.toFixed(4)} cameraPos=${JSON.stringify(finalCameraPos)} extents=${JSON.stringify(finalExtents)}`);

// --- dump both PNGs so the loop eyeballs pan/zoom behavior + compares to Bevy ---
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
if (earlyMaxBright / 255 <= 0.15) {
  failures.push(`(c) earlyMaxBright ${(earlyMaxBright / 255).toFixed(4)} <= 0.15 — scene not visible`);
}
if (motionMeanDelta <= MOTION_THRESHOLD) {
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — camera did NOT visibly pan/zoom`);
}
const positionChanged = earlyCameraPos?.some((value, index) => Math.abs(value - (finalCameraPos?.[index] ?? value)) > 1e-3) ?? false;
const zoomedIn = finalHalfHeight < earlyHalfHeight && finalHalfHeight >= 1 && finalHalfHeight <= 10;
const symmetricExtents = finalExtents !== undefined && Math.abs((finalExtents[0] ?? 0) + (finalExtents[1] ?? 0)) < 1e-5 && Math.abs((finalExtents[2] ?? 0) + (finalExtents[3] ?? 0)) < 1e-5;
if (!positionChanged || !zoomedIn || !symmetricExtents) {
  failures.push(`(e) pan/zoom invalid: earlyHalfHeight=${earlyHalfHeight} finalHalfHeight=${finalHalfHeight} positionChanged=${positionChanged} symmetric=${symmetricExtents}`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, earlyMaxBright=${(earlyMaxBright / 255).toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, pan+boundedZoom OK, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
