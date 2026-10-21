#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { rendererBackend, runSmokeAppFrames, subscribeSmokeErrors } from '../../scripts/renderer-smoke.mjs';
// Dawn smoke for Bevy's shader/fullscreen_material reproduction.
// FALSIFY=force-no-effect removes the post-process and must remove its pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const falsify = process.env.FALSIFY ?? '';
const effectId = 'bevy-fullscreen-material::chromatic';
const shaderPath = resolve(appRoot, 'src', 'fullscreen-material.wgsl');
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
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = rafId++;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};
let now = 0;
globalThis.performance.now = () => now;

const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
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

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { World } = await import('@forgeax/engine-ecs');
const { quat } = await import('@forgeax/engine-math');

const { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, PointLight, perspective } =
  await import('@forgeax/engine-render');
const { PostProcessParams } = await import('@forgeax/engine-render');
const { createFullscreenRenderFeature } = await import('@forgeax/engine-app');
const { Transform } = await import('@forgeax/engine-scene');

if (!existsSync(shaderPath)) {
  console.error(`[smoke] FAIL - missing fullscreen shader: ${shaderPath}`);
  process.exit(1);
}
const source = readFileSync(shaderPath, 'utf8');
const paramsBytes = new Uint8Array(new Float32Array([0.04, 0, 0, 0]).buffer);
const effect = createFullscreenRenderFeature({
  identity: effectId,
  source,
  reads: ['sceneColor'],
  params: { byteSize: 16, defaultValue: paramsBytes },
});
const appResult = await createApp(
  mockCanvas,
  { platform: createSmokePlatform(mockCanvas), features: falsify === 'force-no-effect' ? [] : [effect] },
  { shaderManifestUrl: manifestUrl },
);
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) {
  console.error(`[smoke] FAIL - createApp: ${appResult.error.code} - ${appResult.error.hint}`);
  process.exit(1);
}
const app = appResult.value;
subscribeSmokeErrors(app.renderer, (error) => errors.push(error));
app.onError((error) => errors.push(error));

const world = app.world;
const primitiveCube = world.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
const primitiveSphere = world.assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();
const blue = world.assets.create(Materials.standard({ baseColor: [0.08, 0.18, 0.8, 1], roughness: 0.3 })).unwrap();
const orange = world.assets.create(Materials.standard({ baseColor: [0.9, 0.24, 0.03, 1], roughness: 0.35 })).unwrap();
for (const [x, z, material] of [[-1.5, -1.5, blue], [1.5, -1.5, orange], [1.5, 1.5, blue], [-1.5, 1.5, orange]]) {
  world.spawn(
    { component: Transform, data: { pos: [x, 0.8, z], scale: [1.25, 1.25, 1.25] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [0, 2.7, 0], scale: [1.25, 1.25, 1.25] } },
  { component: MeshFilter, data: { assetHandle: primitiveSphere } },
  { component: MeshRenderer, data: { materials: [orange] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [4, 6, 4] } },
  { component: PointLight, data: { color: [1, 0.88, 0.72], intensity: 500, range: 40 } },
).unwrap();
world.spawn({ component: DirectionalLight, data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false } }).unwrap();
const eye = [8, 7, 9];
world.spawn(
  { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 1, 0], [0, 1, 0]) } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: width / height, near: 0.1, far: 80 }), clearColor: [0.03, 0.03, 0.05, 1] } },
).unwrap();

world.spawn({ component: PostProcessParams, data: { shader: effectId, data: paramsBytes } }).unwrap();

const frames = await runSmokeAppFrames(app, () => {
  const due = rafQueue.shift();
  if (!due) return false;
  now += 16.67;
  due.callback(now);
  return true;
}, targetFrames);
const passNames = [...app.renderer.inspect().perFramePassNames];

if (!sharedDevice || !renderTarget) {
  console.error('[smoke] FAIL - no Dawn device/render target');
  process.exit(1);
}
await sharedDevice.queue.onSubmittedWorkDone();
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: renderTarget },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height, depthOrArrayLayers: 1 },
);
sharedDevice.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const pixels = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();

const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(pixels.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, encodePng(width, height, tight));

let visiblePixels = 0;
let channelSpreadPixels = 0;
let maxLuma = 0;
for (let i = 0; i < tight.length; i += 4) {
  const r = tight[i] ?? 0;
  const g = tight[i + 1] ?? 0;
  const b = tight[i + 2] ?? 0;
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  maxLuma = Math.max(maxLuma, luma);
  if (r + g + b > 24) visiblePixels += 1;
  if (Math.max(r, g, b) - Math.min(r, g, b) > 14) channelSpreadPixels += 1;
}
const hasPostEffect = passNames.some((name) => name.startsWith('post-effect-'));
const failures = [];
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (visiblePixels < 1500) failures.push(`visiblePixels=${visiblePixels} < 1500`);
if (maxLuma <= 0.08) failures.push(`maxLuma=${maxLuma.toFixed(4)} <= 0.08`);
if (falsify === '' && channelSpreadPixels < 1500) failures.push(`channelSpreadPixels=${channelSpreadPixels} < 1500`);
if (falsify === 'force-no-effect' && hasPostEffect) failures.push(`FALSIFY kept the fullscreen pass: ${JSON.stringify(passNames)}`);
if (falsify !== 'force-no-effect' && !hasPostEffect) failures.push(`fullscreen material pass missing: ${JSON.stringify(passNames)}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
console.log(`[smoke] backend=${rendererBackend(app.renderer)}`);
console.log(`[smoke] frames=${frames} passNames=${JSON.stringify(passNames)}`);
console.log(`[smoke] visiblePixels=${visiblePixels} channelSpreadPixels=${channelSpreadPixels} maxLuma=${maxLuma.toFixed(4)} png=${pngOut}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - fullscreen material scene and falsifiable post-process path are visible');
process.exit(0);
