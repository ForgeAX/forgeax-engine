#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Headless structural smoke for audio_control.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 200;
const HEIGHT = 150;
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let target;
function ensureTarget(device, format) {
  target ??= device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return target;
}
const canvas = {
  tagName: 'CANVAS', isConnected: true, width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { if (!target) ensureTarget(sharedDevice, 'rgba8unorm'); return target; },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app');
const { AUDIO_ENGINE_RESOURCE_KEY, audioBackendPlugin, audioPlugin, createAudioIntentBackend } = await import('@forgeax/engine-audio');
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildAudioControlWorld } = await import('../src/audio-control.ts');
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl });
gpu.requestAdapter = originalRequestAdapter;
const world = new World();
const audioBackend = createAudioIntentBackend({ emit: () => {} });
const appResult = await createApp({ platform: createSmokePlatform(canvas),  renderer, world, plugins: [audioBackendPlugin(audioBackend), audioPlugin()] });
if (!appResult.ok) throw new Error(`createApp failed: ${appResult.error.code}`);
const app = appResult.value;
const attachment = app.renderer.attach(app.world);
if (!attachment.ok) throw attachment.error;
const scene = buildAudioControlWorld(app.world, WIDTH / HEIGHT);
const errors = [];
app.onError((error) => errors.push(error));
let frames = 0;
let drawErrors = 0;
for (; frames < MIN_FRAMES; frames += 1) {
  app.world.update(1 / 60).unwrap();
  const result = drawSmokeFrame(app.renderer, app.world);
  if (!result.ok) drawErrors += 1;
  // This headless driver has no Host frame credit; drain each real submission.
  await sharedDevice.queue.onSubmittedWorkDone();
}
const hasAudioEngine = app.world.hasResource(AUDIO_ENGINE_RESOURCE_KEY);
console.log(`[audio-control] backend=${rendererBackend(app.renderer)} frames=${frames} audioResource=${hasAudioEngine} camera=${scene.camera} music=${scene.music}`);
const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < MIN_FRAMES) failures.push(`frames=${frames} < ${MIN_FRAMES}`);
if (!hasAudioEngine) failures.push('AudioEngine resource missing');
if (drawErrors > 0) failures.push(`draw errors=${drawErrors}`);
if (errors.length > 0) failures.push(`Renderer.onError=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice?.destroy?.();
  process.exit(1);
}
console.log('[smoke] PASS - structural audio resource, control scene, 60 draws, and RHI error gates are green.');
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
