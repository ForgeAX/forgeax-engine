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
  width, height,
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
const { buildMesh2dWorld } = await import(resolve(here, '..', 'src', 'mesh2d.ts'));
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
buildMesh2dWorld(world);
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

let pixels;
for (let i = 0; i < frames; i++) {
  world.update().unwrap();
  const drawn = drawSmokeFrame(renderer, world);
  if (!drawn.ok) console.error(`[smoke] draw ${i}: ${drawn.error.code}`);
  if (i === frames - 1) pixels = await capture();
}
if (!pixels) {
  console.error('[smoke] FAIL - incomplete frame evidence');
  process.exit(1);
}
let bright = 0;
let colored = 0;
for (let i = 0; i < pixels.length; i += 4) {
  const r = pixels[i] ?? 0;
  const g = pixels[i + 1] ?? 0;
  const b = pixels[i + 2] ?? 0;
  bright = Math.max(bright, r, g, b);
  if (Math.max(r, g, b) > 40 && Math.max(r, g, b) - Math.min(r, g, b) > 20) colored++;
}
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'mesh2d.png'), writeReferencePng(pixels, width, height));
console.log(`[smoke] frames=${frames} bright=${(bright / 255).toFixed(4)} coloredPixels=${colored} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (bright / 255 <= 0.15) failures.push(`bright=${(bright / 255).toFixed(4)}`);
if (colored < 500) failures.push(`coloredPixels=${colored}`);
if (errors.length > 0) failures.push(`RhiError=${errors.length}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${frames}, visible colored 2D meshes, errors=0`);
device.destroy?.();
