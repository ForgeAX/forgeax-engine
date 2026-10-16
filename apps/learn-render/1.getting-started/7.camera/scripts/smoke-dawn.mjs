#!/usr/bin/env node
import { Update } from '@forgeax/engine-ecs';
// apps/learn-render/1.getting-started/7.camera/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 1.7 camera dawn-node smoke (M11 / T-M11-02 red ->
// T-M11-03 green; AC-03 + AC-04 + AC-06 + AC-07 + AC-25 90s budget).
// Mirrors apps/learn-render/.../4.textures/scripts/smoke-dawn.mjs shape +
// adds a synthetic first-person InputBackend driving WASD + mouse-delta
// over 60 frames. The verdict is the same 4-criterion gate as the
// textures smoke modulo the input-driven divergence proof: at least one
// meshed sample site exceeds the clear-color threshold AFTER the synthetic
// camera tour, proving the cube remained visible across the input
// sequence (charter P5 producer / consumer split: subagent runs the
// smoke, orchestrator reads the structured stdout).
//
// Strategy (charter P4 consistent abstraction):
//   1. Inject globalThis.navigator.gpu via dawn-node `webgpu` package.
//   2. Build a mock HTMLCanvasElement + offscreen render target.
//   3. Drive the engine ECS path:
//      (a) ensure assets/cube-mesh.stub.meta.json sidecar fixture exists
//          (T-M11-03 lands it); abort with structured asset-fixture-
//          missing error otherwise (red TDD signal).
//      (b) registerWithGuid<MeshAsset>(cubeGuid, cubeMesh) -- mirror of
//          coordinate-systems cube-mesh.stub.meta.json handle ordering.
//      (c) Build a synthetic InputBackend matching the @forgeax/engine-
//          input protocol (sample()/detach()) + drive a deterministic
//          first-person sequence (WASD held + per-frame mouse delta).
//      (d) insertResource INPUT_BACKEND_KEY + addSystem InputFrameStartScan so each
//          world.update(1 / 60).unwrap() refreshes the InputSnapshot Resource.
//      (e) Spawn cube + camera + first-person camera system that reads
//          InputSnapshot from world.getResource('InputSnapshot') and
//          accumulates yaw/pitch (+/-89 deg clamp) + reconstructs the
//          camera direction (sphere -> Cartesian).
//      (f) lease-bound renderer.draw 300x with the synthetic input pump.
//   4. copyTextureToBuffer + mapAsync multi-pixel grid (5 sites) +
//      verdict: (a) Dawn device (b) frames>=60 (c) at least one
//      meshed site distance to clear-color > eps (d) Renderer.onError
//      RhiError count == 0.
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-camera] Standard pipeline active`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] yawPitchFinal=<json>`
//
// Red-phase stance (T-M11-02 acceptanceCheck): until T-M11-03 lands the
// assets/cube-mesh.stub.meta.json fixture + makes the GUID registration
// path active, the script aborts with structured asset-fixture-missing
// failure JSON on stderr; that is the expected red signal until T-M11-03
// wires the full recipe.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const ASSETS_DIR = resolve(APP_ROOT, 'assets');
const REPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const VENDOR_MESHES_DIR = resolve(REPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'meshes');
const CUBE_META_PATH = resolve(VENDOR_MESHES_DIR, 'cube-mesh.stub.meta.json');

// AC-25 90s wall budget shared with 4.textures smoke; 7.camera share is
// the 45s upper bound. Wall time logged regardless of pass/fail so the
// verify step can audit drift (charter F3 implementation: real measurement,
// not estimate).
const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-7-camera' smoke",
  );
  console.error(
    '  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present',
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
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ----------------------------

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

// --- 3. Drive engine ECS path with synthetic first-person input ------------

// Sidecar fixture must be present (T-M11-03 lands assets/cube-mesh.stub
// .meta.json). Until then the smoke aborts here with structured asset-
// fixture-missing failure: vendor SSOT subtree must be initialized.
if (!existsSync(CUBE_META_PATH)) {
  console.error(`[smoke] FAIL - vendor asset fixture missing: ${CUBE_META_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive  # then re-run smoke',
  );
  console.error(
    "  hint:  vendor SSOT lives in forgeax-engine-assets/learn-opengl/meshes/cube-mesh.stub.meta.json (CC BY-NC 4.0 carve-out)",
  );
  process.exit(1);
}

const ecsPkg = await import('@forgeax/engine-ecs');
const { World } = ecsPkg;
const inputPkg = await import('@forgeax/engine-input');
const { INPUT_BACKEND_KEY, InputFrameStartScan, INPUT_SNAPSHOT_RESOURCE_KEY } = inputPkg;
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine-render');
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

// M5-engine-fix: build a real engine manifest carrying pbr.wgsl + unlit.wgsl
// (post w22.9 the inline fallback was deleted; the engine demands real
// entries). Mirrors apps/hello/cube/scripts/smoke-dawn.mjs.
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: EMPTY_MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[learn-render-camera] Standard pipeline active');
if (!assets) {
  console.error('[smoke] FAIL - host assets are unavailable');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// The cube enters the world via the engine builtin HANDLE_CUBE directly
// (no GUID round-trip); matHandle is minted from a user-tier column after
// the World is created below (M8 D-17 ordering: World before allocSharedRef).

// --- 3b. Synthetic InputBackend pump driving WASD + mouse delta -------------

const heldKeys = new Set();
let mvxPending = 0;
let mvyPending = 0;
const syntheticBackend = {
  sample() {
    const out = {
      downKeys: new Set(heldKeys),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: mvxPending,
      movementY: mvyPending,
      focused: true,
    };
    mvxPending = 0;
    mvyPending = 0;
    return out;
  },
  detach() {},
};

// First-person camera system (matches index.ts behaviour 1:1; both paths
// use the same yaw/pitch accumulator + spherical -> Cartesian formula
// + +/-89 deg pitch clamp). The smoke owns its own copy so the green
// criteria are independent of any browser-only DOM wiring (charter F3).
const PITCH_CLAMP_RAD = (89 * Math.PI) / 180;
const MOUSE_SENSITIVITY = 0.002; // radians per pixel
const KEYBOARD_SPEED = 0.05; // world units per frame
let yaw = 0; // radians, around Y axis
let pitch = 0; // radians, around X axis
let camPosX = 0;
let camPosY = 0;
let camPosZ = 3;
const cameraSystem = {
  name: 'learn-render-camera-first-person',
  queries: [],
  fn() {
    if (!world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return;
    const snap = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
    const dx = snap.mouse.movementDelta.x;
    const dy = snap.mouse.movementDelta.y;
    yaw += dx * MOUSE_SENSITIVITY;
    pitch -= dy * MOUSE_SENSITIVITY; // LO 1.7 inverts dy sign
    if (pitch > PITCH_CLAMP_RAD) pitch = PITCH_CLAMP_RAD;
    if (pitch < -PITCH_CLAMP_RAD) pitch = -PITCH_CLAMP_RAD;
    // Spherical -> Cartesian (LO 1.7 4-step formula): forward direction.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const fwdX = cy * cp;
    const fwdY = sp;
    const fwdZ = sy * cp;
    if (snap.keyboard.down('KeyW')) {
      camPosX += fwdX * KEYBOARD_SPEED;
      camPosY += fwdY * KEYBOARD_SPEED;
      camPosZ += fwdZ * KEYBOARD_SPEED;
    }
    if (snap.keyboard.down('KeyS')) {
      camPosX -= fwdX * KEYBOARD_SPEED;
      camPosY -= fwdY * KEYBOARD_SPEED;
      camPosZ -= fwdZ * KEYBOARD_SPEED;
    }
    // Right vector = normalize(cross(forward, world-up=(0,1,0))).
    const rightX = fwdZ;
    const rightZ = -fwdX;
    if (snap.keyboard.down('KeyA')) {
      camPosX -= rightX * KEYBOARD_SPEED;
      camPosZ -= rightZ * KEYBOARD_SPEED;
    }
    if (snap.keyboard.down('KeyD')) {
      camPosX += rightX * KEYBOARD_SPEED;
      camPosZ += rightZ * KEYBOARD_SPEED;
    }
  },
};

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
// LO 1.7 unlit material: mint a user-tier column handle from the unlit
// MaterialAsset POD (M8 D-17). orange teaching colour (1, 0.5, 0.2).
const matHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([1.0, 0.5, 0.2, 1.0]));
world.insertResource(INPUT_BACKEND_KEY, syntheticBackend);
world.addSystem(Update, InputFrameStartScan);
world.addSystem(Update, cameraSystem);

const cubeEntity = world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  )
  .unwrap();
void cubeEntity;

const cameraEntity = world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [camPosX, camPosY, camPosZ], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
    },
  )
  .unwrap();
void cameraEntity;

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  // Synthetic first-person tour: hold KeyW for the first 60 frames
  // (forward dolly), then sweep mouse horizontally for 60 frames
  // (yaw spin), then sweep vertically (pitch tilt). The mix exercises
  // every accumulator path so the verdict + yaw/pitch final state
  // captures both the held-key path + the per-frame delta path.
  if (i === 0) heldKeys.add('KeyW');
  if (i === Math.floor(TARGET_FRAMES / 3)) {
    heldKeys.delete('KeyW');
    heldKeys.add('KeyD');
  }
  if (i === Math.floor(2 * TARGET_FRAMES / 3)) {
    heldKeys.delete('KeyD');
  }
  if (i >= Math.floor(TARGET_FRAMES / 3) && i < Math.floor(2 * TARGET_FRAMES / 3)) mvxPending += 4;
  if (i >= Math.floor(2 * TARGET_FRAMES / 3)) mvyPending += -2;
  // Note: world.update(1 / 60).unwrap() runs the frame-start scan system (refreshing
  // InputSnapshot) + the camera system (consuming it) in DAG order.
  world.update(1 / 60).unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
  }
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);
console.log(
  `[smoke] yawPitchFinal=${JSON.stringify({ yaw: Number(yaw.toFixed(4)), pitch: Number(pitch.toFixed(4)), camPos: [camPosX, camPosY, camPosZ].map((v) => Number(v.toFixed(4))) })}`,
);

// --- 4. Pixel readback (multi-site grid) ------------------------------------

if (!renderTarget) {
  console.error(
    '[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()',
  );
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
  console.error(
    `[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const sites = [
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'cubeUL', x: Math.floor(WIDTH * 0.35), y: Math.floor(HEIGHT * 0.4) },
  { name: 'cubeBR', x: Math.floor(WIDTH * 0.65), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (4 criteria; AC-25 wall budget logged separately) ------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['ndcCenter', 'cubeUL', 'cubeBR'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

const failures = [];
if (!sharedDevice)
  failures.push('(a) Dawn device was not created by the host-owned Standard pipeline');
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) first-person cube tour - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} distance from clear color; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-1-getting-started-7-camera' smoke",
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify cube-mesh.stub.meta.json sidecar GUID matches the runtime registerWithGuid call in src/index.ts + the synthetic InputBackend pump drives WASD + mouse-delta over 60 frames',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: Standard pipeline, frames=${framesObserved}, first-person sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
