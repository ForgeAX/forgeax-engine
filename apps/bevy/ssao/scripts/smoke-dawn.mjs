#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-ssao headless Dawn smoke (receipt-bound structural + pixel falsifier).
// The same occlusion-heavy scene is rendered with Standard SSAO disabled and
// enabled. The readbacks must differ and both runs must complete the 60-frame
// gate without renderer errors.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const device = await originalRequestDevice(desc);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

const renderTargets = new Map();
function ensureRenderTarget(device, format, label = 'default') {
  const existing = renderTargets.get(label);
  if (existing !== undefined) return existing.texture;
  const texture = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTargets.set(label, { device, texture });
  return texture;
}

const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTargets.has('default')) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTargets.get('default').texture;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const { World } = await import('@forgeax/engine-ecs');
const { DEFAULT_STANDARD_PROFILE } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { rhi } = await import('@forgeax/engine-rhi-webgpu');
const { buildSsaoWorld } = await import(resolve(here, '..', 'src', 'ssao.ts'));

async function createStandardRenderer(ssao, label) {
  let configuredDevice;
  const canvas = {
    ...mockCanvas,
    getContext(kind) {
      const context = mockCanvas.getContext(kind);
      if (context === null) return null;
      return {
        ...context,
        configure(desc) {
          configuredDevice = desc.device;
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm', label);
        },
        getCurrentTexture() {
          if (!configuredDevice) throw new Error(`canvas ${label} is not configured`);
          return ensureRenderTarget(configuredDevice, 'rgba8unorm', label);
        },
      };
    },
  };
  return {
    ok: true,
    value: await createSmokeRenderer(
      createRenderer,
      canvas,
      {
        rhi,
          standardProfile: {
            ...DEFAULT_STANDARD_PROFILE,
            renderPath: 'deferred',
            ssao,
        },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  };
}

async function capturePixels(entry) {
  await entry.device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const readback = entry.device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = entry.device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: entry.texture },
    { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  entry.device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return pixels;
}

function meanByteDiff(left, right) {
  let total = 0;
  let changedPixels = 0;
  for (let i = 0; i < left.length; i += 4) {
    const diff = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]);
    total += diff;
    if (diff > 3) changedPixels += 1;
  }
  return { mean: total / (WIDTH * HEIGHT * 3), changedPixels };
}

const targetFrames = Math.max(SMOKE_MIN_FRAMES, 60);
async function runVariant(ssao, label) {
  const constructed = await createStandardRenderer(ssao, label);
  if (!constructed.ok) throw constructed.error;
  const renderer = constructed.value;
  const errors = [];
  subscribeSmokeErrors(renderer, (err) => errors.push(err));
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const scene = buildSsaoWorld(world, WIDTH / HEIGHT);
  console.log(`[bevy-ssao] ${label} scene meshes=${scene.meshCount}`);
  let framesObserved = 0;
  let drawErrors = 0;
  let latestReceipt;
  for (let i = 0; i < targetFrames; i += 1) {
    world.update().unwrap();
    const result = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!result.ok) {
      drawErrors += 1;
      throw new Error(`${label} frame ${framesObserved}: ${JSON.stringify({ error: result.error, events: errors })}`);
    } else {
      latestReceipt = result.value;
      // A receipt acknowledges submission. Fence every measured frame so this
      // fixed-frame carrier cannot queue 300 frames of retained GPU resources.
      const completed = await result.value.completed;
      if (!completed.ok) throw new Error(`${label} completion: ${JSON.stringify(completed.error)}`);
    }
    framesObserved += 1;
  }
  if (latestReceipt === undefined) throw new Error(`${label} produced no FrameReceipt`);
  const observed = await renderer.observe(latestReceipt, { include: ['timings', 'draws', 'bindings'] });
  if (!observed.ok) throw observed.error;
  const inspection = renderer.inspect();
  const entry = renderTargets.get(label);
  if (entry === undefined) throw new Error(`${label} render target was not configured`);
  const pixels = await capturePixels(entry);
  attached.value.dispose();
  renderer.dispose();
  return { pixels, errors, drawErrors, framesObserved, observed: observed.value, inspection };
}

const off = await runVariant(false, 'ssao-off');
const on = await runVariant(true, 'ssao-on');
const ssaoOffPixels = off.pixels;
const ssaoOnPixels = on.pixels;

const diff = meanByteDiff(ssaoOffPixels, ssaoOnPixels);
const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const offPng = resolve(artifactDir, 'ssao-off.png');
const onPng = resolve(artifactDir, 'ssao-on.png');
writeFileSync(offPng, writeReferencePng(ssaoOffPixels, WIDTH, HEIGHT));
writeFileSync(onPng, writeReferencePng(ssaoOnPixels, WIDTH, HEIGHT));

console.log(`[smoke] frames observed=${off.framesObserved + on.framesObserved} ssaoDiffMean=${diff.mean.toFixed(4)} changedPixels=${diff.changedPixels} receiptFrames=${off.observed.frameId},${on.observed.frameId} off=${offPng} on=${onPng}`);

const failures = [];
if (off.inspection.capabilities.backendKind !== 'webgpu' || on.inspection.capabilities.backendKind !== 'webgpu') failures.push('(a) Standard host backend is not webgpu');
if (off.framesObserved < SMOKE_MIN_FRAMES || on.framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${off.framesObserved},${on.framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (off.errors.length > 0 || on.errors.length > 0) failures.push(`(c) Renderer.onError fired ${off.errors.length + on.errors.length} times`);
if (off.drawErrors > 0 || on.drawErrors > 0) failures.push(`(c) draw returned ${off.drawErrors + on.drawErrors} errors`);
if (diff.mean <= 0.05 || diff.changedPixels <= 20) failures.push(`(d) SSAO on/off diff too small: mean=${diff.mean.toFixed(4)}, changedPixels=${diff.changedPixels}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  sharedDevice.destroy?.();
  process.exit(1);
}

console.log('[smoke] PASS - Standard backend, 60 frames per lane, receipt observation, zero errors, and SSAO pixel discrimination are GREEN');
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
await delay(0);
process.exit(0);
