#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-app headless smoke (feat-20260518-app-shell-game-loop M6 / w19 /
// AC-10 (a) + R-5).
//
// Strategy (D-12 + R-5): clearColor-only verdict (no baseline png).
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0; same setup as hello-cube smoke).
//   2. Build a mock HTMLCanvasElement with tagName + isConnected so the
//      createApp(canvas) thin-wrapper passes the canvas-detached guard
//      and reaches createRenderer; getContext('webgpu') returns a shim
//      whose configure() allocates an offscreen render target.
//   3. createApp(mockCanvas, {}, { shaderManifestUrl })
//      -- input is always-on by default (canvas form); the mock canvas
//      has no DOM event surface but dawn-node is not affected.
//   4. After 60 frames, readPixels center pixel via copyTextureToBuffer
//      + mapAsync; assert RGBA each component within eps=0.05 of clearColor.
//   5. Verdict: clearColor RGBA match + onError count == 0 + console.error
//      count == 0 (R-5 dual-zero assertion; D-12 clearColor-only baseline
//      with no PNG so render-system fallback drift cannot silently pass).
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-app] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS`

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;
const CLEAR_RGBA = [0.1, 0.2, 0.3, 1];

// bug-20260519 + bug-20260610 v18: canvas swap-chain is `rgba8unorm-srgb`
// (post-v18 unified storage; linear shader output is encoded to sRGB on
// store, so `readPixels` reads sRGB-encoded bytes).
// `clearColor` is in linear space; the expected on-canvas bytes are the
// per-channel sRGB encoding (alpha is byte-copied unchanged).
const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const CLEAR_RGBA_EXPECTED = [
  srgbEncode(CLEAR_RGBA[0]),
  srgbEncode(CLEAR_RGBA[1]),
  srgbEncode(CLEAR_RGBA[2]),
  CLEAR_RGBA[3],
];

// Capture console.error fan-out count (R-5 dual-zero criterion).
const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  originalConsoleError('  rerun: pnpm --filter @forgeax/hello-app smoke');
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
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// rAF shim so the createApp frame-loop schedules in node. Counter mirrors
// hello-cube smoke (sync drive after 60 ticks). We use queueMicrotask to
// keep frames truly async without setImmediate latency.
let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

// Capture raw GPUDevice via navigator.gpu.requestAdapter monkey-patch
// (charter P5 red-line; mirrors hello-cube smoke).
let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// Mock canvas: tagName lets createApp(arg) dispatch into the canvas form;
// isConnected=true skips the canvas-detached fail-fast (createApp.ts step 1).
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
  tagName: 'CANVAS',
  isConnected: true,
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

const { createApp } = await import('@forgeax/engine-app/browser');
// D-12 + R-5: smoke verdict is clearColor-only. We spawn Camera +
// DirectionalLight (no MeshFilter cube) so RenderSystem has the
// camera+light it needs to clear the framebuffer with clearColor but
// no geometry covers the center pixel. The browser entry
// (apps/hello/app/src/main.ts) does spawn populateDemoWorld for visual
// `vite dev` parity with hello-cube.
const { Camera, DirectionalLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-app] backend=${app.renderer.inspect().capabilities.backendKind}`);
// Camera + DirectionalLight only (no cube): RenderSystem clears the
// framebuffer with clearColor and the center pixel reads the clear
// value without geometry contamination (R-5 dual-zero precondition).
app.world.spawn(
  { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
      clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
    },
  },
);
app.world.spawn({
  component: DirectionalLight,
  data: { castShadow: true, direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

// onError count (R-5 dual-zero criterion).
const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint, detail: err.detail }));


// Monkey-patch performance.now BEFORE app.start() so the frame-loop's
// initial lastTimestamp reads the fake value, not a large real timestamp.
// Otherwise the first tick computes a negative delta and world.update()
// returns time-delta-invalid (Result-based validation, not silent pass).
let fakeNow = 0;
const realPerformanceNow = globalThis.performance.now.bind(globalThis.performance);
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

// Drive the rAF queue manually 60 ticks. createApp's frame-loop queues
// the next tick inside the callback (M2 createFrameLoop) so we drain
// progressively. fakeTime advances 16.67ms per tick to match a 60Hz target.
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const startTs = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow);
  framesObserved++;
}
globalThis.performance.now = realPerformanceNow;

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const device = sharedDevice;
if (!device) {
  originalConsoleError('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${framesObserved} (wall=${Date.now() - startTs}ms, target=${TARGET_FRAMES})`);

if (!renderTarget) {
  originalConsoleError('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
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
  originalConsoleError(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
// bug-20260610 v18: swap-chain unified to rgba8unorm-srgb so the byte order
// of copyTextureToBuffer readback is RGBA, not the BGRA used pre-v18.
function readRgbaNorm(px, py) {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  const a = (bytes[off + 3] ?? 0) / 255;
  return [r, g, b, a];
}
const center = readRgbaNorm(cx, cy);
const corner = readRgbaNorm(Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
console.log(`[smoke] pixelSamples=${JSON.stringify({ center, corner, expected: CLEAR_RGBA, expectedEncoded: CLEAR_RGBA_EXPECTED })}`);

// Verdict (D-12 + R-5): clearColor RGBA each component eps + dual-zero
// counts.
const failures = [];
for (let i = 0; i < 4; i++) {
  const diff = Math.abs(center[i] - CLEAR_RGBA_EXPECTED[i]);
  if (diff > SMOKE_PIXEL_THRESHOLD) {
    failures.push(`(a${i}) center[${i}]=${center[i].toFixed(4)} vs sRGB-encoded clearColor[${i}]=${CLEAR_RGBA_EXPECTED[i].toFixed(4)} (linear ${CLEAR_RGBA[i]}) diff=${diff.toFixed(4)} > ${SMOKE_PIXEL_THRESHOLD}`);
  }
}
if (onErrorEvents.length > 0) {
  failures.push(`(b) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}
if (consoleErrors.length > 0) {
  failures.push(`(c) console.error fired ${consoleErrors.length} times: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
}
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(d) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - center RGBA matches clearColor within eps=${SMOKE_PIXEL_THRESHOLD}, frames=${framesObserved}, app.onError=0, console.error=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
