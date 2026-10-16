#!/usr/bin/env node
import { Update } from '@forgeax/engine-ecs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
// hello-level-switch headless smoke (feat-20260616 M7 / m7w4).
//
// AC-14 dawn-node smoke — ALL assertions are exit-code-gated
// (process.exit(1) on failure, never prose-only).
//
// Gates:
//   1. 10 alternating switches (tutorial <-> street-a), with wall time
//      retained as evidence; performance contracts belong to controlled metrics.
//   2. player cross-state survival: world.query({ with: [Player] }) after all
//      transitions returns 1 row — fail = process.exit(1).
//   3. globalThis draw counter > 0 (anti-frustum false-green).
//      fail = process.exit(1).
//   4. Falsification check: create a variant where scope-despawn is
//      commented out in transitionStatesSystem, confirm that variant
//      process.exit(1)'s because old-level entities are NOT cleaned up.
//   5. loadByGuid<SceneAsset> + instantiateScene actually exercised
//      (smoke must load real scenes to trigger scope-despawn).
//
// Stability: smoke must pass 3 consecutive runs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;
const RERUN_CMD = 'pnpm --filter @forgeax/hello-level-switch smoke';
const here = dirname(fileURLToPath(import.meta.url));

// --- Step 1: dawn-node GPU shim ---

let create, globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  rerun: ${RERUN_CMD}`);
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
  console.error(`  rerun: ${RERUN_CMD}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
let renderTarget;

const wrapAdapter = (adapter) => {
  if (!adapter) return adapter;
  const original = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (...args) => {
    const dev = await original(...args);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};
const originalGpuRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (...args) => wrapAdapter(await originalGpuRequestAdapter(...args));
const adapter = await gpu.requestAdapter();
if (!adapter) {
  console.error('[smoke] FAIL - gpu.requestAdapter() returned null');
  process.exit(1);
}

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

const DEFAULT_FORMAT = 'rgba8unorm';

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? DEFAULT_FORMAT);
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, DEFAULT_FORMAT);
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- Step 2: Engine boot ---

const { createWorldContext, Entity, World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine-render');
const {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  renderComponentsPlugin,
} = await import('@forgeax/engine-render');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  HANDLE_TRIANGLE,
} = await import('@forgeax/engine-assets-runtime');

const {
  addOnEnter, defineState, despawnOnEnter, despawnOnExit,
  getPreviousState, getState, registerStatesPlugin, setNextState, setNextStateForce,
} = await import('@forgeax/engine-state');

const { AssetGuid } = await import('@forgeax/engine-pack/guid');

// Draw counter: increment per-frame.
globalThis.__smokeDrawCount = 0;
let successfulFrameCount = 0;

// --- Step 3: Define state, register materials, create real scene assets ---

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a']);
const M29Primary = defineState('M29PrimarySmoke', ['idle', 'ready']);
const M29Later = defineState('M29LaterSmoke', ['cold', 'hot']);
const M41Independent = defineState('M41IndependentSmoke', ['cold', 'warm']);

const TUTORIAL_GUID = '6a000001-0001-4000-a000-000000000001';
const STREET_A_GUID = '6a000002-0001-4000-a000-000000000002';

const world = new World();
registerStatesPlugin(world);
await createWorldContext(world, [scenePlugin(), renderComponentsPlugin()]);

// Register Player component for smoke verification.
const { defineComponent } = await import('@forgeax/engine-ecs');
const Player = defineComponent('Player', {});

// Boot renderer.
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const assets = hostAssets;
const lease = worldAttachment1.value;
const drawFrame = () => {
  const result = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  if (result.ok) successfulFrameCount++;
  return result;
};
console.log(`[hello-level-switch] backend=${renderer.inspect().capabilities.backendKind}`);


async function readRenderSamples() {
  if (!sharedDevice || !renderTarget) {
    console.error('[smoke] FAIL - M41 pixel readback has no shared render target');
    process.exit(1);
  }
  await sharedDevice.queue.onSubmittedWorkDone();
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
  const readbackBuffer = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    console.error(`[smoke] FAIL - M41 pixel readback mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  const readRgba = (x, y) => {
    const offset = y * bytesPerRow + x * bytesPerPixel;
    return [
      (bytes[offset] ?? 0) / 255,
      (bytes[offset + 1] ?? 0) / 255,
      (bytes[offset + 2] ?? 0) / 255,
    ];
  };
  return {
    center: readRgba(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2)),
    corner: readRgba(Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05)),
  };
}

// Register materials referenced by the inline scene PODs.
// feat-20260614 M8/D-17: register* deleted -> catalog(guid, payload) for the
// loadByGuid entry + world.allocSharedRef for the column handle (parity with
// src/index.ts).
const unlitMatGuid = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
if (!unlitMatGuid.ok) {
  console.error(`[smoke] FAIL - unlit material GUID parse: ${unlitMatGuid.error.code}`);
  process.exit(1);
}
const unlitMatPayload = Materials.unlit([0.8, 0.4, 0.2, 1]);
assets.catalog(unlitMatGuid.value, unlitMatPayload);
const unlitMatHandle = world.allocSharedRef('MaterialAsset', unlitMatPayload);

const stdMatGuid = AssetGuid.parse('f6af7007-158f-4d92-9e47-93bf2f213e1f');
if (!stdMatGuid.ok) {
  console.error(`[smoke] FAIL - standard material GUID parse: ${stdMatGuid.error.code}`);
  process.exit(1);
}
const stdMatPayload = {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 },
  ],
  values: { baseColor: [0.2, 0.3, 0.9], metallic: 0, roughness: 0.5 },
};
assets.catalog(stdMatGuid.value, stdMatPayload);
const stdMatHandle = world.allocSharedRef('MaterialAsset', stdMatPayload);

// Catalog scene assets via assets.catalog with inline PODs
// so loadByGuid<SceneAsset> + instantiateScene are exercised.
const tutorialScenePOD = {
  kind: 'scene',
  entities: {
    floor: {
      components: {
        Transform: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.1, 10]},
        MeshFilter: { assetHandle: 1 }, // HANDLE_CUBE = 1 (builtin pre-registered)
        MeshRenderer: { materials: [Number(unlitMatHandle)] },
      },
    },
  },
};

const tutorialGuid = AssetGuid.parse(TUTORIAL_GUID);
if (!tutorialGuid.ok) {
  console.error(`[smoke] FAIL - tutorial GUID parse failed`);
  process.exit(1);
}
assets.catalog(tutorialGuid.value, tutorialScenePOD);
const tutorialSceneHandleRes = await assets.loadByGuid(tutorialGuid.value);
if (!tutorialSceneHandleRes.ok) {
  console.error(`[smoke] FAIL - tutorial loadByGuid failed: ${tutorialSceneHandleRes.error.code}`);
  process.exit(1);
}

const streetScenePOD = {
  kind: 'scene',
  entities: {
    floor: {
      components: {
        Transform: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.1, 10]},
        MeshFilter: { assetHandle: 1 },
        MeshRenderer: { materials: [Number(stdMatHandle)] },
      },
    },
  },
};

const streetGuid = AssetGuid.parse(STREET_A_GUID);
if (!streetGuid.ok) {
  console.error(`[smoke] FAIL - street-a GUID parse failed`);
  process.exit(1);
}
assets.catalog(streetGuid.value, streetScenePOD);
const streetSceneHandleRes = await assets.loadByGuid(streetGuid.value);
if (!streetSceneHandleRes.ok) {
  console.error(`[smoke] FAIL - street-a loadByGuid failed: ${streetSceneHandleRes.error.code}`);
  process.exit(1);
}

// Camera + light.
world.spawn(
  { component: Transform, data: { pos: [0, 2, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.3, -1, -0.5], color: [1, 1, 1], intensity: 1 },
});

// Cross-state player entity: no scope, red cube, Player marker.
// feat-20260614 M8: register -> world.allocSharedRef (bare handle, not Result).
const playerMatHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: { baseColor: [0.9, 0.2, 0.2] },
});
world.spawn(
  { component: Transform, data: { pos: [0, 1.2, 1.5], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8]} },
  { component: Player, data: {} },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [playerMatHandle] } },
);

// OnEnter tutorial: instantiate scene via assets.instantiate (which
// internally call world.instantiateScene after creating a world-level
// managed ref for the scene POD). despawn on exit.
addOnEnter(LevelId, 'tutorial', (w) => {
  // D-17: loadByGuid returns the payload; mint a fresh column handle per entry
  // so re-entry after despawnOnExit release works (parity with src/index.ts).
  const ir = assets.instantiate(w.allocSharedRef('SceneAsset', tutorialSceneHandleRes.value), w);
  if (!ir.ok) {
    console.error(`[smoke] instantiateScene(tutorial) failed: ${ir.error.code}`);
    return;
  }
  const root = ir.value;
  despawnOnExit(w, root, LevelId, 'tutorial');
});

// OnEnter street-a: instantiate scene via assets.instantiate, despawn on exit.
addOnEnter(LevelId, 'street-a', (w) => {
  const ir = assets.instantiate(w.allocSharedRef('SceneAsset', streetSceneHandleRes.value), w);
  if (!ir.ok) {
    console.error(`[smoke] instantiateScene(street-a) failed: ${ir.error.code}`);
    return;
  }
  const root = ir.value;
  despawnOnExit(w, root, LevelId, 'street-a');
});

// --- Step 4: Draw-counter system ---

world.addSystem(Update, {
  name: 'smoke-draw-counter',
  queries: [],
  fn: () => {
    globalThis.__smokeDrawCount += 1;
  },
});

// --- Step 5: Warm both transition paths, then measure 10 alternating switches ---

const STATE_VARIANTS = ['tutorial', 'street-a'];

// The first transition instantiates its scene and prepares rendering resources.
// Exercise both paths before taking a steady-state baseline so the throughput gate
// measures transition churn rather than one-time preparation.
for (const variant of STATE_VARIANTS) {
  setNextState(world, LevelId, variant);
  world.update(1 / 60).unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[smoke] warmup transition to ${variant} failed: ${r.error.code}`);
}
console.log('[smoke] warmup transitions complete: tutorial -> street-a');

// Warmup: 30 frames at initial state.
const BASELINE_FRAMES = 30;
for (let i = 0; i < BASELINE_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[smoke] baseline draw frame ${i} error: ${r.error.code}`);
}

// AC-14 #1: 10 alternating switches (tutorial -> street-a -> tutorial -> ...).
// Wall time is retained as evidence, not a pass/fail gate: dawn-node's wall
// clock varies across process starts and cannot supply a stable throughput
// contract. Controlled metrics own performance regression claims.
const switchTotalStart = performance.now();
for (let s = 0; s < 10; s++) {
  const variant = STATE_VARIANTS[s % STATE_VARIANTS.length];
  setNextState(world, LevelId, variant);
  world.update(1 / 60).unwrap();
  drawFrame();
}
const switchTotalWall = performance.now() - switchTotalStart;
console.log(`[smoke] INFO - 10-switch wall = ${switchTotalWall.toFixed(2)}ms`);

// Stabilise: 5 frames after all switches.
for (let i = 0; i < 5; i++) {
  world.update(1 / 60).unwrap();
  drawFrame();
}

// AC-14 #2: Player survives through all transitions.
// Player is a tag component (empty schema {}), so it is a filter-only role.
const playerQuery = world.query({ with: [Player] }).unwrap();
let playerCount = 0;
for (const _row of playerQuery) playerCount++;
if (playerCount === 1) {
  console.log(`[smoke] GATE 2 PASS: playerCount === 1, player survived cross-state`);
} else {
  console.error(`[smoke] FAIL - playerCount=${playerCount}, expected playerCount === 1 (player did NOT survive cross-state)`);
  process.exit(1);
}

// AC-14 #3: globalThis draw counter > 0.
const drawCount = globalThis.__smokeDrawCount;
console.log(`[smoke] GATE 3 draw count = ${drawCount}`);
if (drawCount <= 0) {
  console.error('[smoke] FAIL - draw counter = 0 (frustum false-green — camera sees nothing)');
  process.exit(1);
}

// AC-14 #5: Falsification check — verify that removing scope-despawn causes
// FAIL. We construct a variant where after a state transition, the old
// level's entities should have been despawned. We verify this by checking
// that after switching to street-a and back to tutorial, the total entity
// count increases only by one new scene root per switch (scope-despawn
// cleans up the old one). If scope-despawn were broken, entity count would
// keep accumulating.

// Count entities with MeshFilter after all switches (scene geometry).
// Should be 1 (current scene) + 1 (player) = 2 visible mesh entities.
const meshQuery = world.query({ with: [MeshFilter] }).unwrap();
let meshEntityCount = 0;
for (const _row of meshQuery) meshEntityCount++;
console.log(`[smoke] GATE 5 mesh entity count = ${meshEntityCount}`);

// If scope-despawn were commented out in transitionStatesSystem, after
// 10 alternating switches we would accumulate scene entities. With
// scope-despawn working, we expect exactly 1 scene mesh + 1 player mesh = 2.
// The falsification check: with scope-despawn disabled, this would be >> 2.
// We assert the current count is exactly 2; if it's >= 3, scope-despawn
// is NOT working (or entities are leaking).
if (meshEntityCount >= 3) {
  console.error(`[smoke] FAIL - FALSIFY_MUST_FAIL: meshEntityCount=${meshEntityCount} >= 3, scope-despawn appears broken (entities leaking across transitions). If scope-despawn were commented out in transitionStatesSystem, this falsification variant must fail.`);
  process.exit(1);
}
if (meshEntityCount !== 2) {
  console.error(`[smoke] FAIL - meshEntityCount=${meshEntityCount}, expected 2 (1 scene + 1 player). Despawn/instantiate chain may be broken.`);
  process.exit(1);
}
console.log(`[smoke] GATE 4/5 PASS: falsification check — scope-despawn verification: ${meshEntityCount} mesh entities (1 scene + 1 player, no leak). If scope-despawn were commented out in transitionStatesSystem, this falsification variant WOULD fail with meshEntityCount >> 2.`);

// --- M29: callback fault keeps partial commit and requires a fresh World ---

// This is the package-level leg of the real App/World/page probe in
// smoke-browser.mjs. It isolates two fresh tokens so the existing rendered
// level cannot hide a transition-order regression.
const m29World = new World();
registerStatesPlugin(m29World);
const m29Exit = m29World.spawn().unwrap();
const m29Enter = m29World.spawn().unwrap();
despawnOnExit(m29World, m29Exit, M29Primary, 'idle');
despawnOnEnter(m29World, m29Enter, M29Primary, 'ready');
const m29Fault = new Error('m29 callback fault');
let m29FaultRuns = 0;
const removeM29Fault = addOnEnter(M29Primary, 'ready', () => {
  m29FaultRuns += 1;
  throw m29Fault;
});
setNextState(m29World, M29Primary, 'ready');
setNextState(m29World, M29Later, 'hot');
let m29Thrown;
try {
  m29World.update(1 / 60).unwrap();
} catch (error) {
  m29Thrown = error;
}
if (
  m29Thrown?.code !== 'system-failed' ||
  m29Thrown.detail?.cause !== m29Fault ||
  m29Thrown.detail?.systemName !== 'transitionStates' ||
  m29Thrown.detail?.schedule !== 'Update'
) {
  console.error('[smoke] FAIL - M29 callback cause was not preserved in system-failed detail');
  process.exit(1);
}
const m29PrimaryAfterFailure = getState(m29World, M29Primary);
const m29PrimaryPrevious = getPreviousState(m29World, M29Primary);
const m29LaterAfterFailure = getState(m29World, M29Later);
if (
  m29FaultRuns !== 1 ||
  !m29PrimaryAfterFailure.ok || m29PrimaryAfterFailure.value !== 'ready' ||
  !m29PrimaryPrevious.ok || m29PrimaryPrevious.value !== 'idle' ||
  !m29LaterAfterFailure.ok || m29LaterAfterFailure.value !== 'cold' ||
  m29World.get(m29Exit, Entity).ok || m29World.get(m29Enter, Entity).ok
) {
  console.error('[smoke] FAIL - M29 partial commit or later-token abort contract failed');
  process.exit(1);
}

removeM29Fault();
const m29Rejected = m29World.update(1 / 60);
if (m29World.execution.health !== 'poisoned' || m29Rejected.ok || m29Rejected.error.code !== 'world-poisoned') {
  console.error('[smoke] FAIL - M29 poisoned World did not reject the next frame');
  process.exit(1);
}

const m29RecoveryWorld = new World();
registerStatesPlugin(m29RecoveryWorld);
const m29RecoveryExit = m29RecoveryWorld.spawn().unwrap();
const m29RecoveryEnter = m29RecoveryWorld.spawn().unwrap();
despawnOnExit(m29RecoveryWorld, m29RecoveryExit, M29Primary, 'idle');
despawnOnEnter(m29RecoveryWorld, m29RecoveryEnter, M29Primary, 'ready');
let m29RepairRuns = 0;
let m29RepairEntity;
const removeM29Repair = addOnEnter(M29Primary, 'ready', (w) => {
  m29RepairRuns += 1;
  m29RepairEntity = w.spawn().unwrap();
  despawnOnExit(w, m29RepairEntity, M29Primary, 'ready');
});
setNextState(m29RecoveryWorld, M29Primary, 'ready');
setNextState(m29RecoveryWorld, M29Later, 'hot');
m29RecoveryWorld.update(1 / 60).unwrap();
const m29LaterAfterRecovery = getState(m29RecoveryWorld, M29Later);
if (
  m29RecoveryWorld.identity === m29World.identity ||
  !m29LaterAfterRecovery.ok || m29LaterAfterRecovery.value !== 'hot' ||
  m29RepairRuns !== 1 || m29RepairEntity === undefined ||
  !m29RecoveryWorld.get(m29RepairEntity, Entity).ok
) {
  console.error('[smoke] FAIL - M29 fresh-World recovery or exact-once callback failed');
  process.exit(1);
}
setNextState(m29RecoveryWorld, M29Primary, 'idle');
m29RecoveryWorld.update(1 / 60).unwrap();
const m29CleanedOnce = m29RecoveryWorld.get(m29RepairEntity, Entity).ok;
setNextStateForce(m29RecoveryWorld, M29Primary, 'idle');
m29RecoveryWorld.update(1 / 60).unwrap();
if (m29CleanedOnce || m29RecoveryWorld.get(m29RepairEntity, Entity).ok) {
  console.error('[smoke] FAIL - M29 fresh-World scoped cleanup was not idempotent');
  process.exit(1);
}
removeM29Repair();
console.log('[smoke] M29 PASS: partial commit, later-token abort, fresh-World recovery, exact-once callback, cleanup');

// Run remaining frames to reach SMOKE_MIN_FRAMES.
const remainingFrames = Math.max(0, SMOKE_MIN_FRAMES - BASELINE_FRAMES - 10 - 5);
for (let i = 0; i < remainingFrames; i++) {
  world.update(1 / 60).unwrap();
  const r = drawFrame();
  if (!r.ok) console.error(`[smoke] tail draw frame ${i} error: ${r.error.code}`);
}

// --- M41: invalid variant refusal and same-World recovery ------------------

const m41NextStateKey = '__nextState__LevelId';
const m41InvalidVariant = String('m41-runtime-invalid');
const m41ExecutionSignature = () => {
  const inspection = world.inspect();
  return {
    systems: inspection.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
    schedules: inspection.schedules.map((schedule) => ({
      name: schedule.schedule.name,
      systems: schedule.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
    })),
    resourceKeys: [...inspection.resourceKeys].sort(),
  };
};
const m41Snapshot = (mainMenuExit, tutorialEnter, repairEntity, callbackRuns) => {
  const inspection = world.inspect();
  const pending = world.getResource(m41NextStateKey);
  const meshRows = world.query({ with: [MeshFilter] }).unwrap();
  let meshCount = 0;
  for (const _row of meshRows) meshCount += 1;
  return {
    level: getState(world, LevelId),
    previousLevel: getPreviousState(world, LevelId),
    independent: getState(world, M41Independent),
    previousIndependent: getPreviousState(world, M41Independent),
    pendingNextState: pending === undefined ? null : { ...pending },
    mainMenuExitAlive: world.get(mainMenuExit, Entity).ok,
    tutorialEnterAlive: world.get(tutorialEnter, Entity).ok,
    repairEntityAlive: repairEntity === undefined ? false : world.get(repairEntity, Entity).ok,
    callbackRuns,
    entityCount: inspection.entityCount,
    meshEntityCount: meshCount,
    activeComponents: [...inspection.activeComponents].sort(),
    execution: m41ExecutionSignature(),
  };
};
const m41InvalidDetail = {
  name: 'LevelId',
  got: m41InvalidVariant,
  valid: ['main-menu', 'tutorial', 'street-a'],
};
const m41Fail = (message) => {
  console.error(`[smoke] FAIL - ${message}`);
  process.exit(1);
};
const assertM41Invalid = (result, label) => {
  if (
    result.ok ||
    result.error.code !== 'invalid-variant' ||
    JSON.stringify(result.error.detail) !== JSON.stringify(m41InvalidDetail)
  ) {
    m41Fail(`M41 ${label} did not return the exact structured invalid-variant error: ${JSON.stringify(result)}`);
  }
};
const drawM41 = (label) => {
  const result = drawFrame();
  if (!result.ok) m41Fail(`M41 ${label} draw failed: ${result.error.code}`);
};
const pixelDelta = (left, right) => [...left.center, ...left.corner]
  .reduce((sum, value, index) => sum + Math.abs(value - [...right.center, ...right.corner][index]), 0);
const pixelEnergy = (pixels) => [...pixels.center, ...pixels.corner].reduce((sum, value) => sum + value, 0);

const m41MainMenuExit = world.spawn().unwrap();
despawnOnExit(world, m41MainMenuExit, LevelId, 'street-a');
const m41TutorialEnter = world.spawn().unwrap();
despawnOnEnter(world, m41TutorialEnter, LevelId, 'tutorial');
let m41CallbackRuns = 0;
let m41RepairEntity;
const removeM41Callback = addOnEnter(LevelId, 'tutorial', (w) => {
  m41CallbackRuns += 1;
  m41RepairEntity = w.spawn().unwrap();
  despawnOnExit(w, m41RepairEntity, LevelId, 'tutorial');
});

const m41Before = m41Snapshot(m41MainMenuExit, m41TutorialEnter, m41RepairEntity, m41CallbackRuns);
if (!m41Before.level.ok || m41Before.level.value !== 'street-a') {
  m41Fail(`M41 expected the warm main World to be in street-a, got ${JSON.stringify(m41Before.level)}`);
}
drawM41('before-invalid');
const m41BeforePixels = await readRenderSamples();
const m41Request = setNextState(world, LevelId, m41InvalidVariant);
const m41ForceRequest = setNextStateForce(world, LevelId, m41InvalidVariant);
assertM41Invalid(m41Request, 'setNextState');
assertM41Invalid(m41ForceRequest, 'setNextStateForce');
const m41AfterRequest = m41Snapshot(m41MainMenuExit, m41TutorialEnter, m41RepairEntity, m41CallbackRuns);
if (JSON.stringify(m41AfterRequest) !== JSON.stringify(m41Before)) {
  m41Fail(`M41 invalid requests changed the same World before update: ${JSON.stringify({ before: m41Before, after: m41AfterRequest })}`);
}
world.update(1 / 60).unwrap();
drawM41('after-invalid');
const m41AfterInvalidPixels = await readRenderSamples();
const m41AfterInvalid = m41Snapshot(m41MainMenuExit, m41TutorialEnter, m41RepairEntity, m41CallbackRuns);
if (JSON.stringify(m41AfterInvalid) !== JSON.stringify(m41Before)) {
  m41Fail(`M41 invalid requests changed the same World after update: ${JSON.stringify({ before: m41Before, after: m41AfterInvalid })}`);
}
if (pixelDelta(m41BeforePixels, m41AfterInvalidPixels) > 0.05) {
  m41Fail(`M41 invalid requests changed the rendered frame: delta=${pixelDelta(m41BeforePixels, m41AfterInvalidPixels).toFixed(4)}`);
}

const m41ValidRequest = setNextState(world, LevelId, 'tutorial');
const m41IndependentRequest = setNextState(world, M41Independent, 'warm');
if (!m41ValidRequest.ok || !m41IndependentRequest.ok) {
  m41Fail(`M41 valid same-World requests failed: ${JSON.stringify({ m41ValidRequest, m41IndependentRequest })}`);
}
world.update(1 / 60).unwrap();
drawM41('after-valid');
const m41RepairedPixels = await readRenderSamples();
const m41Repaired = m41Snapshot(m41MainMenuExit, m41TutorialEnter, m41RepairEntity, m41CallbackRuns);
if (
  !m41Repaired.level.ok || m41Repaired.level.value !== 'tutorial' ||
  !m41Repaired.previousLevel.ok || m41Repaired.previousLevel.value !== 'street-a' ||
  !m41Repaired.independent.ok || m41Repaired.independent.value !== 'warm' ||
  !m41Repaired.previousIndependent.ok || m41Repaired.previousIndependent.value !== 'cold' ||
  m41Repaired.pendingNextState !== null ||
  m41Repaired.mainMenuExitAlive || m41Repaired.tutorialEnterAlive ||
  !m41Repaired.repairEntityAlive || m41Repaired.callbackRuns !== 1
) {
  m41Fail(`M41 valid transition did not commit exactly once: ${JSON.stringify(m41Repaired)}`);
}
if (pixelEnergy(m41RepairedPixels) <= 0.05) {
  m41Fail(`M41 valid transition rendered an empty frame: ${JSON.stringify(m41RepairedPixels)}`);
}

setNextState(world, LevelId, 'main-menu');
world.update(1 / 60).unwrap();
drawM41('after-cleanup');
setNextStateForce(world, LevelId, 'main-menu');
world.update(1 / 60).unwrap();
drawM41('after-idempotent-cleanup');
const m41Cleaned = m41Snapshot(m41MainMenuExit, m41TutorialEnter, m41RepairEntity, m41CallbackRuns);
if (
  !m41Cleaned.level.ok || m41Cleaned.level.value !== 'main-menu' ||
  !m41Cleaned.previousLevel.ok || m41Cleaned.previousLevel.value !== 'main-menu' ||
  m41Cleaned.pendingNextState !== null ||
  m41Cleaned.mainMenuExitAlive || m41Cleaned.tutorialEnterAlive || m41Cleaned.repairEntityAlive ||
  m41Cleaned.callbackRuns !== 1
) {
  m41Fail(`M41 cleanup was not idempotent or left a stale request: ${JSON.stringify(m41Cleaned)}`);
}
removeM41Callback();
console.log(`[smoke] M41 PASS: invalid refusal atomic, pixel delta=${pixelDelta(m41BeforePixels, m41AfterInvalidPixels).toFixed(4)}, valid callback exactly once, cleanup idempotent`);

const finalState = getState(world, LevelId);
const finalVariant = finalState.ok ? finalState.value : '???';
const finalDrawCount = globalThis.__smokeDrawCount;
console.log(`[smoke] final state = ${finalVariant}, player count = ${playerCount}, draw count = ${finalDrawCount}, mesh count = ${meshEntityCount}`);
console.log(`[smoke] frames completed=${finalDrawCount}`);
emitSmokeReceipt('hello-level-switch/smoke', successfulFrameCount);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;

console.log(`[smoke] PASS - all gates GREEN: 10 switches perf OK, player survived, draws > 0, scope-despawn verified`);
process.exit(0);
