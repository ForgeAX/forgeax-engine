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
const here = dirname(fileURLToPath(import.meta.url));

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
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
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device = await requestDevice(descriptor);
    return device;
  };
  return adapter;
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { buildMesh2dAlphaModeWorld, makeAlphaModePixels, TEXTURE_SIZE } = await import(resolve(here, '..', 'src', 'mesh2d-alpha-mode.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const pixels = makeAlphaModePixels();
const texture = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
  format: 'rgba8unorm-srgb',
  data: pixels,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const textureHandle = world.allocSharedRef('TextureAsset', texture);
buildMesh2dAlphaModeWorld(world, unwrapHandle(textureHandle));

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

for (let i = 0; i < frames; i++) {
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
}
const frame = await capture();
let bright = 0;
let coloredPixels = 0;
let opaqueRegion = 0;
let alphaRegion = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const r = frame[offset] ?? 0;
    const g = frame[offset + 1] ?? 0;
    const b = frame[offset + 2] ?? 0;
    bright = Math.max(bright, r, g, b);
    if (Math.max(r, g, b) > 40 && Math.max(r, g, b) - Math.min(r, g, b) > 20) coloredPixels++;
    if (x >= 45 && x < 160 && Math.max(r, g, b) > 40) opaqueRegion++;
    if (x >= 160 && x < 280 && Math.max(r, g, b) > 40) alphaRegion++;
  }
}
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'mesh2d-alpha-mode.png'), writeReferencePng(frame, width, height));
console.log(`[smoke] frames=${frames} bright=${(bright / 255).toFixed(4)} coloredPixels=${coloredPixels} opaqueRegion=${opaqueRegion} alphaRegion=${alphaRegion} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (bright / 255 <= 0.15) failures.push(`bright=${(bright / 255).toFixed(4)}`);
if (coloredPixels < 500) failures.push(`coloredPixels=${coloredPixels}`);
if (opaqueRegion < 200) failures.push(`opaqueRegion=${opaqueRegion}`);
if (alphaRegion < 200) failures.push(`alphaRegion=${alphaRegion}`);
if (errors.length > 0) failures.push(`RhiError=${errors.length}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - backend=webgpu, opaque/mask/blend 2D meshes visible, errors=0');
device.destroy?.();
