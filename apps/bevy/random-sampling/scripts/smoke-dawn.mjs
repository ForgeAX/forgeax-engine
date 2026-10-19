#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-random-sampling headless dawn smoke — proves Bevy math/random_sampling:
// wireframe cube + randomly sampled points inside.
// Browser and smoke share the same src/random-sampling.ts scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;

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
  width: WIDTH,
  height: HEIGHT,
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
  addEventListener() {},
  removeEventListener() {},
};

// --- readback helper ---
function bytesPerRow(w) { return Math.ceil(w * 4 / 256) * 256; }
async function capture(w, h) {
  const device = sharedDevice;
  await device.queue.onSubmittedWorkDone();
  const bpr = bytesPerRow(w);
  const buf = device.createBuffer({ size: bpr * h, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
    { width: w, height: h, depthOrArrayLayers: 1 },
  );
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
console.log(`[bevy-random-sampling] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const { buildRandomSamplingWorld, spawnSamplePoint } = await import(
  resolve(here, '..', 'src', 'random-sampling.ts')
);

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const { wireframeHalf, pointMat } = buildRandomSamplingWorld(world);

// Spawn sample points inside the cube
for (let i = 0; i < 50; i++) {
  spawnSamplePoint(world, 'interior', wireframeHalf, pointMat);
}

// --- render at SMOKE_MIN_FRAMES ---
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
await delay(50);

const pixels = await capture(WIDTH, HEIGHT);

// Check that the scene is not black
let notBlack = false;
let hasColors = false;
for (let i = 0; i < pixels.length; i += 4) {
  if (pixels[i] > 0 || pixels[i + 1] > 0 || pixels[i + 2] > 0) {
    notBlack = true;
    hasColors = true;
    break;
  }
}

// --- write reference PNG ---
const refPngPath = resolve(here, '..', 'artifacts', 'random-sampling-ref.png');
mkdirSync(dirname(refPngPath), { recursive: true });
writeFileSync(refPngPath, encodePng(WIDTH, HEIGHT, pixels));

// --- results ---
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['not-black', notBlack],
  ['has-colors', hasColors],
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

console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, backend=${rendererBackend(renderer)}`);
process.exit(0);