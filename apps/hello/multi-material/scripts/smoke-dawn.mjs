#!/usr/bin/env node
// hello-multi-material headless smoke
// (feat-20260608-mesh-multi-section-primitive-multi-material-slot / M5 / w22).
//
// Proves AC-08: a single MeshAsset carrying TWO submeshes (triangle-list quad
// + line-list wireframe box) bound to TWO distinct MaterialAssets through
// MeshRenderer.materials[] renders both prims in the same frame -- the red
// filled quad pixels coexist with cyan line-stroke pixels -> two distinct
// material colors are detectable post-render.
//
// Strategy (mirrors hello-topology smoke skeleton; structural readback):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (bgra8unorm).
//   3. createRenderer + register the demo's hand-built multi-prim mesh
//      (4 quad verts + 8 wireframe verts; index buffer concatenates quad
//      indices then line-list indices) + two unlit materials (red + cyan).
//   4. Render ~60 frames as a tight synchronous loop (one warm-up frame
//      with an event-loop yield to land first shader compile, then no
//      per-frame yield -- scene is static, repeated draws are idempotent).
//   5. Read back final frame. Count:
//        (a) red-dominant pixels   (R > 128 && R - max(G,B) >= 32)
//        (b) cyan-dominant pixels  (G > 96 && B > 96 && R < 96)
//      Assert BOTH counts > 0 -- proves both submeshes rendered with
//      different materials in the same frame. A single-material mode (e.g.
//      MeshRenderer.materials = [red, red]) would bring cyan pixels to 0.
//
// Falsify hooks (plan-strategy 5.4 falsification check; NOT run in CI):
//   - FALSIFY=truncate-materials : register MeshRenderer with materials=[red]
//     while submeshes.length===2 -> render-system-extract throws
//     'mesh-renderer-material-count-mismatch' AssetError -> Renderer error event
//     fires -> smoke FAIL (no cyan pixels + non-empty errors). Proves the
//     count-mismatch fail-fast (M2 / w11) is load-bearing.
//   - FALSIFY=duplicate-material : materials=[red, red]; both submeshes paint
//     red, cyan count drops to 0 -> assertion (b) fails. Proves the
//     positional materials[i] -> submeshes[i] binding is load-bearing.
//
// Output literals (preserved for grep tooling):
//   - `[hello-multi-material] backend=webgpu`
//   - `[smoke] colorReadback={"red":<N>,"cyan":<N>,"totalPixels":<N>,"frames":<N>}`
//   - `[smoke] PASS` / `[smoke] FAIL`

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const CLEAR_RGBA = [0, 0, 0, 1];
const TOTAL_PIXELS = WIDTH * HEIGHT;
const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const FALSIFY = process.env.FALSIFY ?? '';
const M26_RECOVERY = process.argv.includes('--m26-recovery');
const M32_RECOVERY = process.argv.includes('--m32-recovery');
const RED_GUID = '019d0000-0000-7000-8000-000000000001';
const CYAN_GUID = '019d0000-0000-7000-8000-000000000002';
const BLUE_GUID = '019d0000-0000-7000-8000-000000000003';

const here = dirname(fileURLToPath(import.meta.url));

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-multi-material smoke');
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
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
    usage: 0x10 | 0x04 | 0x01,
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

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { buildMeshAttributeMapForUvSets } = await import('@forgeax/engine-geometry');
const { Camera, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { resolveAssetHandle } = await import('@forgeax/engine-assets-runtime');
const { handleGeneration, handleSlot } = await import('@forgeax/engine-types');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
let MANIFEST_URL;
try {
  MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
} catch (err) {
  console.error(
    `[smoke] FAIL - missing built manifest at ${MANIFEST_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  run `pnpm --filter @forgeax/hello-multi-material build` first');
  process.exit(1);
}

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
  if (assets === null) throw new Error('AssetRegistry is unavailable');
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

const backend = renderer.inspect().capabilities.backendKind;
console.log(`[hello-multi-material] backend=${backend}`);

let defaultMaterials;
if (M26_RECOVERY || M32_RECOVERY) {
  const redGuid = assets.parseGuid(RED_GUID);
  const cyanGuid = assets.parseGuid(CYAN_GUID);
  const redCatalog = assets.catalog(redGuid, makeUnlitMaterial([1.0, 0.15, 0.15]));
  const cyanCatalog = assets.catalog(cyanGuid, makeUnlitMaterial([0.1, 0.9, 1.0]));
  if (!redCatalog.ok || !cyanCatalog.ok) {
    console.error(
      `[material-recovery] FAIL - default material catalog failed: ${JSON.stringify({ redCatalog, cyanCatalog })}`,
    );
    process.exit(1);
  }
  defaultMaterials = [redGuid, cyanGuid];
}

// --- 4. Geometry (multi-prim, mixed-topology) -------------------------------

const FLOATS_PER_VERTEX = 12;

function buildMultiPrimMesh(defaultMaterials) {
  const half = 0.6;
  const lineHalf = 0.7;
  const lineZ = 0.02;
  const quadCorners = [
    [-half, -half, 0],
    [+half, -half, 0],
    [+half, +half, 0],
    [-half, +half, 0],
  ];
  const lineCorners = [
    [-lineHalf, -lineHalf, lineZ],
    [+lineHalf, -lineHalf, lineZ],
    [+lineHalf, +lineHalf, lineZ],
    [-lineHalf, +lineHalf, lineZ],
    [-lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, +lineHalf * 0.5, lineZ],
    [-lineHalf * 0.5, +lineHalf * 0.5, lineZ],
  ];
  const totalVerts = quadCorners.length + lineCorners.length;
  const vertices = new Float32Array(totalVerts * FLOATS_PER_VERTEX);
  const positions = new Float32Array(totalVerts * 3);
  let v = 0;
  for (const corner of [...quadCorners, ...lineCorners]) {
    const base = v * FLOATS_PER_VERTEX;
    vertices[base + 0] = corner[0];
    vertices[base + 1] = corner[1];
    vertices[base + 2] = corner[2];
    positions[v * 3 + 0] = corner[0];
    positions[v * 3 + 1] = corner[1];
    positions[v * 3 + 2] = corner[2];
    v++;
  }
  const quadIndices = [0, 1, 2, 0, 2, 3];
  const outerSegs = [
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ];
  const innerSegs = [
    [8, 9],
    [9, 10],
    [10, 11],
    [11, 8],
  ];
  const lineIndices = [];
  for (const [a, b] of [...outerSegs, ...innerSegs]) {
    lineIndices.push(a, b);
  }
  const indices = new Uint16Array([...quadIndices, ...lineIndices]);
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes: { ...buildMeshAttributeMapForUvSets(1), position: positions },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: quadIndices.length,
        vertexCount: 4,
        topology: 'triangle-list',
        materialSlot: 0,
      },
      {
        indexOffset: quadIndices.length,
        indexCount: lineIndices.length,
        vertexCount: 8,
        topology: 'line-list',
        materialSlot: 1,
      },
    ],
    materialSlots:
      defaultMaterials === undefined
        ? [{ slotName: 'Surface' }, { slotName: 'Outline' }]
        : [
            { slotName: 'Surface', defaultMaterial: defaultMaterials[0] },
            { slotName: 'Outline', defaultMaterial: defaultMaterials[1] },
          ],
  };
}

// w64: mint mesh + materials as user-tier shared refs (register/get deleted M8).
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const drawFrame = () => renderer.draw({
  leases: [lease],
  camera: { lease },
  environment: { lease },
});
const meshHandle = world.allocSharedRef('MeshAsset', buildMultiPrimMesh(defaultMaterials));

function mintUnlit(rgb) {
  return world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: rgb },
  });
}

function makeUnlitMaterial(baseColor) {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor },
  };
}

const redHandle = mintUnlit([1.0, 0.15, 0.15]);
const cyanHandle = mintUnlit([0.1, 0.9, 1.0]);
const blueHandle = mintUnlit([0.1, 0.2, 1.0]);
const m32OldHandle = mintUnlit([1.0, 0.15, 0.15]);
const m32SiblingHandle = mintUnlit([0.1, 0.9, 1.0]);

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 5. Scene -----------------------------------------------------------------

function spawnScene(world) {
  // Falsify modes manipulate the materials array to model failure modes:
  //   - truncate-materials: materials=[red] (1 element) vs submeshes.length=2
  //     -> mesh-renderer-material-count-mismatch fail-fast.
  //   - duplicate-material: materials=[red, red] -> both prims paint red, cyan
  //     count drops to 0 -> assertion (b) fails.
  let materials;
  if (M26_RECOVERY) {
    materials = [];
  } else if (M32_RECOVERY) {
    materials = [m32OldHandle, m32SiblingHandle];
  } else if (FALSIFY === 'truncate-materials') {
    materials = [redHandle];
  } else if (FALSIFY === 'duplicate-material') {
    materials = [redHandle, redHandle];
  } else {
    materials = [redHandle, cyanHandle];
  }
  const meshEntity = world
    .spawn(
      { component: Transform, data: { quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials } },
    )
    .unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2.5], quat: [0, 0, 0, 1] } },
    {
      component: Camera,
      data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    },
  );
  return meshEntity;
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function doReadPixels() {
  if (!renderTarget) throw new Error('renderTarget never allocated');
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
  });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(0x01);
  const mapped = buf.getMappedRange();
  const raw = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      // bug-20260610 v18: swap-chain unified to rgba8unorm; byte order is RGBA, no swap needed.
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    errors.push({ code: event.error.code, hint: event.error.hint, detail: event.error.detail });
  }
});

const meshEntity = spawnScene(world);

async function renderFrames(count) {
  for (let i = 0; i < count; i++) {
    world.update().unwrap();
    drawFrame();
  }
  await delay(20);
}

function bindingObservation() {
  return renderer.inspect().meshMaterialBindings.find((entry) => entry.entityKey === Number(meshEntity));
}

function classifyPixels(pixels) {
  let red = 0;
  let cyan = 0;
  let blue = 0;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const r = pixels[i * 4 + 0] ?? 0;
    const g = pixels[i * 4 + 1] ?? 0;
    const b = pixels[i * 4 + 2] ?? 0;
    if (r > 128 && r - Math.max(g, b) >= 32) red++;
    if (g > 96 && b > 96 && r < 96) cyan++;
    if (b > 128 && b - Math.max(r, g) >= 32) blue++;
  }
  return { red, cyan, blue };
}

function assertM26(condition, message) {
  if (!condition) throw new Error(`[m26] ${message}`);
}

function assertM32(condition, message) {
  if (!condition) throw new Error(`[m32] ${message}`);
}

if (M32_RECOVERY) {
  await renderFrames(3);
  const baselinePixels = await doReadPixels();
  const baseline = bindingObservation();
  assertM32(baseline !== undefined, 'baseline mesh binding observation is missing');
  assertM32(baseline.diagnostics.length === 0, `baseline diagnostics: ${JSON.stringify(baseline)}`);
  assertM32(
    baseline.bindings[0]?.handle === m32OldHandle &&
      baseline.bindings[1]?.handle === m32SiblingHandle,
    `baseline handles are not the expected old/sibling pair: ${JSON.stringify(baseline)}`,
  );
  const baselineColors = classifyPixels(baselinePixels);
  assertM32(baselineColors.red > 0 && baselineColors.cyan > 0, `baseline colors: ${JSON.stringify(baselineColors)}`);
  assertM32(world.sharedRefs.refcount(m32OldHandle) === 2, 'baseline old producer/consumer refs are unbalanced');
  assertM32(world.sharedRefs.refcount(m32SiblingHandle) === 2, 'baseline sibling producer/consumer refs are unbalanced');

  const removed = world.set(meshEntity, MeshRenderer, {
    materials: [0, m32SiblingHandle],
  });
  if (!removed.ok) throw removed.error;
  assertM32(world.sharedRefs.refcount(m32OldHandle) === 1, 'consumer edge removal did not leave only the old producer grant');
  const released = world.sharedRefs.release(m32OldHandle);
  if (!released.ok) throw released.error;
  assertM32(world.sharedRefs.refcount(m32OldHandle) === 0, 'old producer grant did not release');

  const replacement = mintUnlit([0.1, 0.2, 1.0]);
  assertM32(handleSlot(replacement) === handleSlot(m32OldHandle), 'replacement did not reuse the old slot');
  assertM32(
    handleGeneration(replacement) === handleGeneration(m32OldHandle) + 1,
    'replacement generation did not advance exactly once',
  );
  const stale = resolveAssetHandle(world, m32OldHandle);
  assertM32(!stale.ok && stale.error.code === 'shared-ref-stale', `old handle was not rejected as stale: ${JSON.stringify(stale)}`);
  assertM32(
    JSON.stringify(stale.error.detail) ===
      JSON.stringify({
        slot: handleSlot(m32OldHandle),
        expectedGeneration: handleGeneration(m32OldHandle),
        actualGeneration: handleGeneration(replacement),
      }),
    `stale detail is not exact: ${JSON.stringify(stale.error.detail)}`,
  );
  assertM32(!('value' in stale.error), 'stale error exposed a replacement payload');
  const replacementResolved = resolveAssetHandle(world, replacement);
  assertM32(replacementResolved.ok, 'fresh replacement handle did not resolve');
  assertM32(
    replacementResolved.value.values?.baseColor?.[0] === 0.1 &&
      replacementResolved.value.values?.baseColor?.[2] === 1.0,
    'fresh handle did not resolve the blue replacement payload',
  );

  await renderFrames(3);
  const preRepairPixels = await doReadPixels();
  const preRepair = bindingObservation();
  assertM32(preRepair !== undefined, 'pre-repair mesh binding observation is missing');
  assertM32(preRepair.diagnostics.length === 0, `pre-repair diagnostics: ${JSON.stringify(preRepair)}`);
  assertM32(
    preRepair.bindings[0]?.source === 'mesh-default' &&
      preRepair.bindings[0]?.handle !== m32OldHandle &&
      preRepair.bindings[0]?.handle !== replacement &&
      preRepair.bindings[1]?.handle === baseline.bindings[1]?.handle,
    `pre-repair binding state leaked the old/replacement handle or lost sibling: ${JSON.stringify(preRepair)}`,
  );
  const preRepairColors = classifyPixels(preRepairPixels);
  assertM32(
    preRepairColors.red === baselineColors.red &&
      preRepairColors.cyan === baselineColors.cyan &&
      preRepairColors.blue === baselineColors.blue,
    `pixels changed before fresh binding: ${JSON.stringify({ baselineColors, preRepairColors })}`,
  );
  assertM32(world.sharedRefs.refcount(m32OldHandle) === 0, 'stale old handle regained a reference');
  assertM32(world.sharedRefs.refcount(replacement) === 1, 'fresh replacement has an unexpected consumer reference');
  assertM32(world.sharedRefs.refcount(m32SiblingHandle) === 2, 'healthy sibling continuity lost a reference');

  const repaired = world.set(meshEntity, MeshRenderer, {
    materials: [replacement, m32SiblingHandle],
  });
  if (!repaired.ok) throw repaired.error;
  await renderFrames(3);
  const repairedPixels = await doReadPixels();
  const repairedObservation = bindingObservation();
  assertM32(repairedObservation !== undefined, 'repaired mesh binding observation is missing');
  assertM32(repairedObservation.diagnostics.length === 0, `repair diagnostics: ${JSON.stringify(repairedObservation)}`);
  assertM32(
    repairedObservation.bindings[0]?.handle === replacement &&
      repairedObservation.bindings[1]?.handle === baseline.bindings[1]?.handle,
    `fresh binding or healthy sibling identity is wrong: ${JSON.stringify({ baseline, repairedObservation })}`,
  );
  const repairedColors = classifyPixels(repairedPixels);
  assertM32(repairedColors.blue > 0 && repairedColors.cyan > 0, `repair colors: ${JSON.stringify(repairedColors)}`);
  assertM32(repairedColors.red < baselineColors.red / 4, `repair did not change semantic color: ${JSON.stringify({ baselineColors, repairedColors })}`);
  assertM32(world.sharedRefs.refcount(replacement) === 2, 'fresh replacement consumer/producer refs are unbalanced');
  assertM32(world.sharedRefs.refcount(m32SiblingHandle) === 2, 'healthy sibling refs changed during repair');
  assertM32(errors.length === 0, `renderer reported device errors: ${JSON.stringify(errors)}`);

  const cleanup = world.set(meshEntity, MeshRenderer, { materials: [] });
  if (!cleanup.ok) throw cleanup.error;
  await renderFrames(3);
  const cleanupObservation = bindingObservation();
  assertM32(cleanupObservation?.diagnostics.length === 0, `cleanup diagnostics: ${JSON.stringify(cleanupObservation)}`);
  const cleanupAgain = world.set(meshEntity, MeshRenderer, { materials: [] });
  if (!cleanupAgain.ok) throw cleanupAgain.error;
  await renderFrames(3);
  const cleanupAgainObservation = bindingObservation();
  assertM32(
    JSON.stringify(cleanupAgainObservation) === JSON.stringify(cleanupObservation),
    `cleanup changed binding state on repetition: ${JSON.stringify({ cleanupObservation, cleanupAgainObservation })}`,
  );
  const releasedReplacement = world.sharedRefs.release(replacement);
  if (!releasedReplacement.ok) throw releasedReplacement.error;
  const releasedSibling = world.sharedRefs.release(m32SiblingHandle);
  if (!releasedSibling.ok) throw releasedSibling.error;
  assertM32(world.sharedRefs.refcount(m32OldHandle) === 0, 'old handle refcount is not zero after cleanup');
  assertM32(world.sharedRefs.refcount(replacement) === 0, 'replacement refcount is not zero after cleanup');
  assertM32(world.sharedRefs.refcount(m32SiblingHandle) === 0, 'sibling refcount is not zero after cleanup');

  console.log(
    `[m32] PASS baseline=${JSON.stringify(baselineColors)} preRepair=${JSON.stringify(preRepairColors)} ` +
      `repair=${JSON.stringify(repairedColors)} stale=${JSON.stringify(stale.error.detail)} ` +
      `refs=${JSON.stringify({ old: world.sharedRefs.refcount(m32OldHandle), replacement: world.sharedRefs.refcount(replacement), sibling: world.sharedRefs.refcount(m32SiblingHandle) })}`,
  );
  await renderer.dispose();
  process.exit(0);
}

if (M26_RECOVERY) {
  await renderFrames(3);
  const baselinePixels = await doReadPixels();
  const baseline = bindingObservation();
  assertM26(baseline !== undefined, 'baseline mesh binding observation is missing');
  assertM26(
    baseline.bindings.length === 2 && baseline.bindings.every((binding) => binding.source === 'mesh-default'),
    `materials=[] did not inherit both mesh defaults: ${JSON.stringify(baseline)}`,
  );
  assertM26(baseline.diagnostics.length === 0, `baseline diagnostics: ${JSON.stringify(baseline)}`);
  const baselineColors = classifyPixels(baselinePixels);
  assertM26(baselineColors.red > 0 && baselineColors.cyan > 0, `baseline colors: ${JSON.stringify(baselineColors)}`);

  const overflow = world.set(meshEntity, MeshRenderer, {
    materials: [0, 0, blueHandle],
  });
  if (!overflow.ok) throw overflow.error;
  await renderFrames(3);
  const faultPixels = await doReadPixels();
  const fault = bindingObservation();
  assertM26(fault !== undefined, 'overflow mesh binding observation is missing');
  const overflowDiagnostic = fault.diagnostics.find(
    (diagnostic) => diagnostic.code === 'mesh-renderer-material-override-overflow',
  );
  assertM26(
    overflowDiagnostic !== undefined,
    `overflow diagnostic missing: ${JSON.stringify(fault)}`,
  );
  assertM26(
    overflowDiagnostic.detail?.expectedCount === 2 && overflowDiagnostic.detail?.actualCount === 3,
    `overflow detail is not structured: ${JSON.stringify(overflowDiagnostic)}`,
  );
  assertM26(
    fault.bindings.every((binding) => binding.source === 'mesh-default'),
    `overflow dropped mesh defaults: ${JSON.stringify(fault)}`,
  );
  const faultColors = classifyPixels(faultPixels);
  assertM26(
    faultColors.red > 0 && faultColors.cyan > 0,
    `overflow did not preserve default pixels: ${JSON.stringify(faultColors)}`,
  );

  const repaired = world.set(meshEntity, MeshRenderer, {
    materials: [blueHandle, 0],
  });
  if (!repaired.ok) throw repaired.error;
  await renderFrames(3);
  const repairedPixels = await doReadPixels();
  const repairedObservation = bindingObservation();
  assertM26(repairedObservation !== undefined, 'repaired mesh binding observation is missing');
  assertM26(repairedObservation.diagnostics.length === 0, `repair left diagnostics: ${JSON.stringify(repairedObservation)}`);
  assertM26(
    repairedObservation.bindings[0]?.source === 'renderer-override' &&
      repairedObservation.bindings[1]?.source === 'mesh-default',
    `repair did not preserve binding provenance: ${JSON.stringify(repairedObservation)}`,
  );
  assertM26(
    repairedObservation.bindings[1]?.handle === baseline.bindings[1]?.handle,
    `healthy sibling handle changed during repair: ${JSON.stringify({ baseline, repairedObservation })}`,
  );
  const repairedColors = classifyPixels(repairedPixels);
  assertM26(repairedColors.blue > 0 && repairedColors.cyan > 0, `repair pixels: ${JSON.stringify(repairedColors)}`);
  assertM26(repairedColors.red < baselineColors.red / 4, `red target did not change: ${JSON.stringify({ baselineColors, repairedColors })}`);

  const cleanup = world.set(meshEntity, MeshRenderer, { materials: [] });
  if (!cleanup.ok) throw cleanup.error;
  await renderFrames(3);
  const cleanupObservation = bindingObservation();
  assertM26(cleanupObservation?.diagnostics.length === 0, `cleanup left diagnostics: ${JSON.stringify(cleanupObservation)}`);
  assertM26(
    cleanupObservation?.bindings.every((binding) => binding.source === 'mesh-default'),
    `cleanup did not restore defaults: ${JSON.stringify(cleanupObservation)}`,
  );
  const cleanupAgain = world.set(meshEntity, MeshRenderer, { materials: [] });
  if (!cleanupAgain.ok) throw cleanupAgain.error;
  await renderFrames(3);
  const cleanupAgainObservation = bindingObservation();
  assertM26(
    JSON.stringify(cleanupAgainObservation) === JSON.stringify(cleanupObservation),
    `repeated cleanup changed the binding observation: ${JSON.stringify({ cleanupObservation, cleanupAgainObservation })}`,
  );

  console.log(
    `[m26] PASS defaults=${JSON.stringify(baselineColors)} overflow=${JSON.stringify(faultColors)} ` +
      `repair=${JSON.stringify(repairedColors)} diagnostics=${JSON.stringify(overflowDiagnostic.detail)}`,
  );
  await renderer.dispose();
  process.exit(0);
}

// First frame + tiny yield to let the first shader-module compile land.
world.update().unwrap();
drawFrame();
await delay(20);

let frames = 1;
for (let i = 1; i < FRAMES; i++) {
  world.update().unwrap();
  drawFrame();
  frames++;
}

const pixels = await doReadPixels();

// Pixel classifiers:
//   red-dominant: clearly red, R high, G+B low.
//   cyan-dominant: cyan-ish, G + B high, R low.
let redCount = 0;
let cyanCount = 0;
for (let i = 0; i < TOTAL_PIXELS; i++) {
  const r = pixels[i * 4 + 0] ?? 0;
  const g = pixels[i * 4 + 1] ?? 0;
  const b = pixels[i * 4 + 2] ?? 0;
  if (r > 128 && r - Math.max(g, b) >= 32) {
    redCount++;
  } else if (g > 96 && b > 96 && r < 96) {
    cyanCount++;
  }
}

console.log(
  `[smoke] colorReadback=${JSON.stringify({
    red: redCount,
    cyan: cyanCount,
    totalPixels: TOTAL_PIXELS,
    frames,
  })}`,
);

let failed = false;
if (backend !== 'webgpu') {
  console.error(`[smoke] FAIL - (a) backend=${backend} != 'webgpu'`);
  failed = true;
}
if (frames < FRAMES) {
  console.error(`[smoke] FAIL - (b) frames=${frames} < ${FRAMES}`);
  failed = true;
}
if (redCount === 0) {
  console.error(
    '[smoke] FAIL - (c) redCount=0; the triangle-list submesh did not render its material -- ' +
      'submeshes[0] -> materials[0] binding is broken or per-submesh drawIndexed missing',
  );
  failed = true;
}
if (cyanCount === 0) {
  console.error(
    '[smoke] FAIL - (d) cyanCount=0; the line-list submesh did not render its material -- ' +
      'submeshes[1] -> materials[1] binding is broken or mixed-topology PSO selection failed',
  );
  failed = true;
}
if (errors.length > 0) {
  console.error(
    `[smoke] FAIL - (e) renderer reported ${errors.length} RhiError(s): ${JSON.stringify(errors.slice(0, 5))}`,
  );
  failed = true;
}

if (failed) {
  console.error('[smoke] FAIL');
  process.exit(1);
}

console.log(
  `[smoke] PASS red=${redCount} cyan=${cyanCount} (both > 0; multi-prim + mixed-topology + ` +
    `materials[i] <-> submeshes[i] index alignment confirmed over ${frames} frames)`,
);
emitSmokeReceipt('hello-multi-material/smoke', frames);
process.exit(0);
