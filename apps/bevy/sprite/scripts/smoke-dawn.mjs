#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy `sprite`: one image-backed Sprite must produce varied visible pixels.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 240;
const HEIGHT = 160;
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
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!target) throw new Error('render target not configured');
        return target;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { SPRITE_SIZE, buildSpriteWorld, makeSpritePixels } = await import('../src/sprite.ts');

const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device = await originalRequestDevice(descriptor);
    return device;
  };
  return adapter;
};
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const pixels = makeSpritePixels();
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const texture = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: SPRITE_SIZE, height: SPRITE_SIZE } },
  format: 'rgba8unorm-srgb',
  data: pixels,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const handle = world.allocSharedRef('TextureAsset', texture);
buildSpriteWorld(world, unwrapHandle(handle));

for (let frame = 0; frame < FRAMES; frame++) {
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
}
await device.queue.onSubmittedWorkDone();
if (!target) throw new Error('render target was not allocated');

const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
device.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const bytes = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();

let visiblePixels = 0;
let channelSpreadPixels = 0;
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const offset = y * bytesPerRow + x * 4;
    const r = bytes[offset] ?? 0;
    const g = bytes[offset + 1] ?? 0;
    const b = bytes[offset + 2] ?? 0;
    if (r + g + b > 60) visiblePixels++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 30) channelSpreadPixels++;
  }
}
const png = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) png.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
const pngPath = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, writeReferencePng(png, WIDTH, HEIGHT));
console.log(`[smoke] frames=${FRAMES} visiblePixels=${visiblePixels} channelSpreadPixels=${channelSpreadPixels} errors=${errors.length} png=${pngPath}`);
if (rendererBackend(renderer) !== 'webgpu' || visiblePixels < 500 || channelSpreadPixels < 500 || errors.length > 0) {
  console.error('[smoke] FAIL - backend/visibility/color/error criterion failed');
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${FRAMES}, single image-backed sprite visible, errors=0`);
device.destroy?.();
