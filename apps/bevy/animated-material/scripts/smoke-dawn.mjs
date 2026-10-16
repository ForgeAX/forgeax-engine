#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FRAME_COUNT = Math.max(MIN_FRAMES, Math.ceil(Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10) / 16.67));
const FIXED_DT = 1 / 60;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const errors = [];

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({ size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x04 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
  return renderTarget;
}
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) { ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildAnimatedMaterialWorld, hslToRgb, stepAnimatedMaterials } = await import(resolve(root, 'src', 'animated-material.ts'));
const manifest = readFileSync(resolve(root, 'dist', 'shaders', 'manifest.json'), 'utf8');
let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` });
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildAnimatedMaterialWorld(world, WIDTH / HEIGHT);
const captures = [];
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;

async function capture(label) {
  await sharedDevice.queue.onSubmittedWorkDone();
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  const pngPath = resolve(root, 'artifacts', `frame-${label}.png`);
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, writeReferencePng(pixels, WIDTH, HEIGHT));
  captures.push({ label, pixels, pngPath });
}

for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const elapsed = process.env.FALSIFY === 'freeze-material' ? 0 : frame * FIXED_DT;
  stepAnimatedMaterials(world, scene, elapsed);
  world.update().unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) errors.push(draw.error);
  if (frame === 0) await capture('early');
  if (frame === FRAME_COUNT - 1) await capture('late');
}

function meanDelta(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (a.length / 4) / 765;
}
function maxLuma(pixels) {
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255);
  return max;
}
const early = captures[0];
const late = captures[1];
const pixelDelta = early && late ? meanDelta(early.pixels, late.pixels) : 0;
const lateLuma = late ? maxLuma(late.pixels) : 0;
const lateHue = process.env.FALSIFY === 'freeze-material' ? 0 : (FRAME_COUNT - 1) * FIXED_DT * 100;
const earlyColor = hslToRgb(0);
const lateColor = hslToRgb(lateHue);
const colorStateDelta = (Math.abs(earlyColor[0] - lateColor[0]) + Math.abs(earlyColor[1] - lateColor[1]) + Math.abs(earlyColor[2] - lateColor[2])) / 3;
console.log(`[bevy-animated-material] backend=${rendererBackend(renderer)}`);
console.log(`[smoke] frames observed=${FRAME_COUNT}`);
console.log(`[smoke] pixelDelta=${pixelDelta.toFixed(5)} colorStateDelta=${colorStateDelta.toFixed(5)} lateMaxLuma=${lateLuma.toFixed(4)}`);
for (const capture of captures) console.log(`[smoke] wrote PNG=${capture.pngPath}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)} (expected webgpu)`);
if (FRAME_COUNT < MIN_FRAMES) failures.push(`frames=${FRAME_COUNT} < ${MIN_FRAMES}`);
if (lateLuma <= 0.15) failures.push(`lateMaxLuma=${lateLuma.toFixed(4)} <= 0.15`);
if (pixelDelta <= 0.0005) failures.push(`pixelDelta=${pixelDelta.toFixed(5)} <= 0.0005 (material animation is not visible)`);
if (colorStateDelta <= 0.1) failures.push(`colorStateDelta=${colorStateDelta.toFixed(5)} <= 0.1 (hue animation is frozen)`);
if (errors.length > 0) failures.push(`RhiError count=${errors.length}: ${errors.map((error) => error.code).join(', ')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('[smoke] PASS - animated standard materials and renderer error gates are green');
sharedDevice.destroy?.();
