import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-camera-zoom headless dawn smoke — proves Bevy projection_zoom behavior.
// Synthetic wheel input zooms the active projection and a synthetic Space edge
// switches orthographic to perspective; app and smoke share src/camera-zoom.ts.
//
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const WIDTH = testQuality.viewport.width; const HEIGHT = testQuality.viewport.height;

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
const { createRenderer } = await import('@forgeax/engine-runtime');
const { CAMERA_PROJECTION_PERSPECTIVE } = await import('@forgeax/engine-render');
const { Camera } = await import('@forgeax/engine-render');
const { Transform, propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildCameraZoomWorld, cameraZoomValue, ZoomCamera, stepCameraZoom } = await import(resolve(here, '..', 'src', 'camera-zoom.ts'));

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
console.log(`[bevy-camera-zoom] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildCameraZoomWorld(world);

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

// --- drive orthographic zoom, then switch and zoom perspective ---
const CAPTURE_EARLY = Math.max(1, Math.floor(SMOKE_MIN_FRAMES * 0.05));
const CAPTURE_LATE = Math.max(CAPTURE_EARLY + 1, Math.floor(SMOKE_MIN_FRAMES * 0.65));
const cameraQuery = world.query({ read: [Camera], with: [Transform, ZoomCamera] }).unwrap();
let framesObserved = 0, earlyFrame, lateFrame, earlyZoom = Number.NaN, finalCamera;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world); if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`); framesObserved++;
  if (i === CAPTURE_EARLY) { earlyFrame = await capture(sharedDevice); earlyZoom = cameraZoomValue(world); }
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
  stepCameraZoom(world, { switchProjection: i === Math.floor(SMOKE_MIN_FRAMES * 0.4), wheelDelta: i < Math.floor(SMOKE_MIN_FRAMES * 0.2) || i > Math.floor(SMOKE_MIN_FRAMES * 0.5) ? 1 : 0 });
  propagateTransforms(world);
}
const finalZoom = cameraZoomValue(world);
for (const row of cameraQuery) { const c = row.get(Camera); finalCamera = { projection: c.projection, fov: c.fov, left: c.left, right: c.right, bottom: c.bottom, top: c.top }; break; }
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

// --- pixels, zoom state, and rendered motion ---
let earlyMaxBright = 0; for (let i = 0; i < earlyFrame.length; i += 4) earlyMaxBright = Math.max(earlyMaxBright, earlyFrame[i] ?? 0, earlyFrame[i+1] ?? 0, earlyFrame[i+2] ?? 0);
let sum = 0; for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] earlyMaxBright=${(earlyMaxBright/255).toFixed(4)} motionMeanDelta=${motionMeanDelta.toFixed(5)} earlyZoom=${earlyZoom.toFixed(4)} finalZoom=${finalZoom.toFixed(4)} finalCamera=${JSON.stringify(finalCamera)}`);
try { const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts'); mkdirSync(outDir,{recursive:true}); writeFileSync(resolve(outDir,'frame-early.png'),encodePng(WIDTH, HEIGHT, earlyFrame)); writeFileSync(resolve(outDir,'frame-late.png'),encodePng(WIDTH, HEIGHT, lateFrame)); } catch (err) { console.warn(`[smoke] PNG dump skipped: ${String(err)}`); }
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} expected webgpu`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved}`);
if (earlyMaxBright/255 <= 0.15) failures.push(`(c) earlyMaxBright=${earlyMaxBright/255}`);
if (motionMeanDelta <= MOTION_THRESHOLD) failures.push(`(d) motion=${motionMeanDelta}`);
const switched = finalCamera?.projection === CAMERA_PROJECTION_PERSPECTIVE;
const fovZoomed = (finalCamera?.fov ?? 0) < Math.PI / 5 + 0.01;
const orthographicZoomed = earlyZoom <= 0.5 + 1e-4;
if ((!orthographicZoomed && !(finalZoom < earlyZoom)) || !switched || !fovZoomed) failures.push(`(e) zoom/switch invalid early=${earlyZoom} final=${finalZoom} orthographicZoomed=${orthographicZoomed} switched=${switched} fov=${finalCamera?.fov}`);
if (errors.length) failures.push(`(f) errors=${errors.map(e=>e.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, earlyMaxBright=${(earlyMaxBright / 255).toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, projection-switch+zoom OK, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
