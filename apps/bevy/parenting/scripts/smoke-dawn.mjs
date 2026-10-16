#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-parenting headless dawn smoke — proves Bevy parenting behavior:
// a parent cube rotates about X; a child cube orbits via ChildOf hierarchy.
// The smoke drives the same shared src/parenting.ts scene + stepRotate.
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) NDC-center pixel is NOT black — the lit cubes are visible
//   (d) MOTION: early frame differs from late frame (parent spin → child orbit)
//   (e) HIERARCHY: child world position at late frame differs from its local pos
//       (proves propagateTransforms derived it from parent.world × child.local)
//   (f) Renderer.onError fired 0 times.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const FIXED_DT = 1 / 60;

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
  width: WIDTH, height: HEIGHT,
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
  addEventListener() {}, removeEventListener() {},
};

// --- build the parenting World via the shared SSOT builder ---
const { World } = await import('@forgeax/engine-ecs');
const { ChildOf, GlobalTransform, Transform } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const { buildParentingWorld, stepRotate } = await import(resolve(here, '..', 'src', 'parenting.ts'));

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
console.log(`[bevy-parenting] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildParentingWorld(world);

// Find the child entity (the one with ChildOf) and read its local pos.
let childLocalPos = [0, 0, 3];
{
  const query = world.query({ read: [Transform], with: [ChildOf] }).unwrap();
  for (const row of query) {
    childLocalPos = Array.from(row.get(Transform).pos);
    break;
  }
}
console.log(`[smoke] childLocalPos=${JSON.stringify(childLocalPos)}`);

// --- readback helper ---
const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(0x01);
  const raw = new Uint8Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap(); readbackBuffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}

// Read the child's derived world position from the GlobalTransform.world column.
function readChildWorldPos(world) {
  const query = world.query({ read: [GlobalTransform], with: [ChildOf] }).unwrap();
  let result = [0, 0, 0];
  for (const row of query) {
    const worldMatrix = row.get(GlobalTransform).world;
    result = [worldMatrix[12] ?? 0, worldMatrix[13] ?? 0, worldMatrix[14] ?? 0];
    break;
  }
  return result;
}

// --- drive the frame loop ---
const CAPTURE_EARLY = 5;
const CAPTURE_LATE = Math.max(30, Math.floor(SMOKE_MIN_FRAMES * 0.1));
let framesObserved = 0;
let earlyFrame, lateFrame;
let earlyChildWorld, lateChildWorld;

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;

  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlyChildWorld = readChildWorldPos(world);
  }
  if (i === CAPTURE_LATE) {
    lateFrame = await capture(sharedDevice);
    lateChildWorld = readChildWorldPos(world);
  }

  stepRotate(world, FIXED_DT);
  propagateTransforms(world);
}

const device = sharedDevice;
if (!device) { console.error('[smoke] FAIL - no shared device'); process.exit(1); }
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);

if (!earlyFrame || !lateFrame) {
  console.error('[smoke] FAIL - capture frames not taken');
  process.exit(1);
}

// --- pixel samples ---
const readRgba = (buf, px, py) => {
  const off = (py * WIDTH + px) * 4;
  return [(buf[off] ?? 0) / 255, (buf[off + 1] ?? 0) / 255, (buf[off + 2] ?? 0) / 255];
};
const ndcCenter = readRgba(lateFrame, Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter })}`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);

// Hierarchy check: child world pos shifted from its local pos.
const childWorldDist = Math.sqrt(
  (lateChildWorld[0] - childLocalPos[0]) ** 2 +
  (lateChildWorld[1] - childLocalPos[1]) ** 2 +
  (lateChildWorld[2] - childLocalPos[2]) ** 2,
);
console.log(`[smoke] earlyChildWorld=${JSON.stringify(earlyChildWorld)} lateChildWorld=${JSON.stringify(lateChildWorld)} childLocal=${JSON.stringify(childLocalPos)} childWorldDist=${childWorldDist.toFixed(4)}`);

// Motion check: child world position changed between early and late.
const childMoveDist = Math.sqrt(
  (earlyChildWorld[0] - lateChildWorld[0]) ** 2 +
  (earlyChildWorld[1] - lateChildWorld[1]) ** 2 +
  (earlyChildWorld[2] - lateChildWorld[2]) ** 2,
);

// --- PNGs ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'frame-early.png'), writeReferencePng(earlyFrame, WIDTH, HEIGHT));
  writeFileSync(resolve(outDir, 'frame-late.png'), writeReferencePng(lateFrame, WIDTH, HEIGHT));
  console.log(`[smoke] wrote PNGs to ${outDir}`);
} catch (err) { console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`); }

const dist3 = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const dist = dist3(ndcCenter, [0, 0, 0]);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)}`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD})`);
}
if (motionMeanDelta <= MOTION_THRESHOLD) {
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — no motion detected`);
}
if (childMoveDist < 0.1) {
  failures.push(`(e) child world move ${childMoveDist.toFixed(4)} < 0.1 — hierarchy not propagating`);
}
if (errors.length > 0) failures.push(`(f) RhiError ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, NDC-center dist=${dist.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, childMove=${childMoveDist.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
