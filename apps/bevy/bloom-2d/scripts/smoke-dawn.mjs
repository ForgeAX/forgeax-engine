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
const { BLOOM_DISABLED, BLOOM_ENABLED, Camera } = await import('@forgeax/engine/render');
const { buildBloom2dWorld } = await import(resolve(here, '..', 'dist', 'bloom-2d.mjs')).catch(async () => import(resolve(here, '..', 'src', 'bloom-2d.ts')));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildBloom2dWorld(world);
console.log(`[bloom-2d] backend=${rendererBackend(renderer)} quads=${scene.quadCount} bright=${scene.brightCount}`);

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

function draw(count) {
  let drawErrors = 0;
  for (let i = 0; i < count; i += 1) {
    world.update().unwrap();
    if (!drawSmokeFrame(renderer, world).ok) drawErrors += 1;
  }
  return drawErrors;
}

world.set(scene.camera, Camera, { bloom: BLOOM_DISABLED });
const offErrors = draw(Math.max(1, Math.floor(frames / 3)));
const offPixels = await capture();
world.set(scene.camera, Camera, { bloom: BLOOM_ENABLED });
const onErrors = draw(Math.max(1, Math.floor(frames / 3)));
const onPixels = await capture();
const remaining = frames - Math.floor(frames / 3) * 2;
const tailErrors = draw(Math.max(0, remaining));
const passNames = renderer.inspect().perFramePassNames;

let totalDiff = 0;
let changedPixels = 0;
let visiblePixels = 0;
for (let i = 0; i < offPixels.length; i += 4) {
  const off = Math.abs(offPixels[i] - onPixels[i]) + Math.abs(offPixels[i + 1] - onPixels[i + 1]) + Math.abs(offPixels[i + 2] - onPixels[i + 2]);
  totalDiff += off;
  if (off > 3) changedPixels += 1;
  if (Math.max(onPixels[i], onPixels[i + 1], onPixels[i + 2]) > 12) visiblePixels += 1;
}
const diffMean = totalDiff / (width * height * 3);
const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(resolve(artifactDir, 'bloom-2d-off.png'), writeReferencePng(offPixels, width, height));
writeFileSync(resolve(artifactDir, 'bloom-2d-on.png'), writeReferencePng(onPixels, width, height));
console.log(`[smoke] frames=${frames} visiblePixels=${visiblePixels} bloomDiffMean=${diffMean.toFixed(4)} changedPixels=${changedPixels} errors=${errors.length + offErrors + onErrors + tailErrors} passes=${passNames.join(',')}`);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (visiblePixels < 100) failures.push(`visiblePixels=${visiblePixels}`);
if (diffMean <= 0.25 || changedPixels <= 20) failures.push(`bloomDiffMean=${diffMean.toFixed(4)} changedPixels=${changedPixels}`);
if (errors.length + offErrors + onErrors + tailErrors > 0) failures.push(`errors=${errors.length + offErrors + onErrors + tailErrors}`);
for (const pass of [
  'bloom-downsample-0',
  'bloom-downsample-1',
  'bloom-downsample-2',
  'bloom-downsample-3',
  'bloom-downsample-4',
  'bloom-upsample-3',
  'bloom-upsample-2',
  'bloom-upsample-1',
  'bloom-upsample-0',
  'bloom-composite',
]) if (!passNames.includes(pass)) failures.push(`missing=${pass}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  device.destroy?.();
  process.exit(1);
}
console.log('[smoke] PASS - 2D bright meshes visible and bloom on/off differs');
device.destroy?.();
delete globalThis.navigator.gpu;
