#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = 320;
const height = 180;
const dt = 1 / 60;

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

let device;
let target;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const canvas = {
  width, height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (!target) {
          target = desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
        }
        device ??= desc.device;
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
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
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const here = dirname(fileURLToPath(import.meta.url));
const { buildRotationWorld, readRotationState, stepRotationWorld } = await import(resolve(here, '..', 'src', 'rotation.ts'));
const manifest = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.error(`[smoke] FAIL - renderer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildRotationWorld(world);
propagateTransforms(world);
const noInput = {
  keyboard: { down: () => false, up: () => true, pressed: () => false, released: () => true },
  mouse: { movementDelta: { x: 0, y: 0 }, wheelDelta: 0, button: () => false },
  gamepad: { button: () => false, axis: () => 0 },
  timestamp: 0,
};

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
  for (let y = 0; y < height; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

let early;
let late;
let earlyState;
let lateState;
for (let i = 0; i < frames; i++) {
  world.update().unwrap();
  const drawn = drawSmokeFrame(renderer, world);
  if (!drawn.ok) console.error(`[smoke] draw ${i}: ${drawn.error.code}`);
  if (i === Math.max(1, Math.floor(frames * 0.05))) {
    early = await capture();
    earlyState = readRotationState(world);
  }
  if (i === Math.max(1, Math.floor(frames * 0.65))) {
    late = await capture();
    lateState = readRotationState(world);
  }
  stepRotationWorld(world, dt, noInput);
  propagateTransforms(world);
}

if (!device || !early || !late || !earlyState || !lateState) {
  console.error('[smoke] FAIL - incomplete frame/state evidence');
  process.exit(1);
}
let bright = 0;
for (let i = 0; i < early.length; i += 4) bright = Math.max(bright, early[i] ?? 0, early[i + 1] ?? 0, early[i + 2] ?? 0);
let delta = 0;
for (let i = 0; i < early.length; i++) delta += Math.abs((early[i] ?? 0) - (late[i] ?? 0));
const motionMeanDelta = delta / early.length / 255;
const positionDelta = Math.hypot(lateState.player[0] - earlyState.player[0], lateState.player[1] - earlyState.player[1]);
const snapDelta = lateState.snap.some((value, index) => Math.abs(value - earlyState.snap[index]) > 1e-4);
const rotateDelta = lateState.rotate.some((value, index) => Math.abs(value - earlyState.rotate[index]) > 1e-4);
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'rotation-early.png'), writeReferencePng(early, width, height));
writeFileSync(resolve(outDir, 'rotation-late.png'), writeReferencePng(late, width, height));
console.log(`[smoke] frames=${frames} bright=${(bright / 255).toFixed(4)} motionMeanDelta=${motionMeanDelta.toFixed(5)} positionDelta=${positionDelta.toFixed(3)} snapChanged=${snapDelta} rotateChanged=${rotateDelta} errors=${errors.length}`);
const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < 60) failures.push(`frames=${frames}`);
if (bright / 255 <= 0.15) failures.push(`bright=${(bright / 255).toFixed(4)}`);
if (motionMeanDelta <= 0.0005) failures.push(`motionMeanDelta=${motionMeanDelta.toFixed(5)}`);
if (positionDelta <= 1) failures.push(`positionDelta=${positionDelta.toFixed(3)}`);
if (!snapDelta) failures.push('snap-to-player orientation did not change');
if (!rotateDelta) failures.push('rotate-to-player orientation did not change');
if (errors.length > 0) failures.push(`RhiError=${errors.length}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${frames}, motion=${motionMeanDelta.toFixed(5)}, player-moved, snap/rotate tracking changed, errors=0`);
device.destroy?.();
