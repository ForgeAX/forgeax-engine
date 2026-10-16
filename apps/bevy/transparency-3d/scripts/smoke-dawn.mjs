#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy's 3d/transparency_3d example.
// The smoke renders the same shared World as the browser app, captures early and late
// frames, and proves that elapsed-time alpha changes the pixels rather than only the ECS.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FRAME_COUNT = Math.max(MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const FIXED_DT = 1 / 60;
const EARLY_FRAME = 0;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const errors = [];

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - webgpu import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
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
  renderTarget ??= device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
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
      getCurrentTexture() {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildTransparencyWorld, stepTransparencyAlpha } = await import(resolve(root, 'src', 'transparency-3d.ts'));
const manifest = readFileSync(resolve(root, 'dist', 'shaders', 'manifest.json'), 'utf8');
const manifestUrl = `data:application/json,${encodeURIComponent(manifest)}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.error(`[smoke] FAIL - createRenderer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildTransparencyWorld(world, WIDTH / HEIGHT);
const captures = [];
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;

async function capture(label) {
  await sharedDevice.queue.onSubmittedWorkDone();
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  const pngPath = resolve(root, 'artifacts', `frame-${label}.png`);
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, writeReferencePng(pixels, WIDTH, HEIGHT));
  captures.push({ label, pixels, pngPath });
}

for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const elapsed = process.env.FALSIFY === 'freeze-alpha' ? 0 : frame * FIXED_DT;
  stepTransparencyAlpha(world, scene, elapsed);
  world.update().unwrap();
  const draw = drawSmokeFrame(renderer, world);
  if (!draw.ok) errors.push(draw.error);
  if (frame === EARLY_FRAME) await capture('early');
  if (frame === FRAME_COUNT - 1) await capture('late');
}
await sharedDevice.queue.onSubmittedWorkDone();

function meanDelta(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (a.length / 4) / 765;
}

function maxLuma(pixels) {
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    max = Math.max(max, (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255);
  }
  return max;
}

const early = captures.find((capture) => capture.label === 'early');
const late = captures.find((capture) => capture.label === 'late');
const delta = early && late ? meanDelta(early.pixels, late.pixels) : 0;
const lateLuma = late ? maxLuma(late.pixels) : 0;
const earlyElapsed = process.env.FALSIFY === 'freeze-alpha' ? 0 : EARLY_FRAME * FIXED_DT;
const lateElapsed = process.env.FALSIFY === 'freeze-alpha' ? 0 : (FRAME_COUNT - 1) * FIXED_DT;
const alphaStateDelta = Math.abs(
  (Math.sin(lateElapsed) / 2 + 0.5) - (Math.sin(earlyElapsed) / 2 + 0.5),
);
console.log(`[bevy-transparency-3d] backend=${rendererBackend(renderer)}`);
console.log(`[smoke] frames observed=${FRAME_COUNT}`);
console.log(`[smoke] alphaMeanDelta=${delta.toFixed(5)} alphaStateDelta=${alphaStateDelta.toFixed(5)} lateMaxLuma=${lateLuma.toFixed(4)}`);
for (const capture of captures) console.log(`[smoke] wrote PNG=${capture.pngPath}`);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)} (expected webgpu)`);
if (FRAME_COUNT < MIN_FRAMES) failures.push(`frames=${FRAME_COUNT} < ${MIN_FRAMES}`);
if (lateLuma <= 0.15) failures.push(`lateMaxLuma=${lateLuma.toFixed(4)} <= 0.15`);
if (delta <= 0.0005) failures.push(`alphaMeanDelta=${delta.toFixed(5)} <= 0.0005 (alpha animation is not visible)`);
if (alphaStateDelta <= 0.1) failures.push(`alphaStateDelta=${alphaStateDelta.toFixed(5)} <= 0.1 (elapsed alpha is frozen)`);
if (errors.length > 0) failures.push(`RhiError count=${errors.length}: ${errors.map((error) => error.code).join(', ')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('[smoke] PASS - transparency geometry, alpha animation, and renderer error gates are green');
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
