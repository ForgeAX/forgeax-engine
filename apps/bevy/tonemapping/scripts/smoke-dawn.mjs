#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-tonemapping headless dawn smoke (pixel falsifier + structural gate).
// Strategy: render one shared HDR sphere field through all seven Camera tone-map
// modes; the modes must produce materially different readbacks.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
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
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const device = await originalRequestDevice(desc);
    sharedDevice ||= device;
    return device;
  };
  return rawAdapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
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

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera } = await import('@forgeax/engine-render');
const { TONEMAP_MODES, TONEMAP_NAMES, buildTonemappingWorld } = await import(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tonemapping.ts'));

const world = new World();
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: manifestUrl });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

console.log(`[tonemapping] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));

const scene = buildTonemappingWorld(world, WIDTH / HEIGHT);
console.log(`[tonemapping] scene spheres=${scene.sphereCount} modes=${TONEMAP_NAMES.join(',')}`);

async function capturePixels() {
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
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return pixels;
}

function diff(left, right) {
  let total = 0;
  let changedPixels = 0;
  for (let i = 0; i < left.length; i += 4) {
    const value = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]);
    total += value;
    if (value > 3) changedPixels += 1;
  }
  return { mean: total / (WIDTH * HEIGHT * 3), changedPixels };
}

const targetFrames = SMOKE_MIN_FRAMES;
const modeFrames = Math.max(1, Math.floor(targetFrames / TONEMAP_MODES.length));
let framesObserved = 0;
let drawErrors = 0;
const modePixels = [];
for (let i = 0; i < TONEMAP_MODES.length; i += 1) {
  const tonemap = TONEMAP_MODES[i];
  if (tonemap === undefined) continue;
  world.set(scene.camera, Camera, { tonemap });
  for (let frame = 0; frame < modeFrames; frame += 1) {
    world.update().unwrap();
    const result = drawSmokeFrame(renderer, world);
    if (!result.ok) drawErrors += 1;
    framesObserved += 1;
  }
  modePixels.push(await capturePixels());
}
const remainingFrames = targetFrames - framesObserved;
for (let frame = 0; frame < remainingFrames; frame += 1) {
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) drawErrors += 1;
  framesObserved += 1;
}

const artifactDir = resolve(here, '..', 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const nonePng = resolve(artifactDir, 'tonemap-none.png');
const agxPng = resolve(artifactDir, 'tonemap-agx.png');
writeFileSync(nonePng, writeReferencePng(modePixels[0], WIDTH, HEIGHT));
writeFileSync(agxPng, writeReferencePng(modePixels[5], WIDTH, HEIGHT));

const modeDiffs = modePixels.map((pixels, index) => diff(modePixels[0], pixels));
const distinctModes = modeDiffs.filter((value) => value.mean > 0.25 && value.changedPixels > 20).length;
const passNames = renderer.inspect().perFramePassNames;
const device = sharedDevice;
if (device) await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} distinctModes=${distinctModes} diffs=${modeDiffs.map((value, i) => `${TONEMAP_NAMES[i]}:${value.mean.toFixed(4)}/${value.changedPixels}`).join(',')} passes=${passNames.join(',')} none=${nonePng} agx=${agxPng}`);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) failures.push(`(c) Renderer.onError fired ${errors.length} times: [${errors.map((err) => err.code).join(', ')}]`);
if (drawErrors > 0) failures.push(`(c) draw returned ${drawErrors} errors`);
if (distinctModes < 3) failures.push(`(d) fewer than 3 tone-map modes changed pixels: ${distinctModes}`);
if (!passNames.includes('output-transform')) failures.push(`(e) missing output-transform pass; actual=${passNames.join(',')}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  await delay(0);
  device?.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - backend=webgpu, frames=${framesObserved}, distinctModes=${distinctModes}, RhiError count=0`);
device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
