#!/usr/bin/env node
import { createSmokeRenderer, rendererBackend, subscribeSmokeErrors } from '../../scripts/renderer-smoke.mjs';
// Dawn smoke for the Bevy load_gltf reproduction.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const appRoot = resolve(here, '..');
const width = 200;
const height = 150;
const minFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const errors = [];

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
let device;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device ??= await originalRequestDevice(descriptor);
    return device;
  };
  return adapter;
};

let target;
function ensureTarget(nextDevice, format) {
  target ??= nextDevice.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return target;
}
const canvas = {
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure: (descriptor) => ensureTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'),
      unconfigure() {},
      getCurrentTexture: () => ensureTarget(device, 'rgba8unorm'),
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const manifest = readFileSync(resolve(appRoot, 'dist', 'shaders', 'manifest.json'), 'utf8');
const { World, createWorldContext } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { DirectionalLight, renderComponentsPlugin } = await import('@forgeax/engine-render');
const { Transform, scenePlugin, worldInstantiateScene } = await import('@forgeax/engine-scene');
const { gltfDocToSceneAsset, meshIrToMeshAsset, parseGltf, toMaterialAsset } = await import('@forgeax/engine-gltf');

const renderer = await createSmokeRenderer(
  createRenderer,
  canvas,
  {},
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` },
);
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const gltfPath = resolve(root, 'apps/hello/gltf/assets/box.gltf');
const docResult = await parseGltf(JSON.parse(readFileSync(gltfPath, 'utf8')), async () => {
  throw new Error('unexpected external buffer');
}, gltfPath);
if (!docResult.ok) throw new Error(`parseGltf failed: ${docResult.error.code}`);
const meshResult = meshIrToMeshAsset(docResult.value.meshes);
if (!meshResult.ok) throw meshResult.error;
const mesh = meshResult.value;
const materialIr = docResult.value.materials[0];
if (!materialIr) throw new Error('glTF has no material');
const material = toMaterialAsset(materialIr);
const world = new World();
await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const meshHandle = world.allocSharedRef('MeshAsset', mesh);
const materialHandle = world.allocSharedRef('MaterialAsset', material);
const scene = gltfDocToSceneAsset(docResult.value, {
  meshHandles: new Map([[0, meshHandle]]),
  materialHandles: new Map([[0, materialHandle]]),
});
const instanceResult = worldInstantiateScene(world, world.allocSharedRef('SceneAsset', scene));
if (!instanceResult.ok) throw new Error(`instantiate failed: ${instanceResult.error.code}`);
world.spawn(
  { component: Transform, data: { pos: [1.5, 2.5, 2.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: DirectionalLight, data: { direction: [0, -1, 0], intensity: 3 } },
);

const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
async function meanLuma() {
  await device.queue.onSubmittedWorkDone();
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 10) {
    for (let x = 0; x < width; x += 10) {
      const offset = y * bytesPerRow + x * 4;
      sum += (padded[offset] * 0.2126 + padded[offset + 1] * 0.7152 + padded[offset + 2] * 0.0722) / 255;
      count += 1;
    }
  }
  return sum / count;
}

let frames = 0;
for (; frames < minFrames; frames += 1) {
  world.update().unwrap();
  const result = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!result.ok) errors.push(result.error);
}
const luma = await meanLuma();
console.log(`[bevy-load-gltf] backend=${rendererBackend(renderer)}`);
console.log(`[smoke] frames observed=${frames} meanLuma=${luma.toFixed(4)} sceneEntities=${Object.keys(scene.entities).length}`);
if (rendererBackend(renderer) !== 'webgpu' || frames < minFrames || luma <= 0.02 || errors.length > 0) {
  console.error(`[smoke] FAIL - backend=${rendererBackend(renderer)} frames=${frames} meanLuma=${luma.toFixed(4)} errors=${errors.map((error) => error.code).join(',')}`);
  process.exit(1);
}
console.log('[smoke] PASS - real glTF parsed, SceneAsset instantiated, and rendered for the full frame gate');
device.destroy?.();
