#!/usr/bin/env node
// learn-render-4.10-msaa headless smoke
// (feat-20260604-learn-render-4-10-anti-aliasing-msaa-engine-wiring / M3 / w14).
//
// Strategy (dual-pass none-vs-msaa pixel diff):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat).
//   3. Spawn a static 4-geometry scene (triangle + cube + quad + sphere) +
//      DirectionalLight + Camera -- same layout as demo src/main.ts.
//      All geometries are stationary, no rotation animation.
//   4. Two Worlds share the same renderer/device/renderTarget:
//        - World-A: Camera.antialias = ANTIALIAS_NONE (baseline)
//        - World-B: Camera.antialias = ANTIALIAS_MSAA (MSAA active)
//      Each World renders, then pixels are read back via copyTextureToBuffer.
//      The renderTarget is reused across passes (test paradigm from
//      fxaa smoke-dawn.mjs).
//   5. Diff: per-pixel byte comparison (4 bytes = 1 pixel). Any channel
//      difference counts as 1 diff pixel. Assert diffCount > 0.1% of total
//      pixels (800x600x0.001 = 480).
//   6. Both passes must be non-black individually (nonBlackCount > 0).
//   7. 0 RhiError from the renderer (AC-04/AC-05).
//   8. No reference PNG reads/writes. No PNG ever lands in the engine repo
//      worktree. No writeFileSync / existsSync that touches disk.
//
// FALSIFY=msaa-noop (env, local-only, NOT in CI):
//   When set, pass2 also uses ANTIALIAS_NONE (same as pass1) so the two
//   renders are identical and diffCount <= threshold. This proves the smoke
//   is genuinely sensitive to MSAA being active (counterexample to a
//   miswire where MSAA is a silent no-op). Expect FAIL (charter P3).
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[learn-render-msaa] backend=webgpu`
//   - `[smoke] dualPassDiff={"diffCount":<N>,"threshold":<N>,"totalPixels":<N>,"pct":<N>}`
//   - `[smoke] PASS`
//
// Charter P3 explicit failure: on fail, output structured diagnostic with actual
// diffCount vs threshold so AI users can self-diagnose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WIDTH = 800;
const HEIGHT = 600;
const CLEAR_RGBA = [0, 0, 0, 1];
const TOTAL_PIXELS = WIDTH * HEIGHT;
// AC-08: >0.1% of total pixels. floor(800*600*0.001) = 480.
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.001);

const FALSIFY = process.env.FALSIFY ?? '';
const requestedSmokeFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_MIN_FRAMES =
  Number.isInteger(requestedSmokeFrames) && requestedSmokeFrames > 0 ? requestedSmokeFrames : 60;

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
  console.error('  rerun: pnpm -F @forgeax/app-learn-render-4-advanced-opengl-10-anti-aliasing-msaa smoke');
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
const { ANTIALIAS_MSAA, ANTIALIAS_NONE, Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
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
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[learn-render-msaa] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}


// Standard PBR material POD (same as demo main.ts). feat-20260614 M8
// (D-15/D-17): the material is minted per-World via allocSharedRef inside
// spawnScene -- a shared ref handle is a slot in that World's sharedRefs, so
// the dual-World dual-pass design mints one handle per World from this POD.
const MATERIAL_POD = {
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
};

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

// --- 4. Scene spawn helper ---------------------------------------------------

const GEOMETRY_LAYOUT = [
  { handle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0]},
  { handle: HANDLE_CUBE, pos: [-0.35, 0, 0]},
  { handle: HANDLE_QUAD, pos: [0.35, 0, 0]},
  { handle: HANDLE_SPHERE, pos: [1.05, 0, 0]},
];

function spawnScene(world, antialias) {
  // Mint the material in this World (allocSharedRef slot is per-World).
  const materialHandle = world.allocSharedRef('MaterialAsset', MATERIAL_POD);
  // 4 static geometries with shared material.
  for (const slot of GEOMETRY_LAYOUT) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: slot.pos,
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: slot.handle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
  }

  // Directional light.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.5,
    },
  });

  // Camera.
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 6]},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        antialias,
      },
    },
  );
}

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

// --- 6. Error tracker -----------------------------------------------------

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });

// --- 7. Dual-pass render ---------------------------------------------------

// FALSIFY=msaa-noop: use ANTIALIAS_NONE for both passes so renders are
// identical. This falsifies a mis-wired MSAA that is a silent no-op.
// The smoke must FAIL under this variant (diffCount <= threshold).
const antialiasForPass2 =
  FALSIFY === 'msaa-noop' ? ANTIALIAS_NONE : ANTIALIAS_MSAA;
const falsifyLabel = FALSIFY === 'msaa-noop' ? ' (FALSIFY=msaa-noop)' : '';

let framesObserved = 0;

async function renderPass(world, lease, label) {
  for (let frame = 0; frame < SMOKE_MIN_FRAMES; frame += 1) {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) {
      console.error(`[smoke] FAIL - draw (${label}) frame=${frame} failed: ${drawn.error.code}`);
      return false;
    }
    const completed = await drawn.value.completed;
    if (!completed.ok) {
      console.error(
        `[smoke] FAIL - draw (${label}) frame=${frame} completion failed: ${completed.error.code}`,
      );
      return false;
    }
    // Count only a draw whose FrameReceipt completion succeeded. This is the
    // observed work count used by the smoke gate, rather than a loop target.
    framesObserved += 1;
  }
  await device.queue.onSubmittedWorkDone();
  return true;
}

// Pass 1: ANTIALIAS_NONE baseline.
const worldNone = new World();
const worldAttachment1 = renderer.attach(worldNone);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const leaseNone = worldAttachment1.value;
spawnScene(worldNone, ANTIALIAS_NONE);

const noneRendered = await renderPass(worldNone, leaseNone, 'none');
if (!noneRendered) {
  console.log(`[smoke] frames observed=${framesObserved}`);
  process.exit(1);
}
const pixelsNone = await doReadPixels();

// Pass 2: ANTIALIAS_MSAA (or ANTIALIAS_NONE under FALSIFY).
const worldMsaa = new World();
const worldAttachment2 = renderer.attach(worldMsaa);
if (!worldAttachment2.ok) throw worldAttachment2.error;
const leaseMsaa = worldAttachment2.value;
spawnScene(worldMsaa, antialiasForPass2);

const msaaRendered = await renderPass(worldMsaa, leaseMsaa, `msaa${falsifyLabel}`);
if (!msaaRendered) {
  console.log(`[smoke] frames observed=${framesObserved}`);
  process.exit(1);
}
const pixelsMsaa = await doReadPixels();

// --- 8. Verdict ------------------------------------------------------------

const failures = [];

if (framesObserved < SMOKE_MIN_FRAMES * 2) {
  failures.push(
    `(0) successful FrameReceipt completions=${framesObserved} < required ${SMOKE_MIN_FRAMES * 2}`,
  );
}

// (a) Backend must be webgpu.
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}

// (b) Both passes must produce valid buffers.
if (pixelsNone.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) none pass pixel buffer size mismatch: ${pixelsNone.length} != ${TOTAL_PIXELS * 4}`);
}
if (pixelsMsaa.length !== TOTAL_PIXELS * 4) {
  failures.push(`(b) msaa pass pixel buffer size mismatch: ${pixelsMsaa.length} != ${TOTAL_PIXELS * 4}`);
}

// (c) RhiError must be zero.
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (d) Both passes must be non-black (geometries rendered).
let nonBlackNone = 0;
for (let i = 0; i < pixelsNone.length; i += 4) {
  if (pixelsNone[i] !== 0 || pixelsNone[i + 1] !== 0 || pixelsNone[i + 2] !== 0) {
    nonBlackNone++;
  }
}
if (nonBlackNone === 0) {
  failures.push('(d) none pass frame is completely black (geometries not rendered)');
}

let nonBlackMsaa = 0;
for (let i = 0; i < pixelsMsaa.length; i += 4) {
  if (pixelsMsaa[i] !== 0 || pixelsMsaa[i + 1] !== 0 || pixelsMsaa[i + 2] !== 0) {
    nonBlackMsaa++;
  }
}
if (nonBlackMsaa === 0) {
  failures.push('(d) msaa pass frame is completely black (geometries not rendered)');
}

// (e) Dual-pass pixel diff: count pixels (not bytes) where any channel differs.
// AC-08: diffCount > totalPixels * 0.001 (~480 for 800x600).
// Charter P3: output structured diagnostic on failure.
let diffCount = 0;
for (let i = 0; i < pixelsNone.length; i += 4) {
  if (
    pixelsNone[i] !== pixelsMsaa[i] ||
    pixelsNone[i + 1] !== pixelsMsaa[i + 1] ||
    pixelsNone[i + 2] !== pixelsMsaa[i + 2] ||
    pixelsNone[i + 3] !== pixelsMsaa[i + 3]
  ) {
    diffCount++;
  }
}

const diffPct = ((diffCount / TOTAL_PIXELS) * 100).toFixed(4);
const framesObservedPerPass = Math.floor(framesObserved / 2);
console.log(`[smoke] frames observed=${framesObservedPerPass}`);
console.log(
  `[smoke] dualPassDiff=${JSON.stringify({
    diffCount,
    threshold: DIFF_THRESHOLD,
    totalPixels: TOTAL_PIXELS,
    pct: diffPct,
    nonBlackNone,
    nonBlackMsaa,
  })}`,
);

if (FALSIFY === 'msaa-noop') {
  // Falsification: both passes used ANTIALIAS_NONE, so renders are nearly
  // identical. Two possible outcomes:
  //
  //   diffCount <= threshold -> FALSIFY PASS: the smoke correctly detects
  //   the no-op; exit(1) proves the smoke is sensitive to the MSAA
  //   toggle. This is the INTENDED outcome proving the smoke can
  //   distinguish "MSAA on" from "MSAA off".
  //
  //   diffCount > threshold -> FALSIFY FAIL: the smoke is NOT falsifiable
  //   (pixel diffs exist even when both passes use ANTIALIAS_NONE),
  //   meaning something else (renderer state leak / non-deterministic
  //   passes) is causing the difference. This is a genuine smoke bug.
  if (diffCount > DIFF_THRESHOLD) {
    console.error(
      `[smoke] FALSIFY msaa-noop FAIL - smoke NOT falsifiable: ` +
        `diffCount=${diffCount} > threshold=${DIFF_THRESHOLD} ` +
        `(pixel diffs exist even when both passes use ANTIALIAS_NONE)`,
    );
    await delay(0);
    device.destroy?.();
    process.exit(1);
  }
  console.log(
    `[smoke] FALSIFY msaa-noop PASS - diffCount=${diffCount} <= threshold=${DIFF_THRESHOLD} ` +
      `(smoke correctly detects no-op; intentional exit=1 for falsification)`,
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

if (diffCount <= DIFF_THRESHOLD) {
  failures.push(
    `(e) dual-pass pixel diff ${diffCount} <= threshold ${DIFF_THRESHOLD} (${diffPct}%)` +
      ` -- MSAA may not be active or scene edges insufficient` +
      ` (charter P3: check MSAA pipeline, camera antialias value, scene geometry edges)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, RhiError count=${errors.length}, ` +
    `nonBlackNone=${nonBlackNone}, nonBlackMsaa=${nonBlackMsaa}, ` +
    `dualPassDiff=${diffCount} > threshold=${DIFF_THRESHOLD} (${diffPct}%), frames=${framesObservedPerPass}`,
);
console.log(`[smoke] frames observed=${framesObservedPerPass}`);
console.log(
  `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    gateId: 'app-learn-render-4-advanced-opengl-10-anti-aliasing-msaa/smoke',
    commandId: 'smoke',
    framesObserved: framesObservedPerPass,
    completed: true,
  })}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
