#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for the Bevy update_gltf_scene reproduction.

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
  target ??= nextDevice.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x04 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
  return target;
}
const canvas = {
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return { configure: (descriptor) => ensureTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'), unconfigure() {}, getCurrentTexture: () => ensureTarget(device, 'rgba8unorm') };
  },
  addEventListener() {},
  removeEventListener() {},
};

const manifest = readFileSync(resolve(appRoot, 'dist', 'shaders', 'manifest.json'), 'utf8');
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, perspective, renderComponentsPlugin } = await import('@forgeax/engine-render');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { quat } = await import('@forgeax/engine-math');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { gltfDocToSceneAsset, meshIrToMeshAsset, parseGltf, toMaterialAsset } = await import('@forgeax/engine-gltf');
const { MovedScene, sceneDescendants, stepUpdateGltfScene } = await import(resolve(appRoot, 'src', 'update-gltf-scene.ts'));

const constructed = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` });
if (!constructed.ok) throw constructed.error;
const { renderer, assets } = constructed.value;
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const gltfPath = resolve(root, 'apps/hello/gltf/assets/box.gltf');
const metaPath = resolve(root, 'apps/hello/gltf/assets/box.gltf.meta.json');
const docResult = await parseGltf(JSON.parse(readFileSync(gltfPath, 'utf8')), async () => { throw new Error('unexpected external buffer'); }, gltfPath);
if (!docResult.ok) throw new Error(`parseGltf failed: ${docResult.error.code}`);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const guidFor = (kind) => {
  const raw = meta.subAssets.find((entry) => entry.kind === kind)?.guid;
  if (!raw) throw new Error(`missing ${kind} GUID`);
  const result = AssetGuid.parse(raw);
  if (!result.ok) throw new Error(`invalid ${kind} GUID`);
  return result.value;
};
const meshResult = meshIrToMeshAsset(docResult.value.meshes);
if (!meshResult.ok) throw meshResult.error;
const mesh = meshResult.value;
const materialIr = docResult.value.materials[0];
if (!materialIr) throw new Error('glTF has no material');
const material = toMaterialAsset(materialIr);
assets.catalog(guidFor('mesh'), mesh);
assets.catalog(guidFor('material'), material);
const world = new World();
await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const meshHandle = world.allocSharedRef('MeshAsset', mesh);
const materialHandle = world.allocSharedRef('MaterialAsset', material);
const meshNode = docResult.value.nodes[0];
const sceneDoc = meshNode === undefined ? docResult.value : { ...docResult.value, nodes: [meshNode], scenes: [{ ...docResult.value.scenes[docResult.value.defaultSceneIndex], nodes: [0] }], defaultSceneIndex: 0 };
const scene = gltfDocToSceneAsset(sceneDoc, { meshHandles: new Map([[0, meshHandle]]), materialHandles: new Map([[0, materialHandle]]) });
assets.catalog(guidFor('scene'), scene);
const sceneResult = await assets.loadByGuid(guidFor('scene'));
if (!sceneResult.ok) throw new Error(`loadByGuid failed: ${sceneResult.error.code}`);
const instanceResult = assets.instantiate(world.allocSharedRef('SceneAsset', sceneResult.value), world);
if (!instanceResult.ok) throw new Error(`instantiate failed: ${instanceResult.error.code}`);
const sceneRoot = instanceResult.value;
const marked = world.addComponent(sceneRoot, { component: MovedScene, data: {} });
if (!marked.ok) throw new Error(`mark scene failed: ${marked.error.code}`);
world.spawn({ component: Transform, data: { pos: [2, 2, 4], quat: quat.fromLookAt(quat.create(), [2, 2, 4], [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } }, { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) });
world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -1, -0.3], intensity: 5 } });

const descendants = sceneDescendants(world, sceneRoot);
if (descendants.length === 0) throw new Error('instantiated glTF scene has no descendants');
const moving = descendants[0];
stepUpdateGltfScene(world, 0);
const start = world.get(moving, Transform);
if (!start.ok) throw new Error('moving descendant has no Transform');
const startPos = [...start.value.pos];
stepUpdateGltfScene(world, 1);
const after = world.get(moving, Transform);
if (!after.ok) throw new Error('moving descendant Transform disappeared');
const motionDelta = Math.hypot((after.value.pos[0] ?? 0) - (startPos[0] ?? 0), (after.value.pos[2] ?? 0) - (startPos[2] ?? 0));

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
  for (let y = 0; y < height; y += 10) for (let x = 0; x < width; x += 10) {
    const offset = y * bytesPerRow + x * 4;
    sum += (padded[offset] * 0.2126 + padded[offset + 1] * 0.7152 + padded[offset + 2] * 0.0722) / 255;
    count += 1;
  }
  return sum / count;
}

let frames = 0;
for (; frames < minFrames; frames += 1) {
  stepUpdateGltfScene(world, frames / 60);
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) errors.push(result.error);
}
const luma = await meanLuma();
console.log('[bevy-update-gltf-scene] Standard pipeline active');
console.log(`[smoke] frames observed=${frames} meanLuma=${luma.toFixed(4)} descendants=${descendants.length} motionDelta=${motionDelta.toFixed(5)}`);
if (frames < minFrames || luma <= 0.02 || motionDelta <= 0.001 || errors.length > 0) {
  console.error(`[smoke] FAIL - frames=${frames} meanLuma=${luma.toFixed(4)} motionDelta=${motionDelta.toFixed(5)} errors=${errors.map((error) => error.code).join(',')}`);
  process.exit(1);
}
console.log('[smoke] PASS - SceneAsset descendants updated through Children and rendered for the full frame gate');
// Native Dawn teardown can block indefinitely after this reproduction's render
// graph has completed. The smoke is an isolated process, so exit after the
// evidence gate and let the OS reclaim the short-lived device resources.
process.exit(0);
