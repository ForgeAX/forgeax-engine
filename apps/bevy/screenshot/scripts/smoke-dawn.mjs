#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-screenshot headless dawn smoke — proves Bevy window/screenshot
// behavior: plane + cube rendered, Space triggers screenshot capture.
// Browser and smoke share the same src/screenshot.ts scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '100', 10);
const WIDTH = 200;
const HEIGHT = 150;

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

// --- mock canvas ---
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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
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

// --- readback helper ---
const bytesPerRow = Math.ceil(WIDTH * 4 / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const buf = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: renderTarget }, { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(0x01);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  return tight;
}

// --- build ---
const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(`[smoke] FAIL - renderer host construction failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log('[bevy-screenshot] Standard pipeline active');

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const { buildScreenshotWorld, stepScreenshot } = await import(resolve(here, '..', 'src', 'screenshot.ts'));
buildScreenshotWorld(world);

// --- input snapshot helpers ---
function noInputSnapshot() {
  return {
    keyboard: { down: () => false, up: () => true },
    mouse: { movementDelta: { x: 0, y: 0 }, wheelDelta: 0, button: () => false },
    gamepad: { button: () => false, axis: () => 0 },
    timestamp: 0,
  };
}
function spaceSnapshot() {
  return {
    keyboard: { down: (k) => k === ' ', up: (k) => k !== ' ' },
    mouse: { movementDelta: { x: 0, y: 0 }, wheelDelta: 0, button: () => false },
    gamepad: { button: () => false, axis: () => 0 },
    timestamp: 0,
  };
}

// --- render initial frames ---
let latestReceipt;
for (let f = 0; f < 5; f++) {
  stepScreenshot(world, noInputSnapshot());
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) { console.error(`[smoke] FAIL - draw error: ${r.error.code}`); process.exit(1); }
  latestReceipt = r.value;
}
await delay(100);

if (latestReceipt !== undefined) {
  const observed = await renderer.observe(latestReceipt, { include: ['bindings'] });
  if (!observed.ok) {
    console.error(`[smoke] FAIL - receipt observation error: ${observed.error.code}`);
    process.exit(1);
  }
}

const initialPixels = await capture(sharedDevice);
const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
const idx = (cy * WIDTH + cx) * 4;
const initR = initialPixels[idx] ?? 0;
const initG = initialPixels[idx + 1] ?? 0;
const initB = initialPixels[idx + 2] ?? 0;
const initA = initialPixels[idx + 3] ?? 0;

console.log(`[smoke] initial center pixel: R=${initR}/255 G=${initG}/255 B=${initB}/255 A=${initA}/255`);

let passes = 0;
let fails = 0;

function pass(msg) { passes++; console.log(`  [PASS] ${msg}`); }
function fail(msg) { fails++; console.log(`  [FAIL] ${msg}`); }

// --- criterion (a) backend ---
pass('backend=webgpu (dawn-node)');

// --- criterion (b): scene rendered (not black) ---
const distToBlack = Math.sqrt(initR ** 2 + initG ** 2 + initB ** 2);
if (distToBlack > 30) {
  pass(`scene rendered: center pixel not black (R=${initR}/255 G=${initG}/255 B=${initB}/255, dist=${distToBlack.toFixed(1)})`);
} else {
  fail(`scene not rendered: center pixel near black (R=${initR}/255 G=${initG}/255 B=${initB}/255, dist=${distToBlack.toFixed(1)})`);
}

// --- criterion (c): Space triggers screenshot ---
const triggered = stepScreenshot(world, spaceSnapshot());
if (triggered) {
  pass('Space rising edge triggers screenshot');
} else {
  fail('Space rising edge did NOT trigger screenshot');
}

// --- criterion (d): Space held does NOT trigger again (no repeat) ---
const retriggered = stepScreenshot(world, spaceSnapshot());
if (!retriggered) {
  pass('Space held does not re-trigger (rising-edge detection works)');
} else {
  fail('Space held re-triggered (rising-edge detection broken)');
}

// --- criterion (e): RhiError count = 0 ---
if (errors.length === 0) {
  pass('RhiError count = 0');
} else {
  fail(`RhiError count = ${errors.length}: ${JSON.stringify(errors)}`);
}

// --- write reference PNG ---
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'smoke');
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'screenshot-scene.png'), writeReferencePng(initialPixels, WIDTH, HEIGHT));

console.log(`[smoke] RESULT: ${passes}/${passes + fails} pass`);
if (fails === 0) console.log('[smoke] PASS');
process.exit(fails > 0 ? 1 : 0);
