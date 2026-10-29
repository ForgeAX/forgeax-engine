#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-character headless dawn-node smoke.
//
// Strategy: createApp with physics3d, spawn a kinematic capsule
// character + static ground, start the app, poll for PhysicsWorld (async WASM),
// then DRIVE the character with PhysicsWorld.moveAndSlide for N frames and assert:
//   1. createApp + app ready/start/stop succeed, app.onError == 0.
//   2. >= 60 frames observed.
//   3. PhysicsWorld resource is present after WASM init.
//   4. moveAndSlide advanced the character horizontally (it did NOT fall through
//      the ground): final pos x > initial pos x by a clear margin, and pos y stays
//      near the resting height (no tunneling).
//   5. CharacterController.grounded reads true while walking on flat ground.
//
// This is the createApp -> moveAndSlide character integration exemplar
// (feat-20260617 G-2 / AC-15). Structural-only: no pixel readback (the demo's
// visual gate is the Playwright browser probe + human Read(*.png)).
//
// Note: physics3d.apply awaits the Rapier WASM import -- Cordis activation in
// createApp resolves after the WASM module is loaded, so PhysicsWorld is
// populated before the first app frame. If it fails to load within the
// timeout, the smoke FAILs (non-vacuous PASS).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WASM_LOAD_TIMEOUT_MS = Number.parseInt(
  process.env.FORGEAX_SMOKE_PHYSICS_WASM_TIMEOUT_MS ?? '10000',
  10,
);

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
  originalConsoleError(
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
  originalConsoleError(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
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
const realPerformanceNow =
  globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
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

const { Camera, DirectionalLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const physicsPkg = await import('@forgeax/engine-physics');
const { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } =
  physicsPkg;

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(
  mockCanvas,
  { platform: createSmokePlatform(mockCanvas),  plugins: [physics3d] },
  { shaderManifestUrl: MANIFEST_URL },
).catch((err) => {
  originalConsoleError(
    `[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-character] backend=${app.renderer.inspect().capabilities.backendKind}`);

// Character resting height: ground top at y=-0.35, capsule half-total 0.8 -> 0.45.
const CHAR_REST_Y = 0.45;

// Static ground.
app.world.spawn(
  { component: Transform, data: { pos: [0, -0.85, 0], scale: [20, 1, 20]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 10] },
  },
);

// Kinematic capsule character.
const charSpawn = app.world.spawn(
  { component: Transform, data: { pos: [0, CHAR_REST_Y, 0]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
  {
    component: Collider,
    data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
  },
  { component: CharacterController, data: {} },
);
if (!charSpawn.ok) {
  originalConsoleError(`[smoke] FAIL - character spawn failed: ${charSpawn.error.code}`);
  process.exit(1);
}
const character = charSpawn.value;

app.world.spawn(
  { component: Transform, data: { pos: [0, 6, 12]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
app.world.spawn({
  component: DirectionalLight,
  data: { castShadow: true, direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));


let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

const initialTransform = app.world.get(character, Transform);
const initialPosX = initialTransform.ok ? (initialTransform.value.pos[0] ?? 0) : 0;

function grounded() {
  const r = app.world.get(character, CharacterController);
  return r.ok && r.value.grounded === true;
}

function getPw() {
  try {
    return app.world.getResource('PhysicsWorld');
  } catch {
    return undefined;
  }
}

// Phase 1: pump frames in small batches, yielding to the event loop between
// batches so the fire-and-forget Rapier WASM dynamic import can resolve and
// insert the PhysicsWorld resource. The synchronous fakeNow clock means no
// real time passes inside a batch, so the await is what lets the import settle.
let totalFrames = 0;
const deadline = Date.now() + WASM_LOAD_TIMEOUT_MS;
while (getPw() === undefined && Date.now() < deadline) {
  for (let i = 0; i < 30 && totalFrames < SMOKE_MIN_FRAMES; i++) {
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
    totalFrames++;
  }
  await delay(50); // let the WASM import microtasks flush
}

// Phase 2: drive the character with moveAndSlide for the remaining frames.
// One downward settle pulse establishes ground contact, then walk +x with pure
// horizontal deltas — snap-to-ground keeps the capsule glued to the flat surface
// at its resting height (a per-frame down-bias would instead accumulate and sink
// it through the snap tolerance; gravity belongs to the demo's grounded-gated
// velocity model, not this minimal structural drive).
let drivenFrames = 0;
let groundedFrames = 0;
let settled = false;
const pwReady = getPw();
while (totalFrames < SMOKE_MIN_FRAMES) {
  const due = rafQueue.shift();
  if (!due) break;
  fakeNow += 16.67;
  due.cb(fakeNow); // runs the app frame -> physicsSyncBackend creates the body
  totalFrames++;
  if (!pwReady) continue;
  // The body is created by physicsSyncBackend during the frame above; guard the
  // first moveAndSlide so a not-yet-registered body does not throw.
  try {
    if (!settled) {
      // One downward settle pulse establishes ground contact.
      pwReady.moveAndSlide(character, Float32Array.of(0, -0.15, 0));
      settled = true;
    }
    // Walk +x with pure horizontal deltas — snap-to-ground keeps the capsule
    // glued to the flat surface at its resting height. (A per-frame down-bias
    // would accumulate and sink it; gravity belongs to the demo's grounded-gated
    // velocity model, not this minimal structural drive.)
    pwReady.moveAndSlide(character, Float32Array.of(0.05, 0, 0));
    drivenFrames++;
    if (grounded()) groundedFrames++;
  } catch {
    // body not registered yet this frame — retry next frame.
  }
}

globalThis.performance.now = realPerformanceNow;
await delay(500);

const hasPhysicsWorld = app.world.hasResource('PhysicsWorld') === true;
const finalTransform = app.world.get(character, Transform);
const finalPosX = finalTransform.ok ? (finalTransform.value.pos[0] ?? 0) : 0;
const finalPosY = finalTransform.ok ? (finalTransform.value.pos[1] ?? 0) : 0;
console.log(
  `[smoke] frames=${totalFrames} driven=${drivenFrames} grounded=${groundedFrames} pos x ${initialPosX} -> ${finalPosX} pos y=${finalPosY}`,
);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const failures = [];
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}
const physicsErrors = consoleErrors.filter((e) => !e.includes('[smoke]') && !e.includes('[hello-character]'));
if (physicsErrors.length > 0) {
  failures.push(`(b) console.error fired ${physicsErrors.length} times: ${JSON.stringify(physicsErrors.slice(0, 3))}`);
}
if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}

// Non-vacuous PASS: PhysicsWorld must be present (physics3d awaits WASM
// before createApp resolves). Assert moveAndSlide behaviour and grounded.
if (!hasPhysicsWorld) {
  failures.push(`(d) PhysicsWorld not present -- WASM did not load or physics3d build failed`);
} else {
  // AC-15: moveAndSlide advanced the character and it did not tunnel.
  if (finalPosX <= initialPosX + 0.3) {
    failures.push(`(e) character did not advance via moveAndSlide: pos x ${initialPosX} -> ${finalPosX}`);
  }
  if (finalPosY < CHAR_REST_Y - 0.5) {
    failures.push(`(f) character tunneled through the ground: pos y=${finalPosY} (rest ${CHAR_REST_Y})`);
  }
  if (drivenFrames > 0 && groundedFrames < drivenFrames * 0.5) {
    failures.push(`(g) character not grounded while walking flat: ${groundedFrames}/${drivenFrames}`);
  }
}

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - frames=${totalFrames}, PhysicsWorld=${hasPhysicsWorld}, pos x ${initialPosX} -> ${finalPosX}, grounded=${groundedFrames}/${drivenFrames}, app.onError=0`,
);
emitSmokeReceipt('hello-character/smoke', totalFrames);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
