#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const manifestPath = resolve(appRoot, 'dist', 'shaders', 'manifest.json');

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
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
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure: (descriptor) => ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'),
      unconfigure() {},
      getCurrentTexture: () => {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

if (!existsSync(manifestPath)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
const materialPackage = JSON.parse(
  readFileSync(resolve(appRoot, 'src', 'shader-defs.pack.json'), 'utf8'),
);
const redMaterialPackage = JSON.parse(
  readFileSync(resolve(appRoot, 'src', 'shader-defs-red.pack.json'), 'utf8'),
);
const material = materialPackage.assets?.find((asset) => asset?.kind === 'material')?.payload;
if (material === undefined) {
  console.error('[smoke] FAIL - shader-defs.pack.json has no material asset payload');
  process.exit(1);
}
const redMaterial = redMaterialPackage.assets?.find((asset) => asset?.kind === 'material')?.payload;
if (redMaterial === undefined) {
  console.error('[smoke] FAIL - shader-defs-red.pack.json has no material asset payload');
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { Transform } = await import('@forgeax/engine-scene');

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
} catch (error) {
  console.error(`[smoke] FAIL - createRenderer threw: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-shader-defs] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push({ code: error.code, hint: error.hint }));

const shaderId = material.passes[0].program.module;
const shaderEntry = (manifest.materialShaders ?? []).find(
  (entry) => entry?.identifier === shaderId,
);
if (shaderEntry === undefined) {
  console.error('[smoke] FAIL - bevy::shader_defs manifest entry missing');
  process.exit(1);
}
const redShaderId = redMaterial.passes[0].program.module;
const redShaderEntry = (manifest.materialShaders ?? []).find(
  (entry) => entry?.identifier === redShaderId,
);
if (redShaderEntry === undefined) {
  console.error('[smoke] FAIL - bevy::shader_defs_red manifest entry missing');
  process.exit(1);
}

const geometry = createBoxGeometry(1, 1, 1);
if (!geometry.ok) {
  console.error(`[smoke] FAIL - createBoxGeometry failed: ${geometry.error.code}`);
  process.exit(1);
}
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const mesh = world.allocSharedRef('MeshAsset', geometry.value);
const texture = world.allocSharedRef('TextureAsset', {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
  format: 'rgba8unorm',
  data: new Uint8Array([
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]),
  colorSpace: 'linear',
  mips: { kind: 'none' },
});
const makeMaterial = (sourceMaterial, baseColor) => world.allocSharedRef('MaterialAsset', {
  ...sourceMaterial,
  passes: sourceMaterial.passes.map((pass) => ({
    ...pass,
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  })),
  values: { baseColor: [...baseColor, 1], time: 0, speed: 1, baseColorTexture: texture },
});
const blue = makeMaterial(material, [0.05, 0.25, 1]);
const red = makeMaterial(redMaterial, [0.05, 1, 0.1]);
world.spawn(
  { component: Transform, data: { pos: [-0.9, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: mesh } },
  { component: MeshRenderer, data: { materials: [blue] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0.9, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: mesh } },
  { component: MeshRenderer, data: { materials: [red] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: Camera, data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
}).unwrap();

for (let frame = 0; frame < SMOKE_MIN_FRAMES; frame += 1) {
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) console.error(`[smoke] draw frame ${frame} error: ${result.error.code}`);
  await delay(0);
}
await sharedDevice.queue.onSubmittedWorkDone();

const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: renderTarget },
  { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
  { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
);
sharedDevice.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const bytes = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const pixel = (x, y) => {
  const offset = y * bytesPerRow + x * 4;
  return [bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0];
};
const left = pixel(67, 75);
const right = pixel(133, 75);
const tight = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y += 1) tight.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
const pngPath = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, writeReferencePng(tight, WIDTH, HEIGHT));

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (errors.length > 0) failures.push(`Renderer.onError=${JSON.stringify(errors)}`);
if (!(left[2] > left[0] && left[2] > left[1])) failures.push(`left cube is not blue: ${JSON.stringify(left)}`);
if (!(right[0] > right[1] && right[0] > right[2])) failures.push(`red module did not produce red: ${JSON.stringify(right)}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] frames observed=${SMOKE_MIN_FRAMES}`);
console.log(`[smoke] variantPixels=${JSON.stringify({ left, right })}`);
console.log(`[smoke] wrote PNG=${pngPath}`);
console.log('[smoke] PASS - blue and red module identities rendered their expected colors');
sharedDevice.destroy?.();
