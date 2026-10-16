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
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
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
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { unwrapHandle } = await import('@forgeax/engine-types');
const here = dirname(fileURLToPath(import.meta.url));
const { buildRotateToCursorWorld, makeShipPixels, readShipRotation, stepRotateToCursor, TEXTURE_SIZE } = await import(resolve(here, '..', 'src', 'rotate-to-cursor.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}` });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const pixels = makeShipPixels();
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
const scene = buildRotateToCursorWorld(world, unwrapHandle(textureHandle));

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
  for (let y = 0; y < height; y += 1) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

let early;
let late;
let earlyRotation;
let lateRotation;
for (let i = 0; i < frames; i += 1) {
  const screenX = i < Math.floor(frames / 2) ? width * 0.25 : width * 0.75;
  propagateTransforms(world);
  if (!stepRotateToCursor(world, scene, screenX, height * 0.5, width, height)) throw new Error(`[smoke] cursor ray missed at frame ${i}`);
  propagateTransforms(world);
  world.update().unwrap();
  const drawn = drawSmokeFrame(renderer, world);
  if (!drawn.ok) throw new Error(`${drawn.error.code}: ${drawn.error.hint}`);
  if (i === Math.max(1, Math.floor(frames * 0.05))) { early = await capture(); earlyRotation = readShipRotation(world, scene); }
  if (i === frames - 1) { late = await capture(); lateRotation = readShipRotation(world, scene); }
}
if (!early || !late || !earlyRotation || !lateRotation) throw new Error('[smoke] incomplete frame/state evidence');
let brightPixels = 0;
let imageDelta = 0;
for (let i = 0; i < early.length; i += 4) {
  const earlyLuma = Math.max(early[i] ?? 0, early[i + 1] ?? 0, early[i + 2] ?? 0);
  const lateLuma = Math.max(late[i] ?? 0, late[i + 1] ?? 0, late[i + 2] ?? 0);
  if (lateLuma > 70) brightPixels += 1;
  imageDelta += Math.abs((early[i] ?? 0) - (late[i] ?? 0));
}
let rotationDelta = 0;
for (let i = 0; i < 4; i += 1) rotationDelta += Math.abs((earlyRotation[i] ?? 0) - (lateRotation[i] ?? 0));
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'rotate-to-cursor-left.png'), writeReferencePng(early, width, height));
writeFileSync(resolve(outDir, 'rotate-to-cursor-right.png'), writeReferencePng(late, width, height));
const imageMeanDelta = imageDelta / (early.length * 255);
console.log(`[smoke] frames=${frames} brightPixels=${brightPixels} imageMeanDelta=${imageMeanDelta.toFixed(5)} rotationDelta=${rotationDelta.toFixed(5)} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (brightPixels < 100) failures.push(`brightPixels=${brightPixels}`);
if (imageMeanDelta <= 0.0005) failures.push(`imageMeanDelta=${imageMeanDelta.toFixed(5)}`);
if (rotationDelta <= 0.1) failures.push(`rotationDelta=${rotationDelta.toFixed(5)}`);
if (errors.length > 0) failures.push(`RhiError=${errors.length}`);
if (failures.length > 0) { console.error(`[smoke] FAIL - ${failures.join('; ')}`); process.exit(1); }
console.log('[smoke] PASS - backend=webgpu, cursor positions changed sprite orientation, errors=0');
device.destroy?.();
