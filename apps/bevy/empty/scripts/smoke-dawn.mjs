#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-empty headless dawn smoke.
// Browser and smoke share the same src/empty.ts scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 160;
const HEIGHT = 120;

let create;
let globals;
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
const _origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const raw = await _origReqAdapter(opts);
  if (raw === null) return raw;
  const _origReqDev = raw.requestDevice.bind(raw);
  raw.requestDevice = async (desc) => {
    const dev = await _origReqDev(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return raw;
};

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

function bytesPerRow(w) { return Math.ceil(w * 4 / 256) * 256; }
async function capture() {
  const device = sharedDevice;
  await device.queue.onSubmittedWorkDone();
  const bpr = bytesPerRow(WIDTH);
  const buf = device.createBuffer({ size: bpr * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow: bpr, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * bpr, y * bpr + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const { buildEmptyWorld } = await import(resolve(here, '..', 'src', 'empty.ts'));
const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildEmptyWorld(world);

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
await delay(50);

const pixels = await capture();
const refPngPath = resolve(here, '..', 'artifacts', 'empty-ref.png');
mkdirSync(dirname(refPngPath), { recursive: true });
writeFileSync(refPngPath, encodePng(WIDTH, HEIGHT, pixels));

const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
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