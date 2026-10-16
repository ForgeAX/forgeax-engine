#!/usr/bin/env node
// LearnOpenGL framebuffers Dawn smoke through the Standard host.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../../shared/scripts/smoke-receipt.mjs';

const MIN_FRAMES = smokeFrameBudget();
const MODE_FRAMES = Math.ceil(MIN_FRAMES / 2);
const WIDTH = 512;
const HEIGHT = 512;
const EPSILON = 0.05;
const FALSIFY = process.env.FORGEAX_SMOKE_FALSIFY === '1';
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const repoRoot = resolve(appRoot, '..', '..', '..', '..');
const manifest = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
const errors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${error instanceof Error ? error.message : String(error)}`);
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
  isConnected: true,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
      },
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

if (!existsSync(manifest)) {
  originalConsoleError(`[smoke] FAIL - shader manifest missing at ${manifest}`);
  process.exit(1);
}
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`;

const { World } = await import('@forgeax/engine-ecs');
const { Transform } = await import('@forgeax/engine-scene');
const {
  Camera,
  MeshFilter,
  MeshRenderer,
  PostProcessParams,
  perspective,
} = await import('@forgeax/engine-render');
const { createFullscreenRenderFeature } = await import('@forgeax/engine-app');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');

const EFFECT_ID = 'learn-render-4-5::framebuffer-smoke-effect';
const EFFECT_SOURCE = `
struct Output { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32>, };
struct Params { mode : f32, pad0 : f32, pad1 : f32, pad2 : f32, };
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> Output {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; } if (i == 2u) { y = 3.0; }
  var out : Output; out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5); return out;
}
@group(1) @binding(0) var sourceTexture : texture_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(2) var<uniform> params : Params;
@fragment fn fs_main(in : Output) -> @location(0) vec4<f32> {
  let color = textureSample(sourceTexture, sourceSampler, in.uv).rgb;
  if (params.mode < 0.5) { return vec4<f32>(color, 1.0); }
  return vec4<f32>(1.0 - color, 1.0);
}`;
const effect = createFullscreenRenderFeature({
  identity: EFFECT_ID,
  source: EFFECT_SOURCE,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
});

let renderer;
try {
  const host = await constructRuntimeRendererHost(canvas, { features: [effect] }, { shaderManifestUrl: manifestUrl });
  if (!host.ok) throw host.error;
  renderer = host.value.renderer;
} catch (error) {
  originalConsoleError(`[smoke] FAIL - constructRendererHost failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });

const world = new World();
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const lease = attached.value;
const material = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } } }],
  values: { baseColor: [0.8, 0.4, 0.1, 1] },
});
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }) },
).unwrap();
const paramsEntity = world.spawn({
  component: PostProcessParams,
  data: { shader: EFFECT_ID, data: new Uint8Array(16) },
}).unwrap();

function setMode(mode) {
  world.set(paramsEntity, PostProcessParams, {
    data: new Uint8Array(new Float32Array([mode, 0, 0, 0]).buffer),
  });
}

async function readback(device) {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return { bytes, bytesPerRow };
}

function sample(bytes, bytesPerRow, x, y) {
  const offset = y * bytesPerRow + x * 4;
  return [bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0];
}

async function drawFrames(count) {
  let frames = 0;
  for (let index = 0; index < count; index++) {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    frames++;
    await sharedDevice.queue.onSubmittedWorkDone();
  }
  return frames;
}

if (!sharedDevice) {
  originalConsoleError('[smoke] FAIL - Dawn device was not created');
  process.exit(1);
}
setMode(0);
const framesA = await drawFrames(MODE_FRAMES);
const readA = await readback(sharedDevice);
setMode(1);
const framesB = await drawFrames(MODE_FRAMES);
const readB = await readback(sharedDevice);
const centerA = sample(readA.bytes, readA.bytesPerRow, WIDTH / 2, HEIGHT / 2);
const centerB = sample(readB.bytes, readB.bytesPerRow, WIDTH / 2, HEIGHT / 2);
const totalFrames = framesA + framesB;
const relation = centerA.map((value, index) => Math.abs(centerB[index] / 255 - (1 - value / 255)));
const geometryPresent = centerA.some((value) => value > 8);
const relationOK = relation.every((value) => value <= EPSILON);
console.log(`[smoke] frames observed=${totalFrames} (passthrough=${framesA}, inversion=${framesB})`);
console.log(`[smoke] center passthrough=[${centerA.join(',')}] inversion=[${centerB.join(',')}]`);

const failures = [];
if (totalFrames < MIN_FRAMES) failures.push(`frames=${totalFrames} < ${MIN_FRAMES}`);
if (!geometryPresent) failures.push(`passthrough center is empty: ${centerA.join(',')}`);
if (FALSIFY ? relationOK : !relationOK) {
  failures.push(FALSIFY ? 'FALSIFY expected inversion relation to fail' : `inversion relation exceeded epsilon: ${relation.join(',')}`);
}
if (errors.length > 0) failures.push(`RhiError count=${errors.length}: ${JSON.stringify(errors.slice(0, 3))}`);
if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice.destroy?.();
  process.exit(1);
}
console.log(`[smoke] PASS - frames=${totalFrames}, Standard host lease/receipt, inversion epsilon=${EPSILON}`);
emitSmokeReceipt('learn-render-framebuffers/direct-dawn', totalFrames);
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
