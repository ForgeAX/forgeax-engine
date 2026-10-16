#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy `sprite_flipping`: three asymmetric sprite instances
// exercise identity, horizontal UV flip, and vertical UV flip.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 240;
const HEIGHT = 160;
const SPRITE_SIZE = 32;
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
const { Camera, MeshFilter, MeshRenderer, orthographic } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_QUAD } = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');

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
console.log(`[bevy-sprite-flipping] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const pixels = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
for (let y = 0; y < SPRITE_SIZE; y++) {
  for (let x = 0; x < SPRITE_SIZE; x++) {
    const off = (y * SPRITE_SIZE + x) * 4;
    const left = x < 16;
    const top = y < 16;
    const marker = (x < 10 || x >= 22) && (y < 10 || y >= 22);
    const markerColor = top
      ? left ? [230, 40, 40] : [40, 210, 70]
      : left ? [40, 90, 235] : [240, 200, 40];
    const inside = x >= 4 && x <= 27 && y >= 5 && y <= 26;
    const arrow = inside && ((x >= 8 && y <= 15) || (x >= 4 && y >= 18 && y <= 24));
    const color = marker ? markerColor : arrow ? [245, 164, 48] : [16, 24, 42];
    pixels[off] = color[0];
    pixels[off + 1] = color[1];
    pixels[off + 2] = color[2];
    pixels[off + 3] = marker || inside ? 255 : 0;
  }
}
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
const textureHandle = world.allocSharedRef('TextureAsset', texture);
const textureId = unwrapHandle(textureHandle);

const sampler = world.allocSharedRef('SamplerAsset', {
  kind: 'sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
});
const material = (flipX = 0, flipY = 0) => ({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 } }],
  parameters: [
    { name: 'colorTint', type: 'vec4' },
    { name: 'region', type: 'vec4', optional: true },
    { name: 'pivotAndSize', type: 'vec4' },
    { name: 'slicesAndMode', type: 'vec4', optional: true },
    { name: 'baseColorTexture', type: 'texture' },
  ],
  values: {
    colorTint: [1, 1, 1, 1],
    baseColorTexture: textureId,
    region: [flipX === 1 ? 1 : 0, flipY === 1 ? 1 : 0, flipX === 1 ? -1 : 1, flipY === 1 ? -1 : 1],
    pivotAndSize: [0.5, 0.5, 1, 1],
  },
});
const mats = [world.allocSharedRef('MaterialAsset', material()), world.allocSharedRef('MaterialAsset', material(1)), world.allocSharedRef('MaterialAsset', material(0, 1))];
for (const [x, mat] of [[-3, mats[0]], [0, mats[1]], [3, mats[2]]]) {
  world.spawn(
    { component: Transform, data: { pos: [x, 0, 0], scale: [2, 2, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [mat] } },
  );
}
world.spawn(
  { component: Transform, data: { pos: [0, 0, 10] } },
  { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
);

for (let i = 0; i < FRAMES; i++) {
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

const pixel = (x, y) => {
  const off = y * bytesPerRow + x * 4;
  return [bytes[off] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0];
};
const samples = {
  normalTopLeft: pixel(31, 61), normalTopRight: pixel(63, 61),
  flipXLeft: pixel(103, 61), flipXRight: pixel(135, 61),
  flipYTop: pixel(175, 61), flipYBottom: pixel(175, 98),
};
const png = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) png.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
const pngPath = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, writeReferencePng(png, WIDTH, HEIGHT));
console.log(`[smoke] frames=${FRAMES} samples=${JSON.stringify(samples)} errors=${errors.length} png=${pngPath}`);

const visible = [samples.normalTopLeft, samples.flipXLeft, samples.flipYTop].filter(([r, g, b]) => r + g + b > 90).length;
const normalHasDistinctSides = samples.normalTopLeft[2] > 150 && samples.normalTopRight[1] > 150;
const flipXHasSwappedSides = samples.flipXLeft[1] > 150 && samples.flipXRight[2] > 150;
const flipYHasSwappedVerticals = samples.flipYTop[0] > 150 && samples.flipYBottom[2] > 150;
if (rendererBackend(renderer) !== 'webgpu' || visible !== 3 || !normalHasDistinctSides || !flipXHasSwappedSides || !flipYHasSwappedVerticals || errors.length > 0) {
  console.error('[smoke] FAIL - backend/visibility/flip/error criterion failed');
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${FRAMES}, visibleSprites=${visible}, normal/flipX/flipY orientation checks green, errors=0`);
device.destroy?.();
