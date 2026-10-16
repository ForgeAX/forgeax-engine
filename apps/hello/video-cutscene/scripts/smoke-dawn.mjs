#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// hello-video-cutscene headless dawn-node smoke
// (feat-20260617-host-engine-contract-and-video-cutscene / M4 / w15).
//
// Structural-only (AGENTS.md Smoke gate: dawn-node smoke is structural; no
// pixel readback -- the visual gate is the Playwright browser smoke). This
// smoke exercises the FULL host-engine cutscene lifecycle the contract
// documents (docs/how-to/2026-06-18-host-engine-contract.md section 4.2):
//
//   createApp -> start -> [run frames] -> pause -> [run frames] -> resume ->
//   [run frames] -> stop
//
// All assertions are exit-code-gated (process.exit(1) on failure, never
// prose-only). Gates:
//   1. createApp + start succeed; frames advance while running.
//   2. pause() freezes the world: the rotating cube's rAF stops being armed,
//      so the Update system does NOT fire while paused (frame count
//      stalls). resume() continues the loop (frame count advances again).
//   3. dt baseline reset: the first frame AFTER resume has a small dt (<= 16ms),
//      NOT the multi-second pause gap nor the clamp ceiling (1/30s). This is
//      the research Finding 8 contract: resume() resets lastTimestamp so the
//      pause duration never inflates dt.
//   4. stop() after resume succeeds; resume() after stop is unusable
//      (frame-loop guard returns err -- the host cannot restart a stopped app).

import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const RERUN_CMD = 'pnpm --filter @forgeax/hello-video-cutscene smoke';
const WIDTH = 200;
const HEIGHT = 150;
const requestedFrameCount = Number(process.env.SMOKE_MIN_FRAMES ?? '60');

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};
if (!Number.isInteger(requestedFrameCount) || requestedFrameCount < 60) {
  originalConsoleError(`[smoke] FAIL - SMOKE_MIN_FRAMES must be an integer >= 60 (received ${process.env.SMOKE_MIN_FRAMES ?? '60'})`);
  process.exit(1);
}

// --- dawn-node GPU shim ---
let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  originalConsoleError(`  rerun: ${RERUN_CMD}`);
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
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Manual rAF queue + fake clock so the lifecycle (pause / resume / stop) is
// driven deterministically. requestAnimationFrame pushes; each drained entry
// is one frame and the loop re-arms the next frame from inside.
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

// --- Engine boot (createApp path, mirrors src/main.ts) ---
const { createApp } = await import('@forgeax/engine-app/browser');
const runtime = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { quat } = await import('@forgeax/engine-math');
const { Time, Update } = await import('@forgeax/engine-ecs');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: MANIFEST_URL }).catch(
  (err) => {
    originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp err: ${JSON.stringify({ code: appResult.error.code })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-video-cutscene] backend=${app.renderer.inspect().capabilities.backendKind}`);

const world = app.world;
const cubeMatHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([0.9, 0.3, 0.25, 1]));
const cube = world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
  )
  .unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.2 },
});
world.spawn(
  { component: Transform, data: { pos: [0, 1, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT }) },
);

// Track frames + per-frame dt via Update system (same hook the demo rotates
// the cube with). The callback fires only when a frame ticks, so frameCount is
// the structural witness of "world running vs frozen".
let frameCount = 0;
let lastDt = 0;
const spin = quat.create();
let angle = 0;
world
  .addSystem(Update, {
    name: 'video-cutscene-smoke-spin',
    queries: [],
    fn: () => {
      const dt = world.getResource(Time).delta;
      frameCount += 1;
      lastDt = dt;
      angle += dt;
      quat.fromAxisAngle(spin, [0, 1, 0], angle);
      world.set(cube, Transform, {
        quat: [spin[0] ?? 0, spin[1] ?? 0, spin[2] ?? 0, spin[3] ?? 1],
      });
    },
  })
  .unwrap();

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code }));


// Deterministic clock.
let fakeNow = 0;
const FRAME_MS = 16.67;
globalThis.performance.now = () => fakeNow;

// Drain exactly one armed frame, advancing the fake clock by `stepMs` first.
const frameCreditTimeoutMs = Number.parseInt(
  process.env.FORGEAX_SMOKE_FRAME_CREDIT_TIMEOUT_MS ?? '5000',
  10,
);
const FRAME_CREDIT_TIMEOUT_MS = Number.isFinite(frameCreditTimeoutMs) && frameCreditTimeoutMs > 0 ? frameCreditTimeoutMs : 5_000;
async function waitForFrameCredit() {
  const deadline = Date.now() + FRAME_CREDIT_TIMEOUT_MS;
  while (app.execution.report().frame.inFlight >= 2) {
    if (Date.now() >= deadline) {
      originalConsoleError(
        `[smoke] frame credit did not settle within ${FRAME_CREDIT_TIMEOUT_MS}ms (inFlight=${app.execution.report().frame.inFlight})`,
      );
      return false;
    }
    await delay(1);
  }
  return true;
}
async function runFrame(stepMs = FRAME_MS) {
  const due = rafQueue.shift();
  if (!due) return false;
  if (!(await waitForFrameCredit())) return false;
  fakeNow += stepMs;
  due.cb(fakeNow);
  await delay(1);
  return true;
}

// --- GATE 1: start + running advances frames ---
if (!app.start().ok) {
  originalConsoleError('[smoke] FAIL - app.start() err');
  process.exit(1);
}
for (let i = 0; i < 30; i++) {
  const completed = await runFrame();
  if (!completed) {
    originalConsoleError(`[smoke] FAIL - running frame ${i + 1} was not scheduled`);
    process.exit(1);
  }
}
if (frameCount < 30) {
  originalConsoleError(`[smoke] FAIL - running phase advanced only ${frameCount} frames (expected 30)`);
  process.exit(1);
}
console.log(`[smoke] GATE 1 PASS: running advanced ${frameCount} frames`);

// --- GATE 2: pause freezes the world ---
const framesBeforePause = frameCount;
if (!app.pause().ok) {
  originalConsoleError('[smoke] FAIL - app.pause() err while running');
  process.exit(1);
}
// While paused the loop arms no frame; draining the queue must not tick.
for (let i = 0; i < 10; i++) await runFrame();
if (frameCount !== framesBeforePause) {
  originalConsoleError(
    `[smoke] FAIL - world ticked while paused (before=${framesBeforePause}, after=${frameCount})`,
  );
  process.exit(1);
}
// Idempotent pause: a second pause() is a safe no-op the demo ignores.
app.pause();
console.log(`[smoke] GATE 2 PASS: paused world frozen at ${frameCount} frames`);

// --- GATE 3: resume resets the dt baseline ---
// Simulate a long pause: jump the clock far ahead before resuming. Without the
// baseline reset, the next frame's dt would be the multi-second gap (clamped to
// the 1/30s ceiling). resume() resets lastTimestamp, so the first resumed frame
// sees only the real ~16ms inter-frame gap.
fakeNow += 5000; // 5s "pause duration"
if (!app.resume().ok) {
  originalConsoleError('[smoke] FAIL - app.resume() err');
  process.exit(1);
}
const resumedFrameCompleted = await runFrame(); // first resumed frame
if (!resumedFrameCompleted) {
  originalConsoleError('[smoke] FAIL - first resumed frame was not scheduled');
  process.exit(1);
}
const firstResumedDt = lastDt;
if (frameCount !== framesBeforePause + 1) {
  originalConsoleError(`[smoke] FAIL - resume did not continue the loop (frameCount=${frameCount})`);
  process.exit(1);
}
// dt is in seconds. The real inter-frame gap is one FRAME_MS step (16.67ms).
// Without the baseline reset the 5s pause would surface, clamped to the
// frame-loop ceiling (1/30s = 33.33ms). Asserting dt sits at the real frame
// gap -- strictly below the ceiling -- proves the reset happened.
const DT_CEILING_MS = (1 / 30) * 1000; // frame-loop MAX_DT_DEFAULT
const RESUMED_DT_MAX_MS = FRAME_MS + 0.5; // real frame gap + margin
if (firstResumedDt * 1000 > RESUMED_DT_MAX_MS) {
  originalConsoleError(
    `[smoke] FAIL - first resumed dt=${(firstResumedDt * 1000).toFixed(2)}ms > ${RESUMED_DT_MAX_MS.toFixed(2)}ms ` +
      `(dt baseline was NOT reset; the 5s pause leaked into dt -- it would clamp to the ${DT_CEILING_MS.toFixed(2)}ms ceiling).`,
  );
  process.exit(1);
}
console.log(
  `[smoke] GATE 3 PASS: first resumed dt=${(firstResumedDt * 1000).toFixed(2)}ms ~ one frame gap (<< 5000ms pause, < ${DT_CEILING_MS.toFixed(2)}ms ceiling)`,
);

// Run a few more frames to confirm steady-state continuation.
for (let i = 0; i < 10; i++) {
  const completed = await runFrame();
  if (!completed) {
    originalConsoleError(`[smoke] FAIL - steady-state frame ${i + 1} was not scheduled`);
    process.exit(1);
  }
}

const FLEET_FRAME_COUNT = requestedFrameCount;
while (frameCount < FLEET_FRAME_COUNT) {
  const completed = await runFrame();
  if (!completed) {
    originalConsoleError(`[smoke] FAIL - fleet frame ${frameCount + 1} was not scheduled`);
    process.exit(1);
  }
}
if (frameCount < FLEET_FRAME_COUNT) {
  originalConsoleError(`[smoke] FAIL - completed only ${frameCount} frames (expected ${FLEET_FRAME_COUNT})`);
  process.exit(1);
}
console.log(`[smoke] frames observed=${frameCount}`);

// --- GATE 4: stop, then resume is unusable ---
const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() err: ${stopResult.error.code}`);
  process.exit(1);
}
const resumeAfterStop = app.resume();
if (resumeAfterStop.ok) {
  originalConsoleError('[smoke] FAIL - app.resume() succeeded after stop (frame-loop guard missing)');
  process.exit(1);
}
console.log(`[smoke] GATE 4 PASS: resume after stop rejected (${resumeAfterStop.error.code})`);

globalThis.performance.now = realPerformanceNow;
await delay(500);

if (onErrorEvents.length > 0) {
  originalConsoleError(`[smoke] FAIL - app.onError fired ${onErrorEvents.length} time(s): ${JSON.stringify(onErrorEvents)}`);
  process.exit(1);
}

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;

console.log(
  `[smoke] PASS - lifecycle GREEN: start/pause/resume/stop, world freezes on pause, dt baseline resets on resume, resume-after-stop guarded.`,
);
process.exit(0);
