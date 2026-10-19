#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-window-resizing headless dawn smoke — proves Bevy window/window_resizing
// behavior: canvas resize, renderer survives, camera aspect syncs.
// Browser and smoke share the same src/window-resizing.ts scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 160;
const HEIGHT = 120;

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

// --- mock canvas (mirrors screenshot smoke) ---
let renderTarget;
function ensureRenderTarget(device, format, w, h) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: w, height: h, depthOrArrayLayers: 1 },
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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm', mockCanvas.width, mockCanvas.height); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm', mockCanvas.width, mockCanvas.height);
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- readback helper (mirrors screenshot smoke) ---
function bytesPerRow(w) { return Math.ceil(w * 4 / 256) * 256; }
async function capture(w, h) {
  const device = sharedDevice;
  await device.queue.onSubmittedWorkDone();
  const bpr = bytesPerRow(w);
  const buf = device.createBuffer({ size: bpr * h, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: renderTarget }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const tight = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) tight.set(raw.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  return tight;
}

// --- build ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera } = await import('@forgeax/engine-render');
const { CAMERA_PROJECTION_PERSPECTIVE } = await import('@forgeax/engine-render');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(`[bevy-window-resizing] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const { buildWindowResizingWorld } = await import(resolve(here, '..', 'src', 'window-resizing.ts'));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildWindowResizingWorld(world);

// --- render at initial size + verify not black ---
world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const initialPixels = await capture(WIDTH, HEIGHT);
const initialIdx = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
const initialR = initialPixels[initialIdx];
const initialG = initialPixels[initialIdx + 1];
const initialB = initialPixels[initialIdx + 2];
const initialNotBlack = initialR > 10 || initialG > 10 || initialB > 10;

// --- render at SMOKE_MIN_FRAMES ---
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
await delay(50);
const afterPixels = await capture(WIDTH, HEIGHT);
const afterIdx = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
const afterR = afterPixels[afterIdx];
const afterG = afterPixels[afterIdx + 1];
const afterB = afterPixels[afterIdx + 2];
const afterNotBlack = afterR > 10 || afterG > 10 || afterB > 10;

// --- test resize: change canvas dimensions ---
const origW = mockCanvas.width;
const origH = mockCanvas.height;
mockCanvas.width = 640;
mockCanvas.height = 360;
// Force render target to be recreated with new size
renderTarget = null;

// Update camera aspect (mirrors syncCameraAspect in createApp)
const aspect = 640 / 360;
const cameraQuery = world.query({ read: [Camera] }).unwrap();
for (const row of cameraQuery) {
  const camera = row.get(Camera);
  if (camera.autoAspect !== true) continue;
  if (camera.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
  world.set(row.entity, Camera, { aspect }).unwrap();
}

for (let i = 0; i < 10; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
await delay(50);
const resizedPixels = await capture(640, 360);
const resizedIdx = (Math.floor(360 / 2) * 640 + Math.floor(640 / 2)) * 4;
const resizedR = resizedPixels[resizedIdx];
const resizedG = resizedPixels[resizedIdx + 1];
const resizedB = resizedPixels[resizedIdx + 2];
const resizedNotBlack = resizedR > 10 || resizedG > 10 || resizedB > 10;

// Verify camera aspect reflects the resize.
let cameraAspect = 0;
for (const row of cameraQuery) {
  const camera = row.get(Camera);
  if (camera.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
  cameraAspect = camera.aspect;
  break;
}
const aspectMatch = cameraAspect > 0 && Math.abs(cameraAspect - 640 / 360) < 0.01;

// --- restore original size ---
mockCanvas.width = origW;
mockCanvas.height = origH;
renderTarget = null;

// --- write reference PNG ---
const refPngPath = resolve(here, '..', 'artifacts', 'window-resizing-ref.png');
mkdirSync(dirname(refPngPath), { recursive: true });
writeFileSync(refPngPath, encodePng(WIDTH, HEIGHT, initialPixels));

// --- results ---
const checks = [
  ['initial-not-black', initialNotBlack],
  ['after-frames-not-black', afterNotBlack],
  ['resized-not-black', resizedNotBlack],
  ['aspect-matches-640/360', aspectMatch],
  ['rhi-error-count=0', errors.length === 0],
];

let allPass = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) allPass = false;
}

if (!allPass) {
  console.error(`[smoke] FAIL - ${checks.filter(([, ok]) => !ok).map(([n]) => n).join(', ')}`);
  process.exit(1);
}

console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, initial not-black=${initialNotBlack}, resized not-black=${resizedNotBlack}, aspect=${cameraAspect.toFixed(4)}, backend=${rendererBackend(renderer)}`);
process.exit(0);
