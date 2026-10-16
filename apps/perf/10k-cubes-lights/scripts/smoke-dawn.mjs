#!/usr/bin/env node
// Dawn smoke for the built consumer. The imported entry is the same Vite
// bundle served by the browser path; this harness only supplies a canvas,
// WebGPU, and a deterministic frame clock.

import { bindSmokeCanvasWindow } from '../../../../scripts/smoke-platform.mjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const distRoot = resolve(appRoot, 'dist');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.PERF_DAWN_FRAMES ?? '60', 10);
const requestedQuery = new URLSearchParams(process.env.PERF_QUERY ?? '');
// The app's default 180-frame profile window outlives the 60-frame smoke budget.
if (!requestedQuery.has('profileFrames')) requestedQuery.set('profileFrames', String(Math.max(1, Math.floor(targetFrames / 2))));
const query = `?${requestedQuery}`;
const outputPath = process.env.PERF_DAWN_OUTPUT ?? resolve(appRoot, 'artifacts', 'dawn.json');
const rawPath = process.env.PERF_DAWN_RAW ?? `${outputPath}.rgba`;
const screenshotPath = process.env.PERF_DAWN_SCREENSHOT ?? `${outputPath}.png`;
const requested = new URLSearchParams(query);
const expectedCubeCount = Number(requested.get('cubes') ?? 10_000);
const expectedPointLightCount = Number(requested.get('pointLights') ?? 16);
const expectedSpotLightCount = Number(requested.get('spotLights') ?? 16);
const expectedDirectionalBaseline = {
  count: 1,
  direction: [0.4, -0.8, -0.4],
  color: [1, 1, 1],
  intensity: 1,
  shadowCasterCount: 0,
};
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(rawPath), { recursive: true });
mkdirSync(dirname(screenshotPath), { recursive: true });

function fail(message) {
  console.error(`[perf-10k-cubes-lights/dawn] FAIL ${message}`);
  process.exit(1);
}

const entryName = readdirSync(resolve(distRoot, 'assets')).find((name) => /^main-.*\.js$/u.test(name));
if (entryName === undefined) fail('dist entry missing; run the app build first');
const entryPath = resolve(distRoot, 'assets', entryName);
const manifestBody = readFileSync(resolve(distRoot, 'shaders', 'manifest.json'), 'utf8');

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  fail(`webgpu import failed: ${error instanceof Error ? error.message : String(error)}`);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (...args) => {
  const adapter = await originalRequestAdapter(...args);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (...deviceArgs) => {
    const device = await originalRequestDevice(...deviceArgs);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width, height, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (renderTarget === undefined) {
          if (sharedDevice === undefined) throw new Error('Dawn render target requested before device capture');
          renderTarget = sharedDevice.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let rafQueue = [];
let rafId = 0;
let fakeNow = 0;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};
globalThis.performance.now = () => fakeNow;
const windowObject = { location: { search: query } };
globalThis.window = windowObject;
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.document = {
  querySelector: () => mockCanvas,
  querySelectorAll: () => [],
};
bindSmokeCanvasWindow(mockCanvas, globalThis.window, globalThis.document);
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/shaders/manifest.json')) {
    return new Response(manifestBody, { headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected fetch in Dawn smoke: ${url}`);
};

await import(`${pathToFileURL(entryPath).href}?dawnSmoke=${Date.now()}`);

const waitDeadline = Date.now() + 30_000;
while (globalThis.__forgeaxPerf === undefined && Date.now() < waitDeadline) await delay(10);
if (globalThis.__forgeaxPerf === undefined) fail('app did not finish bootstrap within 30s');

async function readback() {
  if (sharedDevice === undefined || renderTarget === undefined) fail('render target/device unavailable');
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  return pixels;
}

// The motion baseline sits inside the frame budget; sampling at the final frame compares a frame with itself.
const motionBaselineFrame = Math.max(1, Math.floor(targetFrames / 2));
let firstPixels;
let drivenRafCallbacks = 0;
const frameDeadline = Date.now() + 120_000;
while (globalThis.__forgeaxPerf.frameProgress < targetFrames && Date.now() < frameDeadline) {
  const frame = rafQueue.shift();
  if (frame === undefined) {
    await delay(1);
    continue;
  }
  fakeNow += 16.6667;
  frame.callback(fakeNow);
  drivenRafCallbacks += 1;
  if (firstPixels === undefined && globalThis.__forgeaxPerf.frameProgress >= motionBaselineFrame) {
    firstPixels = await readback();
  }
  if (drivenRafCallbacks % 16 === 0) await delay(1);
}
const observedFrames = globalThis.__forgeaxPerf.frameProgress;
if (observedFrames < targetFrames) {
  fail(`only observed ${observedFrames}/${targetFrames} engine frames after ${drivenRafCallbacks} RAF callbacks`);
}
const finalPixels = await readback();

function pixelStats(pixels) {
  let nonClearPixels = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += luma;
    sumSquares += luma * luma;
    if (r > 8 || g > 8 || b > 14) nonClearPixels += 1;
  }
  const count = pixels.length / 4;
  const meanLuma = sum / count;
  return { nonClearPixels, meanLuma, lumaVariance: sumSquares / count - meanLuma * meanLuma };
}

function pixelDelta(left, right) {
  let changedPixels = 0;
  let maxDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    const delta = Math.max(
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)),
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)),
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0)),
    ) / 255;
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 0.02) changedPixels += 1;
  }
  return { changedPixels, maxDelta };
}

function hasFixedDirectionalBaseline(value) {
  const baseline = value?.directionalBaseline;
  const closeTo = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6;
  return baseline?.count === expectedDirectionalBaseline.count
    && baseline.shadowCasterCount === expectedDirectionalBaseline.shadowCasterCount
    && closeTo(baseline.intensity, expectedDirectionalBaseline.intensity)
    && baseline.direction?.every((component, index) => closeTo(component, expectedDirectionalBaseline.direction[index]))
    && baseline.color?.every((component, index) => closeTo(component, expectedDirectionalBaseline.color[index]));
}

const evidence = globalThis.__forgeaxPerf;
const profile = evidence.profileCapture;
const profileComplete = profile?.completeness?.status === 'complete' && profile.completeness.droppedEventCount === 0;
const profilingExpected = new URLSearchParams(query).get('profile') !== '0';
const stats = pixelStats(finalPixels);
const motion = firstPixels === undefined ? { changedPixels: 0, maxDelta: 0 } : pixelDelta(firstPixels, finalPixels);
const result = {
  backend: 'webgpu',
  observedFrames,
  drivenRafCallbacks,
  evidence,
  profileComplete,
  readback: { width, height, ...stats, motion },
  assertions: {
    exactCubeCount: evidence.postSpawn.cubeCount === expectedCubeCount && evidence.processedCubeCount === expectedCubeCount,
    sharedMeshAndMaterial: evidence.postSpawn.meshHandleMatches === expectedCubeCount && evidence.postSpawn.materialHandleMatches === expectedCubeCount,
    punctualLightsPresent: evidence.postSpawn.pointLightCount === expectedPointLightCount && evidence.postSpawn.spotLightCount === expectedSpotLightCount,
    fixedDirectionalBaseline: hasFixedDirectionalBaseline(evidence.postSpawn),
    cameraAndCubeMotion: evidence.cameraRotationRadians > 0 && motion.changedPixels > width * height * 0.01,
    notClearOnly: stats.nonClearPixels > width * height * 0.01 && stats.lumaVariance > 0.00001,
    completeProfileNoDrops: !profilingExpected || profileComplete,
    noAppRendererErrors: evidence.appRendererErrors.length === 0,
  },
};
writeFileSync(outputPath, JSON.stringify(result, null, 2));
writeFileSync(rawPath, finalPixels);
writeFileSync(screenshotPath, writeReferencePng(finalPixels, width, height));

if (process.env.PERF_LIGHT_CONTROL !== '1') {
  const controlOutput = `${outputPath}.no-lights.json`;
  const controlRaw = `${outputPath}.no-lights.rgba`;
  const control = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: appRoot,
    env: { ...process.env, PERF_LIGHT_CONTROL: '1', PERF_QUERY: 'pointLights=0&spotLights=0&profile=0', PERF_DAWN_OUTPUT: controlOutput, PERF_DAWN_RAW: controlRaw, PERF_DAWN_SCREENSHOT: `${outputPath}.no-lights.png` },
    stdio: 'inherit',
  });
  if (control.status !== 0) fail(`no-light control run exited ${control.status}`);
  const controlResult = JSON.parse(readFileSync(controlOutput, 'utf8'));
  const controlPixels = readFileSync(controlRaw);
  result.zeroPunctualControl = {
    zeroPunctualPostSpawn: controlResult.evidence.postSpawn,
    delta: pixelDelta(finalPixels, controlPixels),
    distinguishesLightPayload: controlResult.evidence.postSpawn.pointLightCount === 0
      && controlResult.evidence.postSpawn.spotLightCount === 0
      && hasFixedDirectionalBaseline(controlResult.evidence.postSpawn)
      && pixelDelta(finalPixels, controlPixels).changedPixels > width * height * 0.01,
  };
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
}

const failed = Object.entries(result.assertions).filter(([, value]) => value !== true);
if (failed.length > 0) fail(`assertions failed: ${JSON.stringify(Object.fromEntries(failed))}`);
if (result.zeroPunctualControl !== undefined && !result.zeroPunctualControl.distinguishesLightPayload) fail('default vs zero-punctual readback did not distinguish punctual-light payload');
console.log(`[perf-10k-cubes-lights/dawn] PASS ${JSON.stringify({ observedFrames, stats, motion, profileComplete, zeroPunctualControl: result.zeroPunctualControl })}`);
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
if (process.env.PERF_LIGHT_CONTROL !== '1') emitSmokeReceipt('perf-10k-cubes-lights/smoke', observedFrames);
process.exit(0);
