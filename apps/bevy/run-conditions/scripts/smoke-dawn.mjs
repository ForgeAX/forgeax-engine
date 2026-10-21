#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-run-conditions headless Dawn smoke.
// Proves the set-level gate stays closed before the time threshold, then opens;
// the system-level pulse condition fires exactly once after the gate opens.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FRAMES = Math.max(SMOKE_MIN_FRAMES, 60);
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (error) {
  console.error(`[smoke] FAIL - dawn-node create failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
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
    if (!sharedDevice) sharedDevice = device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
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
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (error) {
  console.error(`[smoke] FAIL - createRenderer threw: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-run-conditions] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push({ code: error.code, hint: error.hint }));

const { buildRunConditionsWorld, readRunConditionState, UNLOCK_SECONDS } = await import(
  resolve(here, '..', 'src', 'run-conditions.ts'),
);
const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const state = buildRunConditionsWorld(world);
let earlyFrame;
let lateFrame;
let beforeUnlock;
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;

async function capture() {
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
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}

for (let frame = 0; frame < FRAMES; frame++) {
  world.update(3 / FRAMES).unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) console.error(`[smoke] draw frame ${frame} error: ${draw.error.code}`);
  if (frame === Math.floor(FRAMES / 5)) {
    beforeUnlock = readRunConditionState(world, state);
    earlyFrame = await capture();
  }
  if (frame === FRAMES - 5) lateFrame = await capture();
}
await delay(50);
const finalState = readRunConditionState(world, state);
console.log(`[smoke] state=${JSON.stringify(finalState)}`);

let lateMaxBright = 0;
if (lateFrame) {
  for (let i = 0; i < lateFrame.length; i += 4) {
    lateMaxBright = Math.max(
      lateMaxBright,
      (lateFrame[i] ?? 0) / 255,
      (lateFrame[i + 1] ?? 0) / 255,
      (lateFrame[i + 2] ?? 0) / 255,
    );
  }
}
let motionMeanDelta = 0;
if (earlyFrame && lateFrame) {
  for (let i = 0; i < earlyFrame.length; i++) {
    motionMeanDelta += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
  }
  motionMeanDelta /= earlyFrame.length * 255;
}
console.log(`[smoke] lateFrameMaxBright=${lateMaxBright.toFixed(4)}`);
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)}`);

try {
  const output = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(output, { recursive: true });
  if (earlyFrame) writeFileSync(resolve(output, 'frame-early.png'), encodePng(WIDTH, HEIGHT, earlyFrame));
  if (lateFrame) writeFileSync(resolve(output, 'frame-late.png'), encodePng(WIDTH, HEIGHT, lateFrame));
} catch (error) {
  console.warn(`[smoke] PNG dump skipped: ${error instanceof Error ? error.message : String(error)}`);
}

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (!beforeUnlock || beforeUnlock.unlocked || beforeUnlock.gatedRuns !== 0 || beforeUnlock.skippedFrames === 0) {
  failures.push(`gate-opened-too-early=${JSON.stringify(beforeUnlock)}`);
}
if (!finalState.unlocked || finalState.elapsed < UNLOCK_SECONDS || finalState.gatedRuns === 0) {
  failures.push(`gate-never-opened=${JSON.stringify(finalState)}`);
}
if (finalState.alwaysRuns !== FRAMES) failures.push(`alwaysRuns=${finalState.alwaysRuns}, expected=${FRAMES}`);
if (finalState.pulseRuns !== 1) failures.push(`pulseRuns=${finalState.pulseRuns}, expected=1`);
if (lateMaxBright <= 0.15) failures.push(`lateFrameMaxBright=${lateMaxBright.toFixed(4)}`);
if (motionMeanDelta <= 0.0005) failures.push(`motionMeanDelta=${motionMeanDelta.toFixed(5)}`);
if (errors.length > 0) failures.push(`RhiErrors=${errors.map((error) => error.code).join(',')}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice.destroy?.();
  process.exit(1);
}
console.log(`[smoke] PASS - frames=${FRAMES}, gate-opened-after=${UNLOCK_SECONDS}s, gatedRuns=${finalState.gatedRuns}, pulseRuns=1, RhiError count=0`);
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
