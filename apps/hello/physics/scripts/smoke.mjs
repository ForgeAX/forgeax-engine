#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-physics headless smoke.
//
// Strategy: createApp with physics3d, spawn a dynamic sphere +
// static ground scene, start the app, poll for PhysicsWorld (async WASM), then
// run N frames with working tick systems, and assert the sphere's Transform pos y
// has decreased (gravity-driven free-fall).
//
// This smoke verifies the full createApp -> physics tick pipeline:
//   1. createApp(canvas, { plugins: [physics3d] }) succeeds.
//   2. app.start() + N-frame loop + app.stop() succeeds.
//   3. PhysicsWorld resource is inserted into World after WASM init.
//   4. Dynamic RigidBody has Transform pos y strictly lower than initial
//      after simulation advances (verifying the three-phase tick systems
//      -- physicsSyncBackend, physicsStepSimulation, physicsWriteback --
//      are registered and running, AC-04).
//
// Note: physics3d.apply awaits the Rapier WASM import -- Cordis activation in
// createApp resolves after the WASM module is loaded, so PhysicsWorld is
// populated before the first app frame. If the WASM fails to load within
// the timeout, the smoke FAILs (non-vacuous PASS).

import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WASM_LOAD_TIMEOUT_MS = Number.parseInt(process.env.FORGEAX_SMOKE_PHYSICS_WASM_TIMEOUT_MS ?? '10000', 10);

const WIDTH = 800;
const HEIGHT = 600;

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
const realPerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

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

const { default: physics3d } = await import('@forgeax/engine-physics-rapier3d');
const { createApp } = await import('@forgeax/engine-app/browser');
const { FixedTime, FixedUpdate, Time, Update } = await import('@forgeax/engine-ecs');

const runtimePkg = await import('@forgeax/engine-runtime');
const { Camera, DirectionalLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const physicsPkg = await import('@forgeax/engine-physics');
const {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,

} = physicsPkg;

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas),
  plugins: [physics3d],
  time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
}, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-physics] backend=${app.renderer.inspect().capabilities.backendKind}`);

// Spawn the physics scene.
app.world.spawn(
  { component: Transform, data: { pos: [0, -2, 0], scale: [10, 0.5, 10]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], restitution: 0.3 },
  },
  { component: CollidingEntities, data: { entities: [] } },
);

const sphereSpawn = app.world.spawn(
  { component: Transform, data: { pos: [0, 5, 0]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.01 } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.sphere, radius: 0.5, restitution: 0.7, friction: 0.5 },
  },
  { component: CollidingEntities, data: { entities: [] } },
);
if (!sphereSpawn.ok) {
  originalConsoleError(`[smoke] FAIL - sphere spawn failed: ${sphereSpawn.error.code} - ${sphereSpawn.error.hint}`);
  process.exit(1);
}
const sphereEntity = sphereSpawn.value;

app.world.spawn(
  { component: Transform, data: { pos: [8, 4, 10]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
app.world.spawn({
  component: DirectionalLight,
  data: { castShadow: true, direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));


const observations = [];
const observerInstall = app.world.addSystem(Update, {
  name: 'm25-physics-frame-observer',
  queries: [],
  after: [FixedUpdate],
  fn: (world) => {
    const time = world.getResource(Time);
    const fixed = world.getResource(FixedTime);
    const transform = world.get(sphereEntity, Transform);
    const physics = world.hasResource('PhysicsWorld') ? world.getResource('PhysicsWorld') : undefined;
    const collisions = world.get(sphereEntity, CollidingEntities);
    observations.push({
      timeDelta: time.delta,
      elapsed: time.elapsed,
      fixedDelta: fixed.delta,
      maxStepsPerUpdate: fixed.maxStepsPerUpdate,
      fixedTick: fixed.tick,
      overstep: fixed.overstep,
      droppedSeconds: fixed.droppedSeconds,
      droppedUpdates: fixed.droppedUpdates,
      pos: transform.ok ? Array.from(transform.value.pos) : null,
      bodyCount: physics?.getBodyCount() ?? null,
      hasBody: physics?.hasBody(sphereEntity) ?? false,
      collidingEntities: collisions.ok ? Array.from(collisions.value.entities) : [],
    });
  },
});
if (!observerInstall.ok) {
  originalConsoleError(`[smoke] FAIL - M25 observer install failed: ${observerInstall.error.code}`);
  process.exit(1);
}

// Override performance.now for deterministic frame timing.
let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

// Read initial sphere pos y before simulation.
const initialTransform = app.world.get(sphereEntity, Transform);
if (!initialTransform.ok) {
  originalConsoleError(`[smoke] FAIL - initial Transform read failed: ${initialTransform.error.code}`);
  process.exit(1);
}
const initialPosY = initialTransform.value.pos[1];
console.log(`[smoke] sphere initial pos y=${initialPosY}`);

// The first frame establishes the host-clock origin and the second is the
// healthy same-body baseline. The M25 phases then drive one oversized host
// gap and one healthy frame through the same App/World without reconstruction.
let totalFrames = 0;
const phaseFailures = [];
const frameDeltaMs = 1_000 / 60;
const frameCreditTimeoutMs = Number.parseInt(
  process.env.FORGEAX_SMOKE_FRAME_CREDIT_TIMEOUT_MS ?? '5000',
  10,
);
const FRAME_CREDIT_TIMEOUT_MS = Number.isFinite(frameCreditTimeoutMs) && frameCreditTimeoutMs > 0 ? frameCreditTimeoutMs : 5_000;
async function waitForFrameCredit() {
  const deadline = Date.now() + FRAME_CREDIT_TIMEOUT_MS;
  while (app.execution.report().frame.inFlight >= 2) {
    if (Date.now() >= deadline) {
      phaseFailures.push(
        `frame credit did not settle within ${FRAME_CREDIT_TIMEOUT_MS}ms (inFlight=${app.execution.report().frame.inFlight})`,
      );
      return false;
    }
    // Dawn receipts settle asynchronously. Yield briefly so the completion
    // callback can release the App's two-frame credit before the next tick.
    await delay(1);
  }
  return true;
}
async function driveFrame(deltaMs) {
  const due = rafQueue.shift();
  if (!due) {
    phaseFailures.push(`frame queue empty before frame ${totalFrames + 1}`);
    return undefined;
  }
  if (!(await waitForFrameCredit())) return undefined;
  fakeNow += deltaMs;
  due.cb(fakeNow);
  totalFrames++;
  await delay(1);
  return observations[observations.length - 1];
}

await driveFrame(frameDeltaMs);
const baseline = await driveFrame(frameDeltaMs);
const physicsWorld = app.world.hasResource('PhysicsWorld') ? app.world.getResource('PhysicsWorld') : undefined;
if (physicsWorld !== undefined) physicsWorld.teleport(sphereEntity, [0, 5, 0]);
const oversizedDelta = await driveFrame(5_000);
const healthyRecovery = await driveFrame(frameDeltaMs);

// Observe two fixed physics steps per render after the recovery probe so the
// 60-frame window reaches ground contact without changing the scene or timestep.
while (totalFrames < SMOKE_MIN_FRAMES) {
  if ((await driveFrame(frameDeltaMs * 2)) === undefined) break;
}

// Restore real performance.now and wait for any pending WASM to settle.
globalThis.performance.now = realPerformanceNow;
await delay(2000);

const hasPhysicsWorld = app.world.hasResource('PhysicsWorld') === true;
console.log(`[smoke] frames observed=${totalFrames}, PhysicsWorld=${hasPhysicsWorld}`);

const finalTransform = app.world.get(sphereEntity, Transform);
if (!finalTransform.ok) {
  originalConsoleError(`[smoke] FAIL - final Transform read failed: ${finalTransform.error.code}`);
  process.exit(1);
}
const finalPosY = finalTransform.value.pos[1];
console.log(`[smoke] sphere final pos y=${finalPosY}`);

const stopResult = app.stop();
const repeatedStop = app.stop();

const failures = [];
failures.push(...phaseFailures.map((failure) => `(phase) ${failure}`));
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}
if (consoleErrors.length > 0) {
  const physicsErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
  if (physicsErrors.length > 0) {
    failures.push(`(b) console.error fired ${physicsErrors.length} times: ${JSON.stringify(physicsErrors.slice(0, 3))}`);
  }
}
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// AC-04: PhysicsWorld must be present (physics3d awaits WASM import before
// createApp resolves). Dynamic RigidBody must have pos y strictly lower than
// initial after simulation frames advance.
if (!hasPhysicsWorld) {
  failures.push(`(d) PhysicsWorld not present -- WASM did not load or physics3d build failed`);
} else if (finalPosY >= initialPosY) {
  failures.push(`(e) sphere pos y did not decrease: ${initialPosY} -> ${finalPosY} (delta=${(finalPosY - initialPosY).toFixed(4)})`);
}

const closeTo = (actual, expected, tolerance = 1e-9) =>
  typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
const validObservation = (observation) => observation !== undefined && observation.pos !== null;
const baselinePass =
  validObservation(baseline) &&
  baseline.timeDelta > 0 &&
  baseline.fixedTick > 0 &&
  baseline.fixedDelta === 1 / 60 &&
  baseline.bodyCount === 2 &&
  baseline.hasBody &&
  baseline.pos[1] < initialPosY;
const oversizedSteps =
  validObservation(baseline) && validObservation(oversizedDelta)
    ? oversizedDelta.fixedTick - baseline.fixedTick
    : -1;
const oversizedPass =
  validObservation(oversizedDelta) &&
  closeTo(oversizedDelta.timeDelta, 0.1, 1e-12) &&
  oversizedSteps === oversizedDelta.maxStepsPerUpdate &&
  oversizedSteps === 4 &&
  oversizedDelta.fixedDelta === 1 / 60 &&
  oversizedDelta.droppedUpdates > (baseline?.droppedUpdates ?? Number.POSITIVE_INFINITY) &&
  oversizedDelta.droppedSeconds > (baseline?.droppedSeconds ?? Number.POSITIVE_INFINITY) &&
  oversizedDelta.bodyCount === baseline?.bodyCount &&
  oversizedDelta.hasBody &&
  oversizedDelta.pos[1] > 4.5 &&
  oversizedDelta.pos[1] < 5;
const healthyRecoveryPass =
  validObservation(oversizedDelta) &&
  validObservation(healthyRecovery) &&
  closeTo(healthyRecovery.timeDelta, 1 / 60, 1e-12) &&
  healthyRecovery.fixedTick === oversizedDelta.fixedTick + 1 &&
  healthyRecovery.droppedUpdates === oversizedDelta.droppedUpdates &&
  healthyRecovery.droppedSeconds === oversizedDelta.droppedSeconds &&
  healthyRecovery.bodyCount === oversizedDelta.bodyCount &&
  healthyRecovery.hasBody &&
  healthyRecovery.pos[1] < oversizedDelta.pos[1] &&
  healthyRecovery.pos[1] > oversizedDelta.pos[1] - 0.1;
const maxCollidingEntities = observations.reduce(
  (max, observation) => Math.max(max, observation.collidingEntities.length),
  0,
);
const finalObservation = observations[observations.length - 1];
const collisionWritebackPass =
  maxCollidingEntities > 0 &&
  validObservation(finalObservation) &&
  finalObservation.droppedUpdates === healthyRecovery?.droppedUpdates &&
  finalObservation.droppedSeconds === healthyRecovery?.droppedSeconds &&
  finalObservation.bodyCount === baseline?.bodyCount &&
  finalObservation.hasBody &&
  finalObservation.pos.every(Number.isFinite);
const cleanupPass =
  stopResult.ok && !repeatedStop.ok && repeatedStop.error.code === 'app-not-started';

if (!baselinePass) failures.push(`[m25] baseline failed: ${JSON.stringify(baseline)}`);
if (!oversizedPass) {
  failures.push(
    `[m25] oversized delta failed: ${JSON.stringify({ observation: oversizedDelta, fixedSteps: oversizedSteps })}`,
  );
}
if (!healthyRecoveryPass) {
  failures.push(`[m25] healthy recovery failed: ${JSON.stringify(healthyRecovery)}`);
}
if (!collisionWritebackPass) {
  failures.push(
    `[m25] collision/writeback failed: maxCollidingEntities=${maxCollidingEntities}, final=${JSON.stringify(finalObservation)}`,
  );
}
if (!cleanupPass) {
  failures.push(
    `[m25] cleanup failed: firstStop=${JSON.stringify(stopResult)}, repeatedStop=${JSON.stringify(repeatedStop)}`,
  );
}

console.log(`[m25] baseline: ${baselinePass ? 'PASS' : 'FAIL'} - fixedTick=${baseline?.fixedTick ?? 'n/a'}, bodyCount=${baseline?.bodyCount ?? 'n/a'}`);
console.log(`[m25] oversized delta: ${oversizedPass ? 'PASS' : 'FAIL'} - Time.delta=${oversizedDelta?.timeDelta ?? 'n/a'}, fixedSteps=${oversizedSteps}, droppedUpdates=${oversizedDelta?.droppedUpdates ?? 'n/a'}, droppedSeconds=${oversizedDelta?.droppedSeconds ?? 'n/a'}, posY=${oversizedDelta?.pos?.[1] ?? 'n/a'}`);
console.log(`[m25] healthy recovery: ${healthyRecoveryPass ? 'PASS' : 'FAIL'} - fixedTick=${healthyRecovery?.fixedTick ?? 'n/a'}, droppedUpdates=${healthyRecovery?.droppedUpdates ?? 'n/a'}, posY=${healthyRecovery?.pos?.[1] ?? 'n/a'}`);
console.log(`[m25] collision/writeback: ${collisionWritebackPass ? 'PASS' : 'FAIL'} - maxCollidingEntities=${maxCollidingEntities}`);
console.log(`[m25] cleanup: ${cleanupPass ? 'PASS' : 'FAIL'} - repeatedStop=${repeatedStop.ok ? 'ok' : repeatedStop.error.code}`);

const artifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
if (artifactDir !== undefined) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    resolve(artifactDir, 'm25-physics-evidence.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: 'hello-physics-large-delta-recovery',
        policy: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
        frames: { total: totalFrames, requested: SMOKE_MIN_FRAMES },
        phases: {
          baseline: baseline ?? null,
          oversizedDelta: oversizedDelta ?? null,
          healthyRecovery: healthyRecovery ?? null,
          final: finalObservation ?? null,
        },
        collision: { maxCollidingEntities },
        cleanup: {
          firstStopOk: stopResult.ok,
          repeatedStopCode: repeatedStop.ok ? null : repeatedStop.error.code,
        },
        oracle: { passed: failures.length === 0, failures },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, PhysicsWorld=${hasPhysicsWorld}, pos y: ${initialPosY} -> ${finalPosY}, app.onError=0`);
console.log('[m25] PASS - physics large-delta recovery');
emitSmokeReceipt('hello-physics/smoke', totalFrames);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
