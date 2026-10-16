#!/usr/bin/env node
// hello-transform-hierarchy headless smoke
// (feat-20260531-render-consume-global-transform-hierarchy / M3 / w12).
//
// Strategy (single-World dual-frame "parent moves, child follows" pixel diff):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Build ONE World that wires the hierarchy consume path exactly like the
//      demo main.ts: registerPropagateTransforms(world). Spawn a non-identity
//      parent cube, a child cube carrying ChildOf{parent} + a local +Y offset,
//      and a static reference sphere that is NOT in the hierarchy.
//   4. Frame A (parent at rest): world.update(1 / 60).unwrap() (runs propagateTransforms so
//      the child's GlobalTransform.world is composed) -> renderer.draw -> readback
//      pixelsA.
//   5. Stability re-render: world.update(1 / 60).unwrap() + draw + readback pixelsAA WITHOUT
//      moving the parent. Assert pixelsA ~= pixelsAA (parent-static reference
//      frame is stable; AC-08 "parent stationary reference frame is stable").
//   6. Frame B (parent moved): world.set(parent, Transform, { pos: [..., 0, 0]}) ->
//      world.update(1 / 60).unwrap() (re-runs propagate; child's GlobalTransform.world follows the
//      parent) -> draw -> readback pixelsB.
//   7. Diff A vs B: per-pixel byte comparison. Assert diffCount > 0.1% of
//      total pixels -- this is the machine proof that moving the PARENT moved
//      the CHILD's rendered world position (the child has no Transform write
//      of its own between frames; the only thing that changed is the parent's
//      Transform propagated down the ChildOf edge).
//   8. Both frames must be non-black individually (geometries rendered).
//   9. No reference PNG reads/writes. No PNG ever lands in the engine repo
//      worktree.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-transform-hierarchy] backend=webgpu`
//   - `[smoke] parentMoveDiff={"diffCount":<N>,"threshold":<N>,...}`
//   - `[smoke] PASS`
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual diffCount / stabilityDiff vs thresholds so AI users can self-diagnose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createReceipt } from './dataflow-receipt.mjs';
import { smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';

const FLEET_FRAME_COUNT = smokeFrameBudget();

if (process.argv.includes('--receipt')) {
  console.log(JSON.stringify(createReceipt({
    workloadId: 'hierarchy-dynamic',
    backend: 'unavailable',
    reasonCode: 'dawn-probe-not-run',
    detail: 'Receipt-only mode does not create a native Dawn device.',
    retryHint: 'Run this script without --receipt on a Dawn-enabled runner.',
  }), null, 2));
  process.exit(0);
}

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;
const CLEAR_RGBA = [0, 0, 0, 1];
const TOTAL_PIXELS = WIDTH * HEIGHT;
// AC-08: >0.1% of total pixels. floor(800*600*0.001) = 480.
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.001);
// Stability tolerance: two renders of the identical scene must match within a
// tiny pixel-count budget (dawn rasterisation is deterministic, so this is
// effectively 0; the small budget absorbs any nondeterministic dither).
const STABILITY_MAX_DIFF = Math.floor(TOTAL_PIXELS * 0.0001); // 48

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node setup ----------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-transform-hierarchy smoke');
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

// --- 2. Mock canvas with offscreen render target --------------------------

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

// --- 3. Engine imports + renderer bootstrap ---------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { GlobalTransform,
  ChildOf,
  projectHierarchy,
  propagateTransforms,
  Transform,
  registerPropagateTransforms,
} = await import('@forgeax/engine-scene');
const { setMalformedParentEdge } = await import('./malformed-hierarchy-edge.mjs');
const {
  HANDLE_CUBE,
  HANDLE_SPHERE,
} = await import('@forgeax/engine-assets-runtime');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-transform-hierarchy] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}


// Mint standard PBR material as a user-tier shared ref (same as demo main.ts).
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const materialHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.7, 0.7, 0.7],
    metallic: 0.0,
    roughness: 0.4,
  },
});

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 4. Build the ONE World with the hierarchy consume path wired -----------

// The line that makes the hierarchy take effect: propagate derives every
// entity's GlobalTransform.world each frame (the required C-carrier output).
registerPropagateTransforms(world);

const PARENT_X_REST = -0.6;
const PARENT_X_MOVED = 1.0;

const parent = world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [PARENT_X_REST, -0.4, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

// Child: ChildOf{parent} + local +Y offset. No Transform write happens to the
// child between frames -- its rendered world position changes ONLY because the
// parent's GlobalTransform.world propagates down the ChildOf edge.
const child = world
  .spawn(
    {
      component: Transform,
      data: { pos: [0, 2.0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: ChildOf, data: { parent } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

// Static reference sphere -- not in the hierarchy.
const staticSphere = world
  .spawn(
    {
      component: Transform,
      data: { pos: [1.4, 0.0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  )
  .unwrap();

// Probe-only entities have no render components. They exercise a bounded
// cycle without changing the visible parent/child and static-sibling oracle.
const cycleA = world
  .spawn(
    { component: Transform, data: { pos: [-2, -2, 0] } },
    { component: ChildOf, data: { parent } },
  )
  .unwrap();
const cycleB = world
  .spawn(
    { component: Transform, data: { pos: [2, -2, 0] } },
    { component: ChildOf, data: { parent } },
  )
  .unwrap();

world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  })
  .unwrap();

world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 7]} },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
  )
  .unwrap();

// --- 5. readback helper -----------------------------------------------------

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

  // BGRA -> RGBA repack + pad removal.
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tight[dst + 0] = raw[off + 0] ?? 0; // R
      tight[dst + 1] = raw[off + 1] ?? 0; // G
      tight[dst + 2] = raw[off + 2] ?? 0; // B
      tight[dst + 3] = raw[off + 3] ?? 0; // A
    }
  }
  return tight;
}

function readWorld(entity) {
  return Array.from(world.get(entity, GlobalTransform).unwrap().world);
}

function setParentIfNeeded(entity, nextParent) {
  const current = world.get(entity, ChildOf);
  if (current.ok && current.value.parent === nextParent) return { ok: true, changed: false };
  const result = world.set(entity, ChildOf, { parent: nextParent });
  return { ok: result.ok, changed: true, error: result.ok ? undefined : result.error.code };
}

function maxAbsDiff(left, right) {
  let maximum = 0;
  for (let index = 0; index < left.length; index++) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function countNonBlack(pixels) {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) n++;
  }
  return n;
}

function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      n++;
    }
  }
  return n;
}

// --- 6. Error tracker -----------------------------------------------------

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

// --- 7. Frame A (parent at rest) -------------------------------------------

let framesObserved = 0;
world.update(1 / 60).unwrap(); // runs propagateTransforms so child GlobalTransform.world is composed
const drawARes = renderer.draw({ leases: [worldAttachment1.value], camera: { lease: worldAttachment1.value }, environment: { lease: worldAttachment1.value } });
if (!drawARes.ok) {
  console.error(`[smoke] FAIL - draw (frame A) failed: ${drawARes.error.code}`);
  process.exit(1);
}
(await drawARes.value.completed).unwrap();
framesObserved += 1;
await device.queue.onSubmittedWorkDone();
const pixelsA = await doReadPixels();

// --- 8. M23 malformed hierarchy -> same-process recovery ------------------

const baselineHierarchy = projectHierarchy(world);
const baselineChildWorld = readWorld(child);
const baselineStaticWorld = readWorld(staticSphere);
// 0xffffffff is the ECS null-entity sentinel, not a stale handle. Allocate
// and retire a real entity so the hierarchy projection exercises liveness.
const staleParent = world.spawn({ component: Transform, data: {} }).unwrap();
world.despawn(staleParent).unwrap();
// Public World.set rejects stale targets and cycles. The test-owned internal
// fixture below deliberately damages only the source column, preserving the
// production write boundary while exercising Scene diagnostics/recovery.
setMalformedParentEdge(world, child, staleParent, ChildOf);
setMalformedParentEdge(world, cycleA, cycleB, ChildOf);
setMalformedParentEdge(world, cycleB, cycleA, ChildOf);
const faultHierarchy = projectHierarchy(world);
const faultPropagation = propagateTransforms(world, faultHierarchy);
const drawFaultRes = renderer.draw({ leases: [worldAttachment1.value], camera: { lease: worldAttachment1.value }, environment: { lease: worldAttachment1.value } });
if (!drawFaultRes.ok) {
  console.error(`[smoke] FAIL - draw (fault frame) failed: ${drawFaultRes.error.code}`);
  process.exit(1);
}
(await drawFaultRes.value.completed).unwrap();
framesObserved += 1;
await device.queue.onSubmittedWorkDone();
const pixelsFault = await doReadPixels();

const cycleDiagnostics = faultHierarchy.diagnostics.filter((item) => item.code === 'hierarchy-cycle');
const brokenDiagnostics = faultHierarchy.diagnostics.filter((item) => item.code === 'hierarchy-broken');
const faultCycleMembers = cycleDiagnostics.map((item) => item.detail.entity).sort((a, b) => a - b);
const expectedCycleMembers = [cycleA, cycleB].sort((a, b) => a - b);
const repairEdges = [
  setParentIfNeeded(child, parent),
  setParentIfNeeded(cycleA, parent),
  setParentIfNeeded(cycleB, parent),
];
const repairedHierarchy = projectHierarchy(world);
const repairedPropagation = propagateTransforms(world, repairedHierarchy);
const drawRepairedRes = renderer.draw({ leases: [worldAttachment1.value], camera: { lease: worldAttachment1.value }, environment: { lease: worldAttachment1.value } });
if (!drawRepairedRes.ok) {
  console.error(`[smoke] FAIL - draw (repaired frame) failed: ${drawRepairedRes.error.code}`);
  process.exit(1);
}
(await drawRepairedRes.value.completed).unwrap();
framesObserved += 1;
await device.queue.onSubmittedWorkDone();
const pixelsRepaired = await doReadPixels();
const repeatedCleanup = [
  setParentIfNeeded(child, parent),
  setParentIfNeeded(cycleA, parent),
  setParentIfNeeded(cycleB, parent),
];
const repeatedHierarchy = projectHierarchy(world);
const repeatedPropagation = propagateTransforms(world, repeatedHierarchy);
const repairedChildWorld = readWorld(child);
const repairedStaticWorld = readWorld(staticSphere);

console.log(
  `[m23] Dawn hierarchy diagnostics=${JSON.stringify({
    broken: brokenDiagnostics.map((item) => item.detail),
    cycles: cycleDiagnostics.map((item) => item.detail),
    propagation: faultPropagation.ok ? { ok: true } : {
      ok: false,
      code: faultPropagation.error.code,
      expected: faultPropagation.error.expected,
      hint: faultPropagation.error.hint,
      detail: faultPropagation.error.detail,
    },
  })}`,
);

// --- 9. Stability re-render (parent still at rest) -------------------------

world.update(1 / 60).unwrap();
const drawAARes = renderer.draw({ leases: [worldAttachment1.value], camera: { lease: worldAttachment1.value }, environment: { lease: worldAttachment1.value } });
if (!drawAARes.ok) {
  console.error(`[smoke] FAIL - draw (stability frame) failed: ${drawAARes.error.code}`);
  process.exit(1);
}
(await drawAARes.value.completed).unwrap();
framesObserved += 1;
await device.queue.onSubmittedWorkDone();
const pixelsAA = await doReadPixels();

// --- 10. Frame B (parent moved -> child must follow) ------------------------

const setRes = world.set(parent, Transform, { pos: [PARENT_X_MOVED, 0, 0]});
if (!setRes.ok) {
  console.error(`[smoke] FAIL - world.set(parent move) failed: ${setRes.error.code}`);
  process.exit(1);
}
world.update(1 / 60).unwrap(); // re-runs propagateTransforms; child GlobalTransform.world follows parent
const drawBRes = renderer.draw({ leases: [worldAttachment1.value], camera: { lease: worldAttachment1.value }, environment: { lease: worldAttachment1.value } });
if (!drawBRes.ok) {
  console.error(`[smoke] FAIL - draw (frame B) failed: ${drawBRes.error.code}`);
  process.exit(1);
}
(await drawBRes.value.completed).unwrap();
framesObserved += 1;
await device.queue.onSubmittedWorkDone();
const pixelsB = await doReadPixels();

for (let frame = framesObserved; frame < FLEET_FRAME_COUNT; frame += 1) {
  world.update(1 / 60).unwrap();
  const draw = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!draw.ok) {
    console.error(`[smoke] FAIL - fleet frame ${frame + 1} failed: ${draw.error.code}`);
    process.exit(1);
  }
  (await draw.value.completed).unwrap();
  framesObserved += 1;
}
console.log(`[smoke] frames observed=${framesObserved}`);

// --- 11. Verdict -----------------------------------------------------------

const failures = [];

// (a) Backend must be webgpu.
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}

// (b) All frames must produce valid buffers.
for (const [label, px] of [
  ['A', pixelsA],
  ['fault', pixelsFault],
  ['repaired', pixelsRepaired],
  ['AA', pixelsAA],
  ['B', pixelsB],
]) {
  if (px.length !== TOTAL_PIXELS * 4) {
    failures.push(`(b) frame ${label} pixel buffer size mismatch: ${px.length} != ${TOTAL_PIXELS * 4}`);
  }
}

// (c) RhiError must be zero. The "hierarchy wired" guard is the parent-move
// diff below: Transform's generic requirement materializes the derived world
// column for every authored transform, so a child always follows once
// propagation runs without a scene-specific insertion scan.
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (d) Frames must be non-black (geometries rendered).
const nonBlackA = countNonBlack(pixelsA);
const nonBlackB = countNonBlack(pixelsB);
if (nonBlackA === 0) failures.push('(d) frame A is completely black (geometries not rendered)');
if (nonBlackB === 0) failures.push('(d) frame B is completely black (geometries not rendered)');

// (e) Stability: two renders of the rest scene must match (AC-08 parent-static
// reference frame is stable).
const stabilityDiff = countDiff(pixelsA, pixelsAA);
if (stabilityDiff > STABILITY_MAX_DIFF) {
  failures.push(
    `(e) parent-static reference frame unstable: stabilityDiff ${stabilityDiff} > ${STABILITY_MAX_DIFF}` +
      ` -- two identical-scene renders should be pixel-stable (charter P3: check for nondeterministic render state)`,
  );
}

// (f) Parent-move diff: moving the PARENT must move the CHILD's rendered world
// position (AC-08 child-follows-parent-displacement). diffCount > threshold.
const diffCount = countDiff(pixelsA, pixelsB);
const diffPct = ((diffCount / TOTAL_PIXELS) * 100).toFixed(4);
console.log(
  `[smoke] parentMoveDiff=${JSON.stringify({
    diffCount,
    threshold: DIFF_THRESHOLD,
    totalPixels: TOTAL_PIXELS,
    pct: diffPct,
    stabilityDiff,
    stabilityMax: STABILITY_MAX_DIFF,
    nonBlackA,
    nonBlackB,
  })}`,
);

if (diffCount <= DIFF_THRESHOLD) {
  failures.push(
    `(f) parent-move pixel diff ${diffCount} <= threshold ${DIFF_THRESHOLD} (${diffPct}%)` +
      ` -- child did NOT follow the parent's world displacement` +
      ` (charter P3: check registerPropagateTransforms(world) is wired and the` +
      ` extract stage reads GlobalTransform.world for ChildOf entities)`,
  );
}

const faultDiff = countDiff(pixelsA, pixelsFault);
const recoveryDiff = countDiff(pixelsA, pixelsRepaired);
if (faultPropagation.ok || brokenDiagnostics.length !== 1 || cycleDiagnostics.length !== 2) {
  failures.push('(g) malformed hierarchy did not produce both structured diagnostic families');
}
if (brokenDiagnostics[0]?.expected.length === 0 || brokenDiagnostics[0]?.hint.length === 0) {
  failures.push('(g) hierarchy-broken diagnostic omitted expected/hint recovery fields');
}
if (cycleDiagnostics.some((item) => item.expected.length === 0 || item.hint.length === 0 || item.detail.parent === undefined)) {
  failures.push('(g) hierarchy-cycle diagnostic omitted expected/hint/detail recovery fields');
}
if (JSON.stringify(faultCycleMembers) !== JSON.stringify(expectedCycleMembers)) {
  failures.push(`(g) cycle membership was not deterministic: ${JSON.stringify(faultCycleMembers)}`);
}
if (faultHierarchy === baselineHierarchy || repairedHierarchy === faultHierarchy || repeatedHierarchy !== repairedHierarchy) {
  failures.push('(g) hierarchy projection cache identity did not invalidate/reuse at the correct boundaries');
}
if (!repairedPropagation.ok || !repeatedPropagation.ok || repairedHierarchy.diagnostics.length !== 0 || repeatedHierarchy.diagnostics.length !== 0) {
  failures.push('(g) same-process repair did not clear hierarchy diagnostics');
}
if (repairEdges.some((item) => !item.ok) || repeatedCleanup.some((item) => !item.ok) || repeatedCleanup.some((item) => item.changed)) {
  failures.push('(g) repeated cleanup was not idempotent');
}
if (maxAbsDiff(baselineChildWorld, repairedChildWorld) > 1e-6) {
  failures.push(`(g) repaired child world differs from baseline by ${maxAbsDiff(baselineChildWorld, repairedChildWorld)}`);
}
if (maxAbsDiff(baselineStaticWorld, repairedStaticWorld) > 1e-6) {
  failures.push(`(g) static sibling world was contaminated by malformed hierarchy`);
}
if (faultDiff <= DIFF_THRESHOLD || recoveryDiff > STABILITY_MAX_DIFF) {
  failures.push(`(g) pixel recovery falsifier failed: faultDiff=${faultDiff}, recoveryDiff=${recoveryDiff}`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[m23] Dawn structured hierarchy recovery: PASS ${JSON.stringify({
    projectionIds: [baselineHierarchy === faultHierarchy, faultHierarchy === repairedHierarchy, repairedHierarchy === repeatedHierarchy],
    diagnostics: { broken: brokenDiagnostics.length, cycles: cycleDiagnostics.length },
    faultDiff,
    recoveryDiff,
    staticWorldMaxDiff: maxAbsDiff(baselineStaticWorld, repairedStaticWorld),
  })}`,
);

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, RhiError count=${errors.length}, ` +
    `nonBlackA=${nonBlackA}, nonBlackB=${nonBlackB}, stabilityDiff=${stabilityDiff} <= ${STABILITY_MAX_DIFF}, ` +
    `parentMoveDiff=${diffCount} > threshold=${DIFF_THRESHOLD} (${diffPct}%)`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
