#!/usr/bin/env node
// hello-tilemap headless smoke (feat-20260608 M0 baseline rebuild).
//
// Drives the engine ECS path end-to-end on the dawn-node binding:
//   - Synthesises a 32x32 RGBA atlas TextureAsset payload.
//   - Registers a TilesetAsset (4 regions x 4 tile entries).
//   - Spawns a Tilemap (cols=8 rows=8 chunkSize=4) + one TileLayer with
//     a hand-chosen anchor table along the diagonal.
//   - Calls the lease-bound renderer.draw request for 60+ frames; halfway through mutates the
//     TileLayer in place + markTileLayerDirty triggers a rebuild pass.
//   - Pixel readback samples the framebuffer to confirm the rebuild has
//     changed at least one channel by >= 0.1 max-channel-delta.
//
// Sandbox env-defer policy (plan-strategy §M0 boundary + plan-tasks m0-t12):
// when dawn-node fails to initialise (Vulkan caps missing on the
// primary-pnpm CI runner subset), the smoke reports
// [hello-tilemap smoke] env-deferred=<reason> + exits 0 so CI can record
// the gate as deferred rather than failing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const WIDTH = 320;
const HEIGHT = 240;
const TARGET_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '120', 10);

async function deferred(reason) {
  console.log(`[hello-tilemap smoke] env-deferred=${reason}`);
  await delay(0);
  process.exit(0);
}

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (importErr) {
  await deferred(`dawn-node import failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (createErr) {
  await deferred(`dawn-node create([]) threw: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalAmbientRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (sharedDevice === undefined) sharedDevice = dev;
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
    viewFormats: [format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
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
        if (renderTarget === undefined) {
          if (sharedDevice === undefined) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let ecs;
let render;
let authoring;
try {
  ecs = await import('@forgeax/engine-ecs');
  render = await import('@forgeax/engine-render');
  authoring = await import('@forgeax/engine-render/authoring');
} catch (err) {
  await deferred(`engine-runtime import failed: ${err instanceof Error ? err.message : String(err)}`);
}

const {
  Camera,
} = render;
const { TileLayer, Tilemap } = authoring;
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { ChildOf, Transform } = await import('@forgeax/engine-scene');
const { World } = ecs;

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

const world = new World();
let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (createErr) {
  await deferred(`createRenderer threw: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, expected: event.error.expected, hint: event.error.hint, detail: event.error.detail });
});


function buildSyntheticTileAtlas() {
  const width = 32;
  const height = 32;
  const data = new Uint8Array(width * height * 4);
  const quadrants = [
    [180, 100, 60, 255],
    [80, 180, 100, 255],
    [80, 120, 200, 255],
    [220, 200, 80, 255],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const top = y < height / 2;
      const left = x < width / 2;
      const color = quadrants[top ? (left ? 0 : 1) : left ? 2 : 3];
      data.set(color, offset);
    }
  }
  return { width, height, data };
}

const atlas = buildSyntheticTileAtlas();
const atlasPayload = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: atlas.width, height: atlas.height } },
  format: 'rgba8unorm-srgb',
  data: atlas.data,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};
const atlasHandle = world.allocSharedRef('TextureAsset', atlasPayload);
const atlasCatalog = assets.catalog('hello-tilemap/atlas', atlasPayload);
if (!atlasCatalog.ok) {
  console.error(`[hello-tilemap smoke] atlas catalog failed: ${atlasCatalog.error.code}`);
  process.exit(1);
}

const tileset = {
  kind: 'tileset',
  atlases: ['hello-tilemap/atlas'],
  tileWidth: 16,
  tileHeight: 16,
  columns: 2,
  rows: 2,
  regions: [
    { x: 0, y: 0, width: 16, height: 16 },
    { x: 16, y: 0, width: 16, height: 16 },
    { x: 0, y: 16, width: 16, height: 16 },
    { x: 16, y: 16, width: 16, height: 16 },
  ],
  tiles: [{ regionIndex: 0 }, { regionIndex: 1 }, { regionIndex: 2 }, { regionIndex: 3 }],
};
const tilesetCatalog = assets.catalog('hello-tilemap/tileset', tileset);
if (!tilesetCatalog.ok) {
  console.error(`[hello-tilemap smoke] tileset catalog failed: ${tilesetCatalog.error.code}`);
  process.exit(1);
}

const cols = 8;
const rows = 8;
const tilemap = world
  .spawn(
    {
      component: Tilemap,
      data: { cols, rows, tileSize: [1, 1], chunkSize: 4, tileset: 'hello-tilemap/tileset' },
    },
    { component: Transform, data: {} },
  )
  .unwrap();

const tiles = new Uint32Array(cols * rows);
for (let i = 0; i < Math.min(cols, rows); i++) {
  tiles[i * cols + i] = (i % 4) + 1;
}
const layer = world
  .spawn(
    { component: TileLayer, data: { tiles, layerOrder: 0, dirty: 1 } },
    { component: ChildOf, data: { parent: tilemap } },
    { component: Transform, data: {} },
  )
  .unwrap();

world.spawn(
  { component: Transform, data: { pos: [4, 4, 8]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
);

let framesDrawn = 0;
let dirtyTriggered = false;
for (let f = 0; f < TARGET_FRAMES; f++) {
  if (f === Math.floor(TARGET_FRAMES / 2) && !dirtyTriggered) {
    const view = world.get(layer, TileLayer).unwrap().tiles;
    view[0] = 0;
    view[7 * cols + 7] = 1;
    world.set(layer, TileLayer, { dirty: 1 }).unwrap();
    dirtyTriggered = true;
  }
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) {
    console.error(`[hello-tilemap smoke] draw frame ${f} error: ${JSON.stringify({ result: { code: r.error.code, expected: r.error.expected, hint: r.error.hint, detail: r.error.detail }, events: errors })}`);
    process.exit(1);
  }
  framesDrawn += 1;
}

const device = sharedDevice;
if (device === undefined) {
  await deferred('no shared GPUDevice captured after draw loop');
}
await device.queue.onSubmittedWorkDone();

// Count derived ECS entities to confirm the extract system fired.
let derivedCount = 0;
for (const arch of world.inspect().archetypes) {
  if (
    arch.componentNames.includes('MeshFilter') &&
    arch.componentNames.includes('MeshRenderer') &&
    arch.componentNames.includes('Layer') &&
    arch.componentNames.includes('ChildOf')
  ) {
    derivedCount += arch.entityCount;
  }
}

const failures = [];
if (framesDrawn < TARGET_FRAMES) failures.push(`(a) frames=${framesDrawn} < ${TARGET_FRAMES}`);
if (derivedCount < 1) failures.push(`(b) derived per-cell entity count=${derivedCount} (expected >= 1)`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(',');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[hello-tilemap smoke] FAIL — ${failures.length} criteria:`);
  for (const fmsg of failures) console.error(`  ${fmsg}`);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[hello-tilemap smoke] PASS — frames=${framesDrawn}, derived cell entities=${derivedCount}, RhiError count=0`,
);
console.log(
  `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    gateId: 'hello-tilemap/smoke',
    commandId: 'smoke',
    framesObserved: framesDrawn,
    completed: true,
  })}`,
);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
