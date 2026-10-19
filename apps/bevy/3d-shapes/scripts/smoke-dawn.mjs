#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-3d-shapes headless dawn smoke — reproduces the app's 3d_shapes World in
// node-dawn and asserts a real lit render (standard-PBR + PointLight over the
// procedural-primitive gallery, incl. the new capsule at the row center).
//
// Mirrors apps/bevy/3d-scene/scripts/smoke-dawn.mjs for the GPU shim + readback.
// The World is built by the SHARED src/shapes.ts builder (imported here via
// Node's TS type-stripping) so this smoke and the browser app render the exact
// same scene — no duplicate-scene drift (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main). Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NDC-center pixel is NOT black — the CAPSULE sits at x=0 (row center) so
//       a not-black center proves createCapsuleGeometry produced a mesh the
//       standard-PBR path actually shaded (0 lights / wrong camera / a broken
//       capsule mesh would black the center: memory
//       smoke-camera-pose-untested-misses-cube-with-onerror-zero).
//   (d) Renderer.onError fired 0 times.
//
// A pixel-not-black check is necessary-but-not-sufficient (memory
// dawn-smoke-loose-threshold-masks-browser-black). This smoke ALSO writes the
// full frame to a PNG (SMOKE_PNG_OUT env, default artifacts/smoke-frame.png) so
// the solo loop reads it with its own eyes + compares to Bevy's 3d_shapes
// reference — the real acceptance is looking at the image.
//
// Output literals (grep-stable): `[bevy-3d-shapes] backend=webgpu`,
// `[smoke] frames observed=<N>`, `[smoke] pixelSamples=<json>`,
// `[smoke] wrote PNG=<path>`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;

// --- dawn.node binding setup ---
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
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- mock canvas + offscreen render target ---
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

// --- build the 3d_shapes World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const { buildShapesWorld } = await import(new URL('../src/shapes.ts', import.meta.url));

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-3d-shapes] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const placed = buildShapesWorld(world);
console.log(`[smoke] placed ${placed} shapes`);

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} (target=${TARGET_FRAMES})`);

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const bytes = new Uint8Array(readbackBuffer.getMappedRange().slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [(bytes[off] ?? 0) / 255, (bytes[off + 1] ?? 0) / 255, (bytes[off + 2] ?? 0) / 255];
};
const ndcCenter = readRgba(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const corner = readRgba(Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter, corner })}`);

// Dump the full frame to a PNG so the solo loop reads it with its own eyes and
// compares to Bevy's 3d_shapes reference (memory dawn-smoke-loose-threshold-
// masks-browser-black: a not-black pixel is not proof the RIGHT thing rendered).
try {
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const src = y * bytesPerRow;
    tight.set(bytes.subarray(src, src + WIDTH * 4), y * WIDTH * 4);
  }
  const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
  mkdirSync(dirname(pngOut), { recursive: true });
  writeFileSync(pngOut, encodePng(WIDTH, HEIGHT, tight));
  console.log(`[smoke] wrote PNG=${pngOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const dist = distance(ndcCenter, [0, 0, 0]);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) — lit capsule not visible`);
}
if (errors.length > 0) failures.push(`(d) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center distance to black=${dist.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
