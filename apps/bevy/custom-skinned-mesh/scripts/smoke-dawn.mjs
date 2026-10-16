#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const root = resolve(here, '..', '..', '..', '..');
const width = 320;
const height = 180;
const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
const requestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options);
  if (adapter === null) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device ??= await requestDevice(descriptor);
    return device;
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

// Dawn's async event runner keeps a Node process alive after the last frame.
// The smoke owns these resources, so close them at the terminal verdict and
// make the command's exit code reflect the verdict instead of leaking a
// runner until CI timeout.
function finishSmoke(code) {
  target?.destroy?.();
  device?.destroy?.();
  process.exit(code);
}

async function capture() {
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { buildWorld } = await import(resolve(appRoot, 'src/main.ts'));
const manifest = readFileSync(resolve(appRoot, 'dist/shaders/manifest.json'), 'utf8');
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` });
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const { createWorldContext } = await import('@forgeax/engine-ecs');
await createWorldContext(world, [scenePlugin()]);
const rigs = buildWorld(world);
const initialUpdate = world.update(0);
if (!initialUpdate.ok) throw new Error(`${initialUpdate.error.code}: ${initialUpdate.error.hint}`);
drawSmokeFrame(renderer, world);
await delay(30);
const earlyFrame = await capture();
const early = world.get(rigs[0].upper, Transform);
const earlyQuat = early.ok ? Array.from(early.value.quat) : [];
for (let frame = 1; frame < frames; frame++) {
  const update = world.update(1 / 60);
  if (!update.ok) throw new Error(`${update.error.code}: ${update.error.hint}`);
  const draw = drawSmokeFrame(renderer, world);
  if (!draw.ok) errors.push(draw.error);
}
await delay(30);
const lateFrame = await capture();
const late = world.get(rigs[0].upper, Transform);
const diff = (a, b) => {
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    const value = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += value;
    if (value > 3) pixels++;
  }
  return { pixels, mean: sum / (width * height) };
};
mkdirSync(resolve(appRoot, 'artifacts'), { recursive: true });
writeFileSync(resolve(appRoot, 'artifacts/frame-early.png'), writeReferencePng(earlyFrame, width, height));
writeFileSync(resolve(appRoot, 'artifacts/frame-late.png'), writeReferencePng(lateFrame, width, height));
const motion = diff(earlyFrame, lateFrame);
const lateQuat = late.ok ? Array.from(late.value.quat) : [];
const changed = Math.abs((lateQuat[2] ?? 0) - (earlyQuat[2] ?? 0)) > 0.01 || Math.abs((lateQuat[3] ?? 0) - (earlyQuat[3] ?? 0)) > 0.01;
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['two-joint-skin-rig', rigs.length === 6],
  ['joint-transform-animated', changed],
  ['render-motion-pixels', motion.pixels > 100],
  ['rhi-error-count=0', errors.length === 0],
];
let all = true;
for (const [name, ok] of checks) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) all = false; }
console.log(`[smoke] frames observed=${frames} motionMeanDelta=${motion.mean.toFixed(4)} jointQuat=${earlyQuat[2]?.toFixed(4)}->${lateQuat[2]?.toFixed(4)}`);
if (!all) { console.error(`[smoke] FAIL - motionPixels=${motion.pixels} errors=${errors.length}`); finishSmoke(1); }
console.log('[smoke] PASS');
finishSmoke(0);
