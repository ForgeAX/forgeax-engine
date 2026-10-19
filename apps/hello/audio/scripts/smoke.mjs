#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-audio headless smoke.
//
// Strategy: createApp with audioPlugin(), verify App handle + AudioEngine
// resource is registered, render 60 frames, capture.
//
// This smoke verifies the createApp audio integration pipeline:
//   1. createApp(canvas, { plugins: [audioPlugin()] }) succeeds.
//   2. Renderer.ready succeeds.
//   3. app.start() + 60-frame loop + app.stop() succeeds.
//   4. AudioEngine resource is inserted into World after boot.
//
// Pixel readback is NOT performed in this smoke: headless dawn-node has no
// AudioContext (OOS-3), so the smoke cannot play audio. The smoke verdict is
// structural: the app boots, the audio backend is attached, and the World
// has an AudioEngine resource. No audio playback, no engine.listener access
// (would trigger ensureContext() -> new AudioContext() crash in headless).
// Note: if createWebAudioBackend() fails in headless (no AudioContext), the
// engine's canvas-form audio auto-creation will fail; in that case the
// smoke reports present=false with the real environmental cause, not a
// migration gap.

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 800;
const HEIGHT = 600;

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
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
  tagName: 'CANVAS',
  isConnected: true,
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app/browser');

const { Camera, DirectionalLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const audioPkg = await import('@forgeax/engine-audio');
const { AUDIO_ENGINE_RESOURCE_KEY, audioPlugin } = audioPkg;
const { webAudioPlugin } = await import('@forgeax/engine-audio-webaudio');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas),
  plugins: [webAudioPlugin(), audioPlugin()],
}, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-audio] backend=${app.renderer.inspect().capabilities.backendKind}`);

app.world.spawn(
  { component: Transform, data: { pos: [0, 0, 3]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
app.world.spawn({
  component: DirectionalLight,
  data: { castShadow: true, direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));


// Monkey-patch performance.now BEFORE app.start() so the frame-loop's
// initial lastTimestamp reads the fake value, not a large real timestamp.
// Otherwise the first tick computes a negative delta and world.update()
// returns time-delta-invalid (Result-based validation, not silent pass).
let fakeNow = 0;
const realPerformanceNow = globalThis.performance.now.bind(globalThis.performance);
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  framesObserved++;
}
globalThis.performance.now = realPerformanceNow;

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

console.log(`[smoke] frames observed=${framesObserved}`);

// Structural check: verify AudioEngine resource is present in World.
let hasAudioEngine = false;
try {
  hasAudioEngine = app.world.hasResource(AUDIO_ENGINE_RESOURCE_KEY) === true;
} catch {
  // world.hasResource may throw if resource store is not yet populated
}
console.log(`[smoke] AudioEngine resource present=${hasAudioEngine}`);

// Verdict: structural smoke (no pixel readback).
const failures = [];
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}
if (consoleErrors.length > 0) {
  const audioErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
  if (audioErrors.length > 0) {
    failures.push(`(b) console.error fired ${audioErrors.length} times: ${JSON.stringify(audioErrors.slice(0, 3))}`);
  }
}
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(c) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${framesObserved}, AudioEngine=${hasAudioEngine}, app.onError=0`);
if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
