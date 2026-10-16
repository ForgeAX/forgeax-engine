#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;

let create, globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try { gpu = create([]); } catch (err) {
  console.error(`[smoke] FAIL - dawn-node create: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const rawRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const raw = await rawRequestAdapter(opts);
  if (raw === null) return raw;
  const rawRequestDevice = raw.requestDevice.bind(raw);
  raw.requestDevice = async (desc) => { const dev = await rawRequestDevice(desc); if (!sharedDevice) sharedDevice = dev; return dev; };
  return raw;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }, format,
    usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'],
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
      getCurrentTexture() { if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm'); return renderTarget; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

function bytesPerRow(width) { return Math.ceil(width * 4 / 256) * 256; }
async function capture() {
  const device = sharedDevice;
  await device.queue.onSubmittedWorkDone();
  const row = bytesPerRow(WIDTH);
  const buffer = device.createBuffer({ size: row * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow: row, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * row, y * row + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const here = dirname(fileURLToPath(import.meta.url));
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));

const { buildAlterMeshWorld, mutateSharedMesh, swapRightMesh } = await import(resolve(here, '..', 'src', 'alter-mesh.ts'));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const state = buildAlterMeshWorld(world);

world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const before = await capture();
swapRightMesh(world, state);
world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const afterSwap = await capture();
mutateSharedMesh(world, state);
world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const afterMutation = await capture();
for (let i = 3; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
mkdirSync(resolve(here, '..', 'artifacts'), { recursive: true });
writeFileSync(resolve(here, '..', 'artifacts', 'alter-mesh-ref.png'), writeReferencePng(afterMutation, WIDTH, HEIGHT));

function diff(a, b) {
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    const value = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += value;
    if (value > 3) pixels += 1;
  }
  return { pixels, mean: sum / (WIDTH * HEIGHT) };
}
let notBlack = false;
for (let i = 0; i < afterMutation.length; i += 4) {
  if (afterMutation[i] > 0 || afterMutation[i + 1] > 0 || afterMutation[i + 2] > 0) { notBlack = true; break; }
}
const swapDiff = diff(before, afterSwap);
const mutationDiff = diff(afterSwap, afterMutation);
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['not-black', notBlack],
  ['mesh-handle-swap-changed-pixels', swapDiff.pixels > 100],
  ['shared-mesh-mutation-changed-pixels', mutationDiff.pixels > 100],
  ['rhi-error-count=0', errors.length === 0],
];
let all = true;
for (const [name, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) all = false; }
if (!all) {
  console.error(`[smoke] FAIL - swapDiffPixels=${swapDiff.pixels} mutationDiffPixels=${mutationDiff.pixels}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, swapDiffPixels=${swapDiff.pixels}, mutationDiffPixels=${mutationDiff.pixels}`);
process.exit(0);
