#!/usr/bin/env node
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-plugin headless dawn smoke — structural-only.
// Verifies webgpu backend + no RHI errors.
// Bevy plugin demo has no visible scene; the smoke gate proves the app boots
// with the custom plugin without RHI/driver errors.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 160;
const HEIGHT = 120;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try { gpu = create([]); } catch (err) {
  console.error(`[smoke] FAIL - dawn-node create: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const _origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const raw = await _origReqAdapter(opts);
  if (raw === null) return raw;
  const _origReqDev = raw.requestDevice.bind(raw);
  raw.requestDevice = async (desc) => {
    const dev = await _origReqDev(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return raw;
};

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

const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');

const here = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

// Intercept console.log to verify the plugin's message was printed
const consoleLogCalls = [];
const _origLog = console.log;
console.log = (...args) => consoleLogCalls.push(args.join(' '));

// Also intercept console.error for debugging
const _origErr = console.error;

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push({ code: err.code, hint: err.hint }));


// Build world with the custom plugin
const { printMessagePlugin } = await import(resolve(here, '..', 'src', 'plugin.ts'));
const { Camera } = await import('@forgeax/engine-render');
const { perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { quat } = await import('@forgeax/engine-math');
const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const plugin = printMessagePlugin(0, 'This is an example plugin');
const { createWorldContext } = await import('@forgeax/engine-ecs');
await createWorldContext(world, [plugin]);

// Minimal camera — the renderer needs at least one camera to render.
const eye = [-2, 2.5, 5];
world.spawn(
  { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);

for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update(0.016);
  await drawSmokeFrame(renderer, world);
}
await delay(50);

// Restore console.log before running checks (it was intercepted above)
console.log = _origLog;

const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['rhi-error-count=0', errors.length === 0],
  ['plugin-message-printed', consoleLogCalls.length > 0 && consoleLogCalls.some(c => c.includes('This is an example plugin'))],
];

let allPass = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) allPass = false;
}
if (!allPass) {
  console.error(`[smoke] FAIL - ${checks.filter(([, ok]) => !ok).map(([n]) => n).join(', ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, backend=${rendererBackend(renderer)}`);
process.exit(0);
