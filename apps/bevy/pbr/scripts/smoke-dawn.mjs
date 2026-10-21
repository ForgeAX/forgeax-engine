#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-pbr headless dawn smoke — proves Bevy PBR behavior:
// 11×5 sphere grid with metallic (0→1 bottom-to-top) and roughness
// (0→1 left-to-right) varying per sphere, plus unlit sphere,
// DirectionalLight, orthographic camera. Static render.
//
// Verdict criteria:
//   (a) backend === 'webgpu'
//   (b) frames >= SMOKE_MIN_FRAMES
//   (c) center-region has lit pixels — the lit grid is visible
//   (d) earlyMaxBright > 0.03 — DirectionalLight produces lit pixels
//   (e) roughness variance > 0 — left/right spheres differ (roughness gradient visible)
//   (f) RhiError count = 0

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

// --- build the PBR World inline (Node can't import .ts) ---
const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials, Skylight } = await import('@forgeax/engine-render');
const { orthographic } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const { quat } = await import('@forgeax/engine-math');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-pbr] backend=${rendererBackend(renderer)}`);

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


const GOLD = [1.0, 0.847, 0.569, 1.0];

const world = new World({ assets: smokeAssets });
const primitiveSphere = world.assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// ── 11×5 PBR sphere grid (x: -5..5, y: -2..2) ─────────────────────────
for (let y = -2; y <= 2; y++) {
  for (let x = -5; x <= 5; x++) {
    const x01 = (x + 5) / 10; // roughness: 0→1 left-to-right
    const y01 = (y + 2) / 4;  // metallic: 0→1 bottom-to-top
    const mat = world.assets.create(Materials.standard({ baseColor: GOLD, metallic: y01, roughness: x01 })).unwrap();
    world.spawn(
      { component: Transform, data: { pos: [x, y + 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: primitiveSphere } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
  }
}

// ── Unlit sphere below the grid at (-5, -2.5, 0) ──────────────────────
const unlitMat = world.assets.create(Materials.unlit(GOLD)).unwrap();
world.spawn(
  { component: Transform, data: { pos: [-5, -2.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: primitiveSphere } },
  { component: MeshRenderer, data: { materials: [unlitMat] } },
);

// ── DirectionalLight ─────────────────────────────────────────────────
world.spawn(
  { component: Transform, data: { pos: [0, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: DirectionalLight, data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 10, castShadow: false } },
);

// ── Skylight (ambient) ────────────────────────────────────────────────
world.spawn({
  component: Skylight,
  data: { color: new Float32Array([0.1, 0.1, 0.1]), intensity: 0.5 },
});

// ── Orthographic camera at (0,0,8) looking at origin ───────────────────
const camQuat = quat.create();
quat.fromLookAt(camQuat, [0, 0, 8], [0, 0, 0], [0, 1, 0]);
world.spawn(
  { component: Transform, data: { pos: [0, 0, 8], quat: camQuat, scale: [1, 1, 1] } },
  { component: Camera, data: orthographic({ left: -7.11, right: 7.11, bottom: -4, top: 4 }) },
);

// --- drive the frame loop ---
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
let framesObserved = 0;
let earlyMaxBright = 0;

// Read a horizontal strip of pixels to sample roughness gradient.
const sampleRow = (bytes, bytesPerRow, w, rowY) => {
  const off = rowY * bytesPerRow;
  const strip = [];
  for (let x = 0; x < w; x++) {
    const px = off + x * 4;
    const r = (bytes[px] ?? 0) / 255;
    const g = (bytes[px + 1] ?? 0) / 255;
    const b = (bytes[px + 2] ?? 0) / 255;
    strip.push(r * 0.299 + g * 0.587 + b * 0.114);
  }
  return strip;
};

// Take an early readback at frame 5 to capture lit-brightness.
const EARLY_FRAME = Math.min(5, TARGET_FRAMES - 1);
let leftStripAvg = 0;
let rightStripAvg = 0;

for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = await drawSmokeFrame(renderer, world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;

  if (i === EARLY_FRAME) {
    const device = sharedDevice;
    if (!device) continue;
    await device.queue.onSubmittedWorkDone();
    const bpp = 4;
    const bpr = Math.ceil((WIDTH * bpp) / 256) * 256;
    const eb = device.createBuffer({ size: bpr * HEIGHT, usage: 0x01 | 0x08 });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: eb, bytesPerRow: bpr, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    try { await eb.mapAsync(0x01); } catch (_) { /* skip */ }
    const ebBytes = new Uint8Array(eb.getMappedRange().slice(0));
    eb.unmap(); eb.destroy();

    let maxB = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bpr + x * 4;
        const rv = (ebBytes[off] ?? 0) / 255;
        const gv = (ebBytes[off + 1] ?? 0) / 255;
        const bv = (ebBytes[off + 2] ?? 0) / 255;
        const bright = rv * 0.299 + gv * 0.587 + bv * 0.114;
        if (bright > maxB) maxB = bright;
      }
    }
    earlyMaxBright = maxB;
    console.log(`[smoke] earlyMaxBright at frame ${i}=${earlyMaxBright.toFixed(4)}`);

    // Sample the center row to check roughness gradient (left vs right).
    const centerRow = sampleRow(ebBytes, bpr, WIDTH, Math.floor(HEIGHT / 2));
    const leftThird = centerRow.slice(0, Math.floor(WIDTH / 3));
    const rightThird = centerRow.slice(Math.floor(2 * WIDTH / 3));
    leftStripAvg = leftThird.reduce((a, b) => a + b, 0) / leftThird.length;
    rightStripAvg = rightThird.reduce((a, b) => a + b, 0) / rightThird.length;
    console.log(`[smoke] left-third avg brightness=${leftStripAvg.toFixed(4)}, right-third avg=${rightStripAvg.toFixed(4)}`);
  }
}

const device = sharedDevice;
if (!device) { console.error('[smoke] FAIL - no shared device captured for readback'); process.exit(1); }
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} (target=${TARGET_FRAMES})`);

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}

// Final frame readback
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

console.log(`[smoke] pixelSamples readback complete`);

// Dump PNG
try {
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(here, '..', 'artifacts', 'smoke-frame.png');
  mkdirSync(dirname(pngOut), { recursive: true });
  writeFileSync(pngOut, encodePng(WIDTH, HEIGHT, tight));
  console.log(`[smoke] wrote PNG=${pngOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

// Check center region (32×32 px around center) for lit pixels.
// The center of the orthographic view maps to world (0,0,0) which is empty
// space between the sphere rows — the exact center pixel may be black even
// though the scene is lit. The center region covers the grid center.
const centerRegionLit = (() => {
  const cx = Math.floor(WIDTH / 2);
  const cy = Math.floor(HEIGHT / 2);
  const half = 16;
  let max = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const o = y * bytesPerRow + x * 4;
      const bright = (bytes[o] ?? 0) * 0.299 + (bytes[o + 1] ?? 0) * 0.587 + (bytes[o + 2] ?? 0) * 0.114;
      if (bright > max) max = bright;
    }
  }
  return max;
})();
const roughnessSpread = Math.abs(rightStripAvg - leftStripAvg);

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`(a) backend=${rendererBackend(renderer)} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (centerRegionLit <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) center-region max=${centerRegionLit.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD} — lit scene not visible`);
}
if (earlyMaxBright <= 0.03) {
  failures.push(`(d) earlyMaxBright=${earlyMaxBright.toFixed(4)} <= 0.03 — light not producing visible illumination`);
}
if (roughnessSpread <= 0.002) {
  failures.push(`(e) roughness spread=${roughnessSpread.toFixed(4)} <= 0.002 — left/right spheres look identical (roughness gradient not visible)`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, center-region-lit=${centerRegionLit.toFixed(4)}, earlyMaxBright=${earlyMaxBright.toFixed(4)}, roughness-spread=${roughnessSpread.toFixed(4)}, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
