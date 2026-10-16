#!/usr/bin/env node
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../../scripts/smoke-platform.mjs';
import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/5.advanced-lighting/3.2.point-shadows/scripts/smoke.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M3 / M3-T-SMOKE-DAWN.
//
// LearnOpenGL section 5.3.2 point-light cube-map shadows dawn-node smoke
// Spawns the canonical inward-facing room cube (source extent=5, engine
// transform scale=10) + the five exact LearnOpenGL inner-cube transforms
// (source scale doubled for the engine's unit cube) + PointLight /
// PointLightShadow with the source z-only orbit, renders a configurable frame
// window, reads back the final render target, and asserts a producer-owned
// point-light witness.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-3-2-point-shadows] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const POINT_LIGHT_MIN_DELTA = Number.parseFloat(process.env.POINT_LIGHT_MIN_DELTA ?? '0.05');
// The browser demo is the visual reference and uses the source's 1024² map.
// Dawn smoke defaults to a smaller map so the six-face semantic witness stays
// cheap in CI; set SMOKE_SHADOW_MAP_SIZE=1024 for a same-resolution replay.
const SMOKE_SHADOW_MAP_SIZE = Number.parseInt(
  process.env.SMOKE_SHADOW_MAP_SIZE ?? '256',
  10,
);
const SMOKE_SYNC_EVERY = Math.max(
  1,
  Number.parseInt(process.env.SMOKE_SYNC_EVERY ?? '8', 10),
);
const FALSIFY = process.env.FALSIFY ?? '';
const FALSIFY_NO_POINT_LIGHT = FALSIFY === 'no-point-light';
const WIDTH = 512;
const HEIGHT = 512;
const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');

// Known-noise app.onError codes.
const KNOWN_NOISE_CODES = new Set([]);

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
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
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// rAF / cAF stubs must be installed BEFORE createApp.
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

// --- 2. Mock canvas with offscreen render target ---

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

// --- 3. Shader manifest ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest({ pointShadows: true });
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

// --- 4. createApp + setup ---

const { createApp } = await import('@forgeax/engine-app/browser');

const { Materials, PointLightShadow } = await import('@forgeax/engine-render');
const { Camera, MeshFilter, MeshRenderer, perspective, PointLight } = await import('@forgeax/engine-render');
const { createSceneCubeMesh } = await import('../src/scene-mesh.ts');
const { Transform } = await import('@forgeax/engine-scene');

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-3-2-point-shadows] backend=${app.renderer.inspect().capabilities.backendKind}`);
console.log(
  `[smoke] shadowMapSize=${SMOKE_SHADOW_MAP_SIZE} syncEvery=${SMOKE_SYNC_EVERY}`,
);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));
app.renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  const err = event.error;
  onErrorEvents.push({ code: err.code, hint: err.hint });
  if (onErrorEvents.length <= 4) console.error('[smoke] renderer error', JSON.stringify(err));
});


const world = app.world;

// --- 5. Spawn scene ---

const roomMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.4, 0.4, 0.5, 1],
    metallic: 0,
    roughness: 0.5,
    occlusionStrength: 1,
}));
const roomMesh = world.allocSharedRef('MeshAsset', createSceneCubeMesh(FALSIFY !== 'outward-room'));
const cubeMesh = world.allocSharedRef('MeshAsset', createSceneCubeMesh(false));

// Room cube: the source renderCube spans [-1, 1], while HANDLE_CUBE spans
// [-0.5, 0.5]. Transform scale=10 therefore preserves the source's [-5, 5]
// room extent. The shared mesh owns the inward normals and winding.
world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [10, 10, 10] },
  },
  { component: MeshFilter, data: { assetHandle: roomMesh } },
  { component: MeshRenderer, data: { materials: [roomMat] } },
).unwrap();

// 5 inner cubes at the exact LearnOpenGL renderScene() transforms. Dawn keeps
// solid colors because the browser-only demo owns the wood.png Pack route;
// geometry, camera, light orbit, and shadow projection stay identical. The
// Dawn map resolution is the configurable CI cost knob above.
const innerObjects = [
  { pos: [4, -3.5, 0], scale: 1, quat: [0, 0, 0, 1], color: [0.75, 0.75, 0.75] },
  { pos: [2, 3, 1], scale: 1.5, quat: [0, 0, 0, 1], color: [0.75, 0.75, 0.75] },
  { pos: [-3, -1, 0], scale: 1, quat: [0, 0, 0, 1], color: [0.75, 0.75, 0.75] },
  { pos: [-1.5, 1, 1.5], scale: 1, quat: [0, 0, 0, 1], color: [0.75, 0.75, 0.75] },
  {
    pos: [-1.5, 2, -3],
    scale: 1.5,
    quat: [0.3535533906, 0, 0.3535533906, 0.8660254038],
    color: [0.75, 0.75, 0.75],
  },
];
for (const obj of innerObjects) {
  const [r, g, b] = obj.color;
  const mat = Materials.standard({ baseColor: [r, g, b, 1] });
  const matHandle = world.allocSharedRef('MaterialAsset', mat);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: obj.pos,
        quat: obj.quat,
        scale: [obj.scale, obj.scale, obj.scale],
      },
    },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  ).unwrap();
}

// Orbiting point light with shadow.
let lightEntity = null;
if (!FALSIFY_NO_POINT_LIGHT) {
  lightEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0] },
    },
    {
      component: PointLight,
      data: { range: 25, intensity: 20, color: [1, 1, 1] },
    },
    {
      component: PointLightShadow,
      data: {
        mapSize: SMOKE_SHADOW_MAP_SIZE,
        depthBias: 0.05,
        normalBias: 0,
        nearPlane: 1,
        farPlane: 25,
        pcfKernelSize: 1,
      },
    },
  ).unwrap();
} else {
  console.log('[smoke] FALSIFY=no-point-light -- PointLight and PointLightShadow omitted');
}

// Camera: canonical LearnOpenGL starting pose (0, 0, 3), facing -Z.
const cameraEntity = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] },
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.1, 0.1, 0.1, 1],
    },
  },
).unwrap();

// Per-frame light orbit.
if (lightEntity !== null) {
  let elapsed = 0;
  world.addSystem(Update, {
    name: 'point-light-orbit-smoke',
    queries: [],
    fn: () => {
      elapsed += 1 / 60;
      const t = elapsed * 0.5;
      world.set(lightEntity, Transform, {
        pos: [0, 0, Math.sin(t) * 3],
      });
    },
  });
}

// --- 6. Render the configured readiness window ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const frameStart = Date.now();
let totalFrames = 0;
const lease = app.renderer.attach(world).unwrap();
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  await drawReadyFrame(app.renderer, { leases: [lease], camera: { lease }, environment: { lease } });
  totalFrames++;
  if (i % 8 === 7 || i === SMOKE_MIN_FRAMES - 1) {
    console.log(`[smoke] progress frame=${totalFrames} elapsedMs=${Date.now() - frameStart}`);
  }
  // Periodically yield for async shadow/material PSOs. The final wait below
  // still fences every submission, while avoiding a queue round-trip on every
  // frame of the 60-frame smoke.
  if (
    sharedDevice &&
    (i === 0 || i === SMOKE_MIN_FRAMES - 1 || i % SMOKE_SYNC_EVERY === SMOKE_SYNC_EVERY - 1)
  ) {
    await sharedDevice.queue.onSubmittedWorkDone();
  }
  if (i % 16 === 15) await delay(1);
}

console.log(`[smoke] frames observed=${totalFrames}`);

// --- 7. Pixel readback ------------------------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
async function readPixels() {
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
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();
return bytes;
}
const bytes = await readPixels();
async function renderControl() {
  // Do not advance World time: geometry, camera and light pose are identical.
  for (let frame = 0; frame < 8; frame++) {
    const result = app.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }).unwrap();
    (await result.completed).unwrap();
    await device.queue.onSubmittedWorkDone();
    await delay(1);
  }
  return readPixels();
}
if (lightEntity !== null) world.removeComponent(lightEntity, PointLightShadow).unwrap();
const noShadow = await renderControl();
if (lightEntity !== null) world.set(lightEntity, PointLight, { intensity: 0 });
const noLight = await renderControl();
let shadowPixelDifference = 0;
let litPixelDifference = 0;
for (let index = 0; index < bytes.length; index++) {
  if (index % 4 === 3) continue;
  shadowPixelDifference += Math.abs(bytes[index] - noShadow[index]);
  litPixelDifference += Math.abs(noShadow[index] - noLight[index]);
}
const wallOffset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
const wallLightDelta = Math.max(...[0, 1, 2].map(channel => (noShadow[wallOffset + channel] - noLight[wallOffset + channel]) / 255));
console.log(`[smoke] controls=${JSON.stringify({ shadowPixelDifference, litPixelDifference, wallLightDelta })}`);

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [
    (bytes[off + 0] ?? 0) / 255,
    (bytes[off + 1] ?? 0) / 255,
    (bytes[off + 2] ?? 0) / 255,
  ];
};
const sites = [
  { name: 'cubeCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeLower', x: Math.floor(WIDTH * 0.48), y: Math.floor(HEIGHT * 0.62) },
  { name: 'roomWall', x: Math.floor(WIDTH * 0.08), y: Math.floor(HEIGHT * 0.12) },
  { name: 'topCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT * 0.08) },
  { name: 'topLeft', x: Math.floor(WIDTH * 0.12), y: Math.floor(HEIGHT * 0.08) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

let maxChannel = 0;
let maxPixel = [0, 0];
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const sample = readRgba(x, y);
    const channel = Math.max(...sample);
    if (channel > maxChannel) {
      maxChannel = channel;
      maxPixel = [x, y];
    }
  }
}
console.log(`[smoke] maxChannel=${maxChannel.toFixed(4)} at=${JSON.stringify(maxPixel)}`);
const maxGrid = [];
for (let gy = 0; gy < 4; gy++) {
  const row = [];
  for (let gx = 0; gx < 4; gx++) {
    let cellMax = 0;
    for (let y = gy * HEIGHT / 4; y < (gy + 1) * HEIGHT / 4; y += 1) {
      for (let x = gx * WIDTH / 4; x < (gx + 1) * WIDTH / 4; x += 1) {
        cellMax = Math.max(cellMax, ...readRgba(x, y));
      }
    }
    row.push(Number(cellMax.toFixed(4)));
  }
  maxGrid.push(row);
}
console.log(`[smoke] maxGrid=${JSON.stringify(maxGrid)}`);

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lumSamples = Object.fromEntries(
  Object.entries(pixelSamples).map(([name, sample]) => [name, Number(luminance(sample).toFixed(4))]),
);
console.log(`[smoke] lumSamples=${JSON.stringify(lumSamples)}`);
const clearLuminance = luminance([0.1, 0.1, 0.1]);
const pointLightSite = Math.max(lumSamples.cubeCenter, lumSamples.topCenter, lumSamples.topLeft);
const pointLightWitness = pointLightSite - clearLuminance >= POINT_LIGHT_MIN_DELTA;
const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);
console.log(
  `[smoke] oracle=point-light-shadow siteLuminance=${pointLightSite} deltaFromClear=${Number((pointLightSite - clearLuminance).toFixed(4))} witness=${pointLightWitness} threshold=${POINT_LIGHT_MIN_DELTA} falsifier=${FALSIFY_NO_POINT_LIGHT ? 'no-point-light' : 'none'}`,
);

const appDisposeResult = await app.dispose();
if (!appDisposeResult.ok) {
  onErrorEvents.push({ code: appDisposeResult.error.code, hint: appDisposeResult.error.hint });
}

// --- 8. Verdict -------------------------------------------------------------

const failures = [];
if (app.renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${app.renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);

if (shadowPixelDifference <= 0) failures.push('shadow toggle produces no pixel change');
if (wallLightDelta < POINT_LIGHT_MIN_DELTA) failures.push('point light does not illuminate the room wall');

if (pointLightSite - clearLuminance < SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(d) brightest semantic site luminance=${pointLightSite} ~= clear (${clearLuminance.toFixed(4)}); room/cube not rendered`,
  );
}
if (!pointLightWitness) {
  failures.push(
    `(e) point-light shadow witness rejected siteLuminance=${pointLightSite}; expected deltaFromClear>=${POINT_LIGHT_MIN_DELTA}`,
  );
}
if (wallTotalMs > SMOKE_WALL_BUDGET_MS) {
  failures.push(`(f) wallTotalMs=${wallTotalMs} > ${SMOKE_WALL_BUDGET_MS}`);
}

const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(g) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(h) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=webgpu, frames=${totalFrames}, inwardRoom, wallLit, shadowToggle, oracle=point-light-shadow, wallTotalMs=${wallTotalMs}, onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
