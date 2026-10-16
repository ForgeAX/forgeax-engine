#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = 320;
const height = 180;
const here = dirname(fileURLToPath(import.meta.url));
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
const requestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const result = await requestDevice(descriptor);
    device ??= result;
    return result;
  };
  return adapter;
};

let target;
const canvas = {
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x11, viewFormats: ['rgba8unorm-srgb'] });
      },
      unconfigure() {},
      getCurrentTexture() { if (!target) throw new Error('render target is not configured'); return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

async function capture() {
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
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

const { World } = await import('@forgeax/engine-ecs');
const { animationPlugin } = await import('@forgeax/engine-animation');
const { scenePlugin } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const {
  buildEasedMotionWorld,
  createEasedMotionClip,
  EASED_MOTION_CLIP_GUID,
  readEasedMotionState,
} = await import(resolve(here, '..', 'src', 'eased-motion.ts'));
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push({ code: error.code, hint: error.hint }));

const { createWorldContext } = await import('@forgeax/engine-ecs');
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const clip = createEasedMotionClip();
const clips = new Map([[EASED_MOTION_CLIP_GUID, clip]]);
await createWorldContext(world, [scenePlugin(), animationPlugin((guid) => clips.get(guid))]);
const state = buildEasedMotionWorld(world, clip);
world.update(0);
drawSmokeFrame(renderer, world);
await delay(30);
const earlyFrame = await capture();
const earlyState = readEasedMotionState(world, state);
for (let frame = 1; frame < frames; frame++) {
  world.update(1 / 60);
  drawSmokeFrame(renderer, world);
}
await delay(30);
const lateFrame = await capture();
const lateState = readEasedMotionState(world, state);

function diff(a, b) {
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    const value = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += value;
    if (value > 3) pixels++;
  }
  return { pixels, mean: sum / (width * height) };
}

mkdirSync(resolve(here, '..', 'artifacts'), { recursive: true });
writeFileSync(resolve(here, '..', 'artifacts', 'frame-early.png'), writeReferencePng(earlyFrame, width, height));
writeFileSync(resolve(here, '..', 'artifacts', 'frame-late.png'), writeReferencePng(lateFrame, width, height));
const motion = diff(earlyFrame, lateFrame);
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['eased-translation-animated', Math.abs((lateState.pos[0] ?? 0) - (earlyState.pos[0] ?? 0)) > 0.01],
  ['eased-rotation-animated', Math.abs((lateState.quat[1] ?? 0) - (earlyState.quat[1] ?? 0)) > 0.01],
  ['render-motion-pixels', motion.pixels > 100],
  ['rhi-error-count=0', errors.length === 0],
];
let all = true;
for (const [name, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) all = false; }
console.log(`[smoke] frames observed=${frames} motionMeanDelta=${motion.mean.toFixed(4)}`);
if (!all) { console.error(`[smoke] FAIL - motionPixels=${motion.pixels} errors=${errors.length}`); process.exit(1); }
console.log('[smoke] PASS');
