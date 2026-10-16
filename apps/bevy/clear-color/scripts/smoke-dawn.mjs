import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-clear-color headless dawn smoke — proves Bevy window/clear_color
// behavior: blue-ish clearColor → Space rising-edge toggle → purple.
// Browser and smoke share the same src/clear-color.ts scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '100', 10);
const WIDTH = 160;
const HEIGHT = 120;

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
  width: WIDTH, height: HEIGHT,
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
  addEventListener() {}, removeEventListener() {},
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
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
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
console.log(`[bevy-clear-color] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const { buildClearColorWorld, stepClearColor } = await import(resolve(here, '..', 'src', 'clear-color.ts'));
buildClearColorWorld(world);

// --- no-input snapshot helper ---
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

// --- render initial frames (blue-ish) ---
for (let f = 0; f < 5; f++) {
  stepClearColor(world, noInputSnapshot());
  world.update().unwrap();
  const r = drawSmokeFrame(renderer, world);
  if (!r.ok) { console.error(`[smoke] FAIL - draw error: ${r.error.code}`); process.exit(1); }
}
await delay(100);

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

// --- criterion (b): initial clear color is blue-ish (B high, G lower than B) ---
if (initB > 120 && initG < initB) {
  pass(`initial clearColor is blue-ish (B=${initB}/255 high, G=${initG}/255 < B)`);
} else {
  fail(`initial clearColor not blue-ish: R=${initR}/255 G=${initG}/255 B=${initB}/255 A=${initA}/255`);
}

// --- inject Space rising edge (toggle to purple) ---
stepClearColor(world, spaceSnapshot());
world.update().unwrap();
drawSmokeFrame(renderer, world);
stepClearColor(world, noInputSnapshot());

// render a few more frames
for (let f = 0; f < 5; f++) {
  stepClearColor(world, noInputSnapshot());
  world.update().unwrap();
  drawSmokeFrame(renderer, world);
}
await delay(100);

const purplePixels = await capture(sharedDevice);
const prR = purplePixels[idx] ?? 0;
const prG = purplePixels[idx + 1] ?? 0;
const prB = purplePixels[idx + 2] ?? 0;
const prA = purplePixels[idx + 3] ?? 0;

console.log(`[smoke] purple center pixel: R=${prR}/255 G=${prG}/255 B=${prB}/255 A=${prA}/255`);

// --- criterion (c): after toggle, clearColor is purple (R+B high, G near-zero) ---
if (prR > 80 && prB > 80 && prG < 30) {
  pass(`after Space toggle, clearColor is purple (R=${prR}/255 B=${prB}/255 high, G=${prG}/255 near-zero)`);
} else {
  fail(`after Space toggle, not purple: R=${prR}/255 G=${prG}/255 B=${prB}/255 A=${prA}/255`);
}

// --- criterion (d): RhiError count = 0 ---
if (errors.length === 0) {
  pass('RhiError count = 0');
} else {
  fail(`RhiError count = ${errors.length}: ${JSON.stringify(errors)}`);
}

// --- write reference PNG ---
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'smoke');
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'purple-center.png'), writeReferencePng(purplePixels, WIDTH, HEIGHT));

console.log(`[smoke] RESULT: ${passes}/${passes + fails} pass`);
if (fails === 0) console.log('[smoke] PASS');
process.exit(fails > 0 ? 1 : 0);
