#!/usr/bin/env node
// Standard clustered-lighting Dawn smoke.
//
// Upgraded from structural-only to pixel readback ε <= 0.05 vs committed
// baseline PNG. The 256-light scene renders through the Standard clustered
// lane; the smoke drives the Runtime host, receipt-bound observation, Dawn
// readback, and per-pixel delta vs baseline (AC-01).
//
// FALSIFY=force-forward -- selects the forward graph variant while retaining
// the same unified clustered light transport. It is a local topology probe,
// and records the clustered lighting transport used by the frame.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readReferencePng } from '../../../shared/png-codec.mjs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';

import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';

const lightweight = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? (lightweight ? '60' : '60'), 10);
const SMOKE_PIXEL_EPSILON = Number.parseFloat(process.env.SMOKE_PIXEL_EPSILON ?? '0.05');
const FALSIFY = process.env.FALSIFY ?? '';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(
  here,
  '../../../../forgeax-engine-assets/smoke-baselines/hdrp-lighting',
  'hdrp-lighting-256-light-dawn.png',
);

// 200x150 keeps 4:3 aspect (camera fov / aspect numbers below stay valid)
// but cuts fragment work to 1/16 of 800x600. Lavapipe in CI is fully CPU-
// bound on the clustered fragment shader (every pixel iterates O(30-
// 60) lights), so the smaller canvas drops the CI step from ~160s to ~10s.
// The pixel readback gate still catches PSO variant misroute / cluster indexing
// because the cube + floor + light-driven gradient occupy roughly the same
// proportion of the frame -- this is a CPU cost cut, not a coverage cut.
// The committed pixel baseline belongs to the asset repository's smoke-baselines/.
const WIDTH = 200;
const HEIGHT = 150;

// Standard lane smoke treats every renderer error as actionable.
const KNOWN_NOISE_CODES = new Set();

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

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { DEFAULT_STANDARD_PROFILE } = await import('@forgeax/engine-render');
const { createShaderModule, rhi } = await import('@forgeax/engine-rhi-webgpu');
const {
  Camera,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SpotLight,
  TONEMAP_ACES_FILMIC,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');


const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const constructed = await constructRuntimeRendererHost(
  mockCanvas,
  {
    standardProfile: {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: FALSIFY === 'force-forward' ? 'forward' : 'deferred',
      lightCount: 256,
    },
  },
  { shaderManifestUrl: MANIFEST_URL },
  { rhi, createShaderModule },
).catch((err) => {
  originalConsoleError(`[smoke] FAIL - renderer host threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!constructed.ok) {
  originalConsoleError(`[smoke] FAIL - renderer host returned err: ${JSON.stringify({ code: constructed.error.code, hint: constructed.error.hint })}`);
  process.exit(1);
}
const renderer = constructed.value.renderer;
console.log(`[hello-standard-lighting] backend=${renderer.inspect().capabilities.backendKind}`);

const world = new World({ assets: constructed.value.assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const attached = renderer.attach(world);
if (!attached.ok) {
  originalConsoleError(`[smoke] FAIL - renderer.attach: ${attached.error.code} - ${attached.error.hint}`);
  process.exit(1);
}
const lease = attached.value;

const matHandle = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.6, 0.6, 0.65],
    metallic: 0.0,
    roughness: 0.6,
  },
}).unwrap();

world.spawn(
  { component: Transform, data: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [6, 0.1, 6]} },
  { component: MeshFilter, data: { assetHandle: primitiveCube } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);
world.spawn(
  { component: Transform, data: { pos: [0, 0.6, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: MeshFilter, data: { assetHandle: primitiveCube } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x484452_50);
// Light geometry MUST stay in sync with the Standard lighting demo source.
// (the demo SSOT). y above the cube top + range >= ground gap ensure both
// floor and cube faces receive healthy NdotL. range 2.5..4.0m fits the new
// 1 MiB LIGHT_INDEX_LIST_CAPACITY with grid 16x9x24.
for (let i = 0; i < 200; i++) {
  const x = (rng() - 0.5) * 5.5;
  const z = (rng() - 0.5) * 5.5;
  const y = 1.5 + rng() * 2.0;
  world.spawn(
    { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1]} },
    {
      component: PointLight,
      data: {
        color: [0.5 + 0.5 * rng(), 0.5 + 0.5 * rng(), 0.5 + 0.5 * rng()],
        intensity: 0.3 + 0.4 * rng(),
        range: 2.5 + 1.5 * rng(),
      },
    },
  );
}
for (let i = 0; i < 56; i++) {
  const x = (rng() - 0.5) * 5.5;
  const z = (rng() - 0.5) * 5.5;
  const y = 2.0 + rng() * 2.0;
  world.spawn(
    { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1]} },
    {
      component: SpotLight,
      data: { castShadow: true,
        direction: [rng() - 0.5, -1, rng() - 0.5],
        color: [0.5 + 0.5 * rng(), 0.5 + 0.5 * rng(), 0.5 + 0.5 * rng()],
        intensity: 0.5 + 0.5 * rng(),
        range: 2.5 + 1.5 * rng(),
        innerConeDeg: 18,
        outerConeDeg: 32,
      },
    },
  );
}

// Camera placed at eye height (y=1.5) looking horizontal toward -Z so the
// 1x1 cube at (0, 0.6, 0) and the 6x0.1x6 floor are both inside the fov=45deg
// frustum from z=6.0. Original (y=4.0) pitched the lookat below the bottom of
// the frustum (atan2(3.4, 6.0) ~ 30deg > fov/2 = 22.5deg) -- the cube was
// drawn (632 successful drawIndexed across 332 frames) but landed off-screen,
// so the readback PNG returned only the camera clearColor.
world.spawn(
  { component: Transform, data: { pos: [0, 1.5, 6.0], quat: [0, 0, 0, 1]} },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 50 }),
      clearColor: [0.02, 0.02, 0.04, 1],
      // 256 punctual lights at intensity 1.5..4.0 produce HDR radiance that
      // burns out without a tonemap. ACES filmic + exposure 0.6 keeps mid-
      // tones visible while letting hot spots roll off naturally.
      tonemap: TONEMAP_ACES_FILMIC,
      exposure: 0.6,
    },
  },
);

const onErrorEvents = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    onErrorEvents.push({ code: event.error.code, hint: event.error.hint, detail: event.error.detail });
  }
});

let totalFrames = 0;
let latestReceipt;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  latestReceipt = await drawReadyFrame(renderer, {
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  totalFrames++;
}

if (latestReceipt === undefined) {
  originalConsoleError('[smoke] FAIL - no successful FrameReceipt was produced');
  process.exit(1);
}
console.log(`[smoke] frames observed=${totalFrames}`);

const observed = await renderer.observe(latestReceipt, { include: ['timings', 'draws', 'bindings'] });
if (!observed.ok) {
  originalConsoleError(`[smoke] FAIL - receipt observation: ${observed.error.code} - ${observed.error.hint}`);
  process.exit(1);
}
console.log(`[smoke] receipt observed frame=${observed.value.frameId} includes=${observed.value.include.join(',')}`);

// --- Pixel readback -----------------------------------------------------------

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
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

const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const dst = (y * WIDTH + x) * 4;
    tightRgba[dst + 0] = bytes[off + 0] ?? 0;
    tightRgba[dst + 1] = bytes[off + 1] ?? 0;
    tightRgba[dst + 2] = bytes[off + 2] ?? 0;
    tightRgba[dst + 3] = bytes[off + 3] ?? 0;
  }
}
// --- Verdict ------------------------------------------------------------------

const failures = [];

// (a) backend check
const inspection = renderer.inspect();
if (inspection.capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${inspection.capabilities.backendKind} (expected webgpu)`);
}

// The pixel gate is paired with the renderer-owned Standard inspection so a
// green image cannot hide a direct/clustered misroute or an empty producer.
const standardLighting = inspection.standardLighting;
if (
  standardLighting === undefined ||
  standardLighting.transport !== 'compute-storage' ||
  standardLighting.producer !== 'gpu' ||
  standardLighting.requested < 1 ||
  standardLighting.admitted < 1 ||
  standardLighting.occupied < 1
) {
  failures.push(
    `(a2) expected non-empty GPU Standard Cluster inspection, got ${JSON.stringify(standardLighting)}`,
  );
}
const passNames = inspection.perFramePassNames;
const membershipIndex = passNames.indexOf('cluster-membership-producer');
const firstStandardConsumerIndex = Math.min(
  ...['g-buffer', 'lighting', 'forward'].map((name) => {
    const index = passNames.indexOf(name);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }),
);
if (membershipIndex < 0) {
  failures.push(`(a3) Standard Cluster producer pass missing from ${JSON.stringify(passNames)}`);
} else if (membershipIndex >= firstStandardConsumerIndex) {
  failures.push(
    `(a3) Standard Cluster producer must precede raster consumers: producer=${membershipIndex}, consumer=${firstStandardConsumerIndex}`,
  );
}

// (b) frame count
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// (c) Renderer error events filtered to unknown codes
const unknownErrors = onErrorEvents.filter((e) => !KNOWN_NOISE_CODES.has(e.code));
if (unknownErrors.length > 0) {
  failures.push(
    `(c) Renderer error events fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `[smoke] committed baseline PNG missing at ${BASELINE_PATH}; restore the tracked fixture.`,
  );
  failures.push('(e) committed baseline PNG missing');
} else {
  const ref = readReferencePng(BASELINE_PATH);
  if (ref.width !== WIDTH || ref.height !== HEIGHT) {
    failures.push(`(e) baseline PNG size mismatch: ${ref.width}x${ref.height} != ${WIDTH}x${HEIGHT}`);
  } else {
    let maxDelta = 0;
    let exceedCount = 0;
    for (let i = 0; i < ref.pixels.length; i += 4) {
      const dr = Math.abs((ref.pixels[i] ?? 0) - (tightRgba[i] ?? 0)) / 255;
      const dg = Math.abs((ref.pixels[i + 1] ?? 0) - (tightRgba[i + 1] ?? 0)) / 255;
      const db = Math.abs((ref.pixels[i + 2] ?? 0) - (tightRgba[i + 2] ?? 0)) / 255;
      const d = Math.max(dr, dg, db);
      if (d > maxDelta) maxDelta = d;
      if (d > SMOKE_PIXEL_EPSILON) exceedCount++;
    }
    console.log(`[smoke] pixelDelta=${JSON.stringify({ maxDelta: maxDelta.toFixed(4), exceedCount })}`);
    if (exceedCount > 0) {
      failures.push(
        `(e) AC-01 pixel readback drift: ${exceedCount} pixels exceed eps=${SMOKE_PIXEL_EPSILON} (max=${maxDelta.toFixed(4)})`,
      );
    }
  }
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=${inspection.capabilities.backendKind}, frames=${totalFrames}, standardLane=clustered, renderPath=${FALSIFY === 'force-forward' ? 'forward' : 'deferred'}, rendererErrors=0, console.error=0`,
);

lease.dispose();
await renderer.dispose();
if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
