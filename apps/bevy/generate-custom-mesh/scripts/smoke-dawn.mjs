#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-generate-custom-mesh headless dawn smoke.
// Browser and smoke share src/generate-custom-mesh.ts.

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
const _ra = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const raw = await _ra(opts);
  if (raw === null) return raw;
  const _rd = raw.requestDevice.bind(raw);
  raw.requestDevice = async (desc) => { const dev = await _rd(desc); if (!sharedDevice) sharedDevice = dev; return dev; };
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
  getContext(k) { if (k !== 'webgpu') return null;
    return { configure(d) { ensureRenderTarget(d.device, d.format ?? 'rgba8unorm'); }, unconfigure() {},
      getCurrentTexture() { if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm'); return renderTarget; } }; },
  addEventListener() {}, removeEventListener() {},
};

function bpr(w) { return Math.ceil(w * 4 / 256) * 256; }
async function capture() {
  const dev = sharedDevice;
  await dev.queue.onSubmittedWorkDone();
  const row = bpr(WIDTH);
  const buf = dev.createBuffer({ size: row * HEIGHT, usage: 0x01 | 0x08 });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: renderTarget }, { buffer: buf, bytesPerRow: row, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * row, y * row + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));

const { buildCustomMeshWorld, makeCustomMeshTexture, toggleCustomMesh } = await import(resolve(here, '..', 'src', 'generate-custom-mesh.ts'));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const texture = makeCustomMeshTexture();
const textureHandle = world.allocSharedRef('TextureAsset', texture);
const meshState = buildCustomMeshWorld(world, unwrapHandle(textureHandle));

world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const beforePixels = await capture();
toggleCustomMesh(world, meshState);
world.update().unwrap();
await drawSmokeFrame(renderer, world);
await delay(50);
const afterPixels = await capture();
for (let i = 2; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  await drawSmokeFrame(renderer, world);
}
const pixels = afterPixels;
const refPath = resolve(here, '..', 'artifacts', 'generate-custom-mesh-ref.png');
mkdirSync(dirname(refPath), { recursive: true });
writeFileSync(refPath, writeReferencePng(pixels, WIDTH, HEIGHT));

let notBlack = false;
for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] > 0 || pixels[i + 1] > 0 || pixels[i + 2] > 0) { notBlack = true; break; } }
let uvDiffSum = 0;
let uvDiffPixels = 0;
for (let i = 0; i < beforePixels.length; i += 4) {
  const diff = Math.abs(beforePixels[i] - afterPixels[i])
    + Math.abs(beforePixels[i + 1] - afterPixels[i + 1])
    + Math.abs(beforePixels[i + 2] - afterPixels[i + 2]);
  uvDiffSum += diff;
  if (diff > 3) uvDiffPixels += 1;
}
const uvDiffMean = uvDiffSum / (WIDTH * HEIGHT);
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['not-black', notBlack],
  ['uv-toggle-changed-pixels', uvDiffPixels > 100],
  ['uv-toggle-mean-diff', uvDiffMean > 1],
  ['rhi-error-count=0', errors.length === 0],
];
let all = true;
for (const [n, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${n}`); if (!ok) all = false; }
if (!all) { console.error(`[smoke] FAIL - uvDiffPixels=${uvDiffPixels} uvDiffMean=${uvDiffMean.toFixed(3)}`); process.exit(1); }
console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, backend=${rendererBackend(renderer)}, uvDiffPixels=${uvDiffPixels}, uvDiffMean=${uvDiffMean.toFixed(3)}`);
process.exit(0);
