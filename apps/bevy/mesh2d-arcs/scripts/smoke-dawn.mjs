#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = 320;
const height = 180;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - webgpu import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
let target;
const canvas = {
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
        device ??= desc.device;
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return null;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const value = await requestDevice(descriptor);
    device ??= value;
    return value;
  };
  return adapter;
};

const here = dirname(fileURLToPath(import.meta.url));
const { World } = await import('@forgeax/engine-ecs');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { buildMesh2dArcsWorld, makeTextureAsset, makeTexturePixels, TEXTURE_SIZE } = await import(resolve(here, '..', 'src', 'mesh2d-arcs.ts'));
const manifest = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.error(`[smoke] FAIL - renderer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const pixels = makeTexturePixels();
const texture = makeTextureAsset(pixels);
const textureHandle = world.allocSharedRef('TextureAsset', texture);
buildMesh2dArcsWorld(world, unwrapHandle(textureHandle));
propagateTransforms(world);

async function capture() {
  await device.queue.onSubmittedWorkDone();
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

let frame;
for (let i = 0; i < frames; i++) {
  world.update().unwrap();
  const drawn = drawSmokeFrame(renderer, world);
  if (!drawn.ok) console.error(`[smoke] draw ${i}: ${drawn.error.code}`);
  frame = await capture();
}
if (!frame) {
  console.error('[smoke] FAIL - incomplete frame evidence');
  process.exit(1);
}

let bright = 0;
let coloredPixels = 0;
let upperPixels = 0;
let lowerPixels = 0;
const buckets = new Set();
for (let i = 0; i < frame.length; i += 4) {
  const r = frame[i] ?? 0;
  const g = frame[i + 1] ?? 0;
  const b = frame[i + 2] ?? 0;
  bright = Math.max(bright, r, g, b);
  if (Math.max(r, g, b) > 120 && Math.max(r, g, b) - Math.min(r, g, b) > 35) {
    coloredPixels++;
    buckets.add(`${Math.floor(r / 64)}:${Math.floor(g / 64)}:${Math.floor(b / 64)}`);
    const y = Math.floor(i / 4 / width);
    if (y < height / 2) upperPixels++;
    else lowerPixels++;
  }
}
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'mesh2d-arcs.png'), writeReferencePng(frame, width, height));
console.log(`[smoke] frames=${frames} bright=${(bright / 255).toFixed(4)} coloredPixels=${coloredPixels} upper=${upperPixels} lower=${lowerPixels} colorBuckets=${buckets.size} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (bright / 255 <= 0.15) failures.push(`bright=${(bright / 255).toFixed(4)}`);
if (coloredPixels < 500) failures.push(`coloredPixels=${coloredPixels}`);
if (upperPixels < 100 || lowerPixels < 100) failures.push(`rows=${upperPixels}/${lowerPixels}`);
if (buckets.size < 3) failures.push(`colorBuckets=${buckets.size}`);
if (errors.length > 0) failures.push(`RhiError=${errors.length}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${frames}, circular-mask sectors/segments and transformed bounds are visible, errors=0`);
device.destroy?.();
