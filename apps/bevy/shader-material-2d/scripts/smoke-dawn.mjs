#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const FRAMES = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10), 60);
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const BYTES_PER_ROW = Math.ceil((WIDTH * 4) / 256) * 256;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
let target;
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= desc.device.createTexture({ size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
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
  if (adapter === null) return null;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const value = await requestDevice(descriptor);
    device ??= value;
    return value;
  };
  return adapter;
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { buildShaderMaterial2dWorld, makeTextureAsset, makeTexturePixels, TEXTURE_SIZE } = await import(resolve(root, 'src', 'scene.ts'));
const manifest = JSON.parse(readFileSync(resolve(root, 'dist', 'shaders', 'manifest.json'), 'utf8'));
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const shaderEntry = (manifest.materialShaders ?? []).find((entry) => entry?.identifier === 'bevy::shader_material_2d');
if (shaderEntry === undefined) throw new Error('shader_material_2d manifest entry missing');

const pixels = makeTexturePixels();
const texture = makeTextureAsset(pixels);
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const textureHandle = world.allocSharedRef('TextureAsset', texture);
buildShaderMaterial2dWorld(world, unwrapHandle(textureHandle), WIDTH / HEIGHT);

for (let frame = 0; frame < FRAMES; frame += 1) {
  world.update().unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`${draw.error.code}: ${draw.error.hint}`);
  await delay(0);
}
await device.queue.onSubmittedWorkDone();
const readback = device.createBuffer({ size: BYTES_PER_ROW * HEIGHT, usage: 0x01 | 0x08 });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
device.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const padded = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const framePixels = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y += 1) framePixels.set(padded.subarray(y * BYTES_PER_ROW, y * BYTES_PER_ROW + WIDTH * 4), y * WIDTH * 4);

let visiblePixels = 0;
let backgroundPixels = 0;
const colors = new Set();
for (let i = 0; i < framePixels.length; i += 4) {
  const r = framePixels[i] ?? 0;
  const g = framePixels[i + 1] ?? 0;
  const b = framePixels[i + 2] ?? 0;
  if (r + g + b > 45) visiblePixels += 1;
  if (r + g + b < 18) backgroundPixels += 1;
  colors.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
}
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(root, 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'shader-material-2d.png'), writeReferencePng(framePixels, WIDTH, HEIGHT));
console.log(`[smoke] frames=${FRAMES} visiblePixels=${visiblePixels} backgroundPixels=${backgroundPixels} colorBins=${colors.size} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (visiblePixels < 5000) failures.push(`visiblePixels=${visiblePixels} < 5000`);
if (backgroundPixels < 5000) failures.push(`backgroundPixels=${backgroundPixels} < 5000 (alpha mask may not discard)`);
if (colors.size < 8) failures.push(`colorBins=${colors.size} < 8`);
if (errors.length > 0) failures.push(`Renderer.onError=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${FRAMES}, custom 2D material and alpha mask are visible`);
device.destroy?.();
