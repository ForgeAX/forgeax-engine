#!/usr/bin/env node
// hello-tonemap headless smoke (feat-20260519-tonemap-reinhard-mvp / M4 /
// T-M4.2; AC-07 / AC-08 / AC-09).
//
// Strategy (mirrors hello-room smoke; charter proposition 5 consistent
// abstraction):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat so the swap-chain srgb encode runs).
//   3. Spawn the same World as apps/hello/tonemap/src/main.ts: 1 PBR
//      sphere + 1 Camera with `tonemap = 'reinhard-extended'` /
//      `exposure = 1.0` / `whitePoint = 8.0` + 1 intensity-2
//      DirectionalLight.
//   4. await runtime host initialization + 60 frames of lease-bound renderer.draw(...).
//   5. copyTextureToBuffer + mapAsync; full-frame scan for AC-07
//      (no integer-white burn anywhere); highlight site readback for
//      AC-08 (per channel ∈ (0.3, 1.0)). AC-09 (reference-png ε ≤ 0.05)
//      is gated by the presence of `scripts/reference-dawn.png` — the
//      first run produces the baseline; subsequent runs (or CI replay)
//      compare byte-for-byte within ε.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-tonemap] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS`

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReferencePng, readReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

const WIDTH = 800;
const HEIGHT = 600;
const CLEAR_RGBA = [0, 0, 0, 1];

const here = dirname(fileURLToPath(import.meta.url));
// Baseline PNG lives in the forgeax-engine-assets submodule
// (smoke-baselines/<demo>/) so the engine repo never tracks rendered
// binaries; bug-20260522 PBR-normal-fallback fix companion.
const MONOREPO_ROOT = resolve(here, '..', '..', '..', '..');
const REFERENCE_PNG_PATH = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'smoke-baselines',
  'hello-tonemap',
  'reference-dawn.png',
);

// --- 1. dawn.node setup ----------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-tonemap smoke');
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so
// the readback stays byte-comparable to the committed baseline. Browser path
// (test:browser project) does not run smoke-dawn.mjs; the real Channel 2 BGRA
// path is exercised through the helper unmodified there.
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

// --- 3. Drive engine ECS path ---------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { createSphereGeometry } = await import('@forgeax/engine-geometry');
const {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  TONEMAP_REINHARD_EXTENDED,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[hello-tonemap] backend=${renderer.inspect().capabilities.backendKind}`);

const sphereRes = createSphereGeometry(0.6, 32, 24);
if (!sphereRes.ok) {
  console.error(`[smoke] FAIL - createSphereGeometry: ${sphereRes.error.code}`);
  process.exit(1);
}
// w64: mint sphere + material as user-tier shared refs (register deleted M8).
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const sphereHandle = world.allocSharedRef('MeshAsset', sphereRes.value);

// feat-20260527 M3 / w12: pass-based MaterialAsset via the unified path.
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
    baseColor: [0.7, 0.7, 0.7, 1],
    metallic: 0.0,
    roughness: 0.4,
  },
});

void okResult(
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ),
);
void okResult(
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 2.5], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_REINHARD_EXTENDED,
        exposure: 1.0,
        whitePoint: 8.0,
      },
    },
  ),
);
void okResult(
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 2,
    },
  }),
);

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 4. Pixel readback ----------------------------------------------------

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
  console.error(
    `[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

// Pack to a tightly-packed RGBA buffer (BGRA -> RGBA, drop the row pad).
// Each row keeps the same WIDTH stride so we can stream into a baseline PNG.
const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    const dst = (y * WIDTH + x) * 4;
    tightRgba[dst + 0] = bytes[off + 0] ?? 0; // R
    tightRgba[dst + 1] = bytes[off + 1] ?? 0; // G
    tightRgba[dst + 2] = bytes[off + 2] ?? 0; // B
    tightRgba[dst + 3] = bytes[off + 3] ?? 0; // A
  }
}

// Helper: read RGBA at (x, y) from the tight buffer, normalised.
const readRgba = (px, py) => {
  const off = (py * WIDTH + px) * 4;
  return [
    (tightRgba[off + 0] ?? 0) / 255,
    (tightRgba[off + 1] ?? 0) / 255,
    (tightRgba[off + 2] ?? 0) / 255,
    (tightRgba[off + 3] ?? 0) / 255,
  ];
};

// Sample sites:
// - centerSphere: NDC center (sphere body, mid-grey lit)
// - highlightBand: shifted toward the light direction (-0.4, -0.6) for the
//   brightest reflection band
// - corner: bg / clear color sanity
const cx = Math.floor(WIDTH / 2);
const cy = Math.floor(HEIGHT / 2);
// Light direction projects onto screen as (-0.4, -0.6) -> push the sample
// slightly up-left of center to land in the highlight band.
const hx = Math.max(0, Math.min(WIDTH - 1, cx + Math.floor(WIDTH * -0.05)));
const hy = Math.max(0, Math.min(HEIGHT - 1, cy + Math.floor(HEIGHT * -0.07)));
const cornerX = Math.floor(WIDTH * 0.05);
const cornerY = Math.floor(HEIGHT * 0.05);

const pixelSamples = {
  centerSphere: readRgba(cx, cy),
  highlightBand: readRgba(hx, hy),
  corner: readRgba(cornerX, cornerY),
};
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (AC-07 / AC-08 / AC-09) -----------------------------------

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// AC-07: full-frame scan for any (255, 255, 255) RGB triplet — the integer
// white-burn signature. Alpha is byte-copied (often 255 on the swap-chain
// store), so we only assert RGB.
let burnCount = 0;
for (let i = 0; i < tightRgba.length; i += 4) {
  if (tightRgba[i] === 255 && tightRgba[i + 1] === 255 && tightRgba[i + 2] === 255) {
    burnCount++;
  }
}
if (burnCount > 0) {
  failures.push(`(d) AC-07 integer-white burn: ${burnCount} pixels with RGB=(255,255,255)`);
}

// AC-08: the highlight band must read back inside (0.3, 1.0) per RGB
// channel — the engine compresses the > 1.0 HDR luminance into the
// displayable range. Search the upper-left half-quadrant for the brightest
// pixel (luminance) and assert that pixel against the band.
let brightestRgb = [0, 0, 0];
let brightestY = 0;
for (let py = 0; py < Math.floor(HEIGHT * 0.6); py++) {
  for (let px = Math.floor(WIDTH * 0.2); px < Math.floor(WIDTH * 0.6); px++) {
    const r = (tightRgba[(py * WIDTH + px) * 4 + 0] ?? 0) / 255;
    const g = (tightRgba[(py * WIDTH + px) * 4 + 1] ?? 0) / 255;
    const b = (tightRgba[(py * WIDTH + px) * 4 + 2] ?? 0) / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > brightestY) {
      brightestY = luma;
      brightestRgb = [r, g, b];
    }
  }
}
console.log(`[smoke] brightestPixel=${JSON.stringify({ rgb: brightestRgb, luma: brightestY })}`);
const [br, bg, bb] = brightestRgb;
const inBand = (v) => v > 0.3 && v < 1.0;
if (!(inBand(br) && inBand(bg) && inBand(bb))) {
  failures.push(
    `(e) AC-08 highlight band: brightestRgb=${JSON.stringify(brightestRgb)} not all in (0.3, 1.0)`,
  );
}

if (!existsSync(REFERENCE_PNG_PATH)) {
  const png = writeReferencePng(tightRgba, WIDTH, HEIGHT);
  writeFileSync(REFERENCE_PNG_PATH, png);
  console.error(
    `[smoke] AC-09 reference PNG WRITTEN to ${REFERENCE_PNG_PATH} (no prior baseline). ` +
      `Inspect and commit this file (gitignore whitelist '!apps/*/scripts/reference-*.png' ` +
      `tracks it); rerun smoke to enter COMPARED mode.`,
  );
  failures.push('(f) AC-09 reference PNG missing baseline (first-run WRITTEN; commit then rerun)');
} else {
  const ref = readReferencePng(REFERENCE_PNG_PATH);
  if (ref.width !== WIDTH || ref.height !== HEIGHT) {
    failures.push(`(f) AC-09 reference PNG size mismatch: ${ref.width}x${ref.height} != ${WIDTH}x${HEIGHT}`);
  } else {
    let maxDelta = 0;
    let exceedCount = 0;
    for (let i = 0; i < ref.pixels.length; i += 4) {
      const dr = Math.abs((ref.pixels[i] ?? 0) - (tightRgba[i] ?? 0)) / 255;
      const dg = Math.abs((ref.pixels[i + 1] ?? 0) - (tightRgba[i + 1] ?? 0)) / 255;
      const db = Math.abs((ref.pixels[i + 2] ?? 0) - (tightRgba[i + 2] ?? 0)) / 255;
      const d = Math.max(dr, dg, db);
      if (d > maxDelta) maxDelta = d;
      if (d > SMOKE_PIXEL_THRESHOLD) exceedCount++;
    }
    console.log(`[smoke] AC-09 referencePngDelta=${JSON.stringify({ maxDelta: maxDelta.toFixed(4), exceedCount })}`);
    if (exceedCount > Math.floor(WIDTH * HEIGHT * 0.001)) {
      failures.push(
        `(f) AC-09 reference PNG drift: ${exceedCount} pixels exceed eps=${SMOKE_PIXEL_THRESHOLD} (max=${maxDelta.toFixed(4)})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-tonemap smoke`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, AC-07 burnCount=0, AC-08 highlight in (0.3, 1.0), AC-09 reference PNG within eps=${SMOKE_PIXEL_THRESHOLD}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
