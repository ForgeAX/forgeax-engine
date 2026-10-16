#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy `move_sprite`: a real sprite follows Time-driven motion,
// reaches both bounds, and reverses direction through the shared ECS step.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const FIXED_DT = 5 / FRAMES;
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
        target ??= desc.device.createTexture({ size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
      },
      unconfigure() {},
      getCurrentTexture() { if (!target) throw new Error('render target not configured'); return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { buildMoveSpriteWorld, makeSpritePixels, readSpriteMotion, SPRITE_SIZE, stepMoveSprite, MIN_X, MAX_X } = await import(resolve(here, '..', 'src', 'move-sprite.ts'));

const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => { device = await originalRequestDevice(descriptor); return device; };
  return adapter;
};
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
gpu.requestAdapter = originalRequestAdapter;
console.log(`[bevy-move-sprite] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const pixels = makeSpritePixels();
const texture = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: SPRITE_SIZE, height: SPRITE_SIZE } },
  format: 'rgba8unorm-srgb',
  data: pixels,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const textureHandle = world.allocSharedRef('TextureAsset', texture);
buildMoveSpriteWorld(world, unwrapHandle(textureHandle));

const positions = [];
const directions = [];
let earlyFrame;
let lateFrame;
async function capture() {
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap(); buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

for (let i = 0; i < FRAMES; i++) {
  const motion = readSpriteMotion(world);
  positions.push(motion.x);
  directions.push(Math.sign(motion.velocity));
  world.update().unwrap();
  const draw = drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`${draw.error.code}: ${draw.error.hint}`);
  if (i === 5) earlyFrame = await capture();
  if (i === FRAMES - 1) lateFrame = await capture();
  stepMoveSprite(world, FIXED_DT);
  propagateTransforms(world);
}

const minSeen = Math.min(...positions);
const maxSeen = Math.max(...positions);
let reversals = 0;
for (let i = 1; i < directions.length; i++) if (directions[i] !== directions[i - 1]) reversals++;
const bytesPerPixel = 4;
let motionDelta = 0;
for (let i = 0; i < earlyFrame.length; i++) motionDelta += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
motionDelta /= earlyFrame.length * 255;
const pngPath = resolve(here, '..', 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, writeReferencePng(lateFrame, WIDTH, HEIGHT));
console.log(`[smoke] frames=${FRAMES} minX=${minSeen.toFixed(3)} maxX=${maxSeen.toFixed(3)} reversals=${reversals} motionMeanDelta=${motionDelta.toFixed(5)} errors=${errors.length} png=${pngPath}`);
const visible = lateFrame.some((value, index) => index % bytesPerPixel === 3 && value > 0) || earlyFrame.some((value, index) => index % bytesPerPixel === 3 && value > 0);
if (rendererBackend(renderer) !== 'webgpu' || FRAMES < 60 || minSeen > MIN_X + 0.2 || maxSeen < MAX_X - 0.2 || reversals < 2 || motionDelta <= 0.0005 || !visible || errors.length > 0) {
  console.error('[smoke] FAIL - backend/frames/visibility/bounds/reversal/motion/error criterion failed');
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${FRAMES}, visible=1, bounds=[${minSeen.toFixed(3)},${maxSeen.toFixed(3)}], reversals=${reversals}, motionMeanDelta=${motionDelta.toFixed(5)}, errors=0`);
device.destroy?.();
