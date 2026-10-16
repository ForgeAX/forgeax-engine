#!/usr/bin/env node
// hello-multi-world headless smoke (feat-20260708-composited-multi-world-rendering
// M5 / AC-12 / m5-i2). Drives the engine ECS path end-to-end on dawn-node and
// proves the composited multi-world contract with TWO pixel-readback probes:
//
//   probe A : world A (owner) green box on the LEFT   -> sanity, owner visible
//   probe B : world B (non-owner) red box on the RIGHT
//             (1) non-clearColor   -> both-worlds-geometry-visible (AC-06)
//             (2) luminance > floor -> cross-world-lighting  (AC-04): world B
//                 carries NO light of its own; if lights were not merged across
//                 worlds it would fall to ambient=0 (no skylight) and render
//                 black, so a lit probe B is the proof that A's light reaches B.
//   A/B     : probe A and probe B must have DISTINCT dominant colour channels
//             (A green vs B red) -> both worlds' materials reach the frame.
//
// Why a NON-BLACK clearColor (the deliberate difference from the cube smoke):
// the two development-time falsification variants (m5-t1 / plan-strategy §5.4)
// must produce DISTINCT failure signatures. With a black clearColor both
// variants would paint probe B black and be indistinguishable. With a
// distinctive clearColor:
//   v1 (owner-only renderables): probe B == clearColor          -> assertion (5)
//   v2 (per-world lights):       probe B == black geometry (!=  -> assertion (6)
//                                clearColor) but luminance ~0
// so the clearColor lets the "non-clearColor" probe isolate the geometry-merge
// failure from the lighting-merge failure. clearColor is a smoke-scene choice
// (owner Camera SoA clearR/G/B); it does not change the AI-user contract.
//
// Output literals (grep-stable for tooling):
//   - `[multi-world] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] probes=<json>`

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── env knobs ────────────────────────────────────────────────────────────────
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const NON_CLEAR_EPS = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
// A lit box must clear this luminance floor; the dark clearColor sits below it,
// so v2's black-geometry probe (luminance ~0) and v1's clearColor probe both
// drop under the floor while a genuinely lit probe B clears it.
const LIT_LUMA_FLOOR = Number.parseFloat(process.env.SMOKE_LIT_LUMA_FLOOR ?? '0.18');

const RT_W = 200;
const RT_H = 150;

// ── scene SSOT (paired with apps/hello/multi-world/src/main.ts) ───────────────
const CAMERA_Z = 6;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_ASPECT = 16 / 9;
const BOX_X = 1.6;
// Distinctive clearColor: dark indigo, well below LIT_LUMA_FLOOR, far (> eps)
// from pure black so a black box reads as non-clearColor (v2 discrimination).
const CLEAR = { r: 0.1, g: 0.1, b: 0.18, a: 1 };
const A_GREEN = [0.15, 0.8, 0.2, 1];
const B_RED = [0.85, 0.15, 0.15, 1];
const B_BLUE = [0.2, 0.3, 0.85, 1];

// Project a world-space point (camera at (0,0,CAMERA_Z) looking down -Z,
// identity orientation) to a framebuffer pixel. Both probed boxes sit on the
// ndc-y=0 center row, so the vertical flip convention never affects the probe.
function projectToPixel(worldX, worldY) {
  const f = 1 / Math.tan(CAMERA_FOV / 2);
  const viewZ = worldY * 0 + (0 - CAMERA_Z); // z=0 plane -> viewZ = -CAMERA_Z
  const w = -viewZ;
  const ndcX = ((f / CAMERA_ASPECT) * worldX) / w;
  const ndcY = (f * worldY) / w;
  const px = Math.round((ndcX * 0.5 + 0.5) * RT_W);
  const py = Math.round((0.5 - ndcY * 0.5) * RT_H);
  return [px, py];
}

// ── dawn-node binding ─────────────────────────────────────────────────────────
let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-multi-world smoke');
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
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Capture the raw GPUDevice the engine ends up using so the offscreen readback
// runs on the same device (hook adapter.requestDevice, restore after ready).
let sharedDevice;
const ambientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await ambientRequestAdapter(opts);
  if (adapter === null) return adapter;
  const inner = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await inner(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// ── mock canvas + offscreen render target ─────────────────────────────────────
let renderTarget;
function ensureRT(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: RT_W, height: RT_H, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
const mockCanvas = {
  width: RT_W,
  height: RT_H,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRT(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRT(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// ── build worlds (mirror src/main.ts; owner camera carries the clearColor) ────
const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials } = await import('@forgeax/engine-render');
const { perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

function spawnLitBox(world, color, x, y) {
  const mat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: color, metallic: 0, roughness: 0.5 }));
  world
    .spawn(
      { component: Transform, data: { pos: [x, y, 0], scale: [1.4, 1.4, 1.4] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [mat] } },
    )
    .unwrap();
}

const worldA = new World();
spawnLitBox(worldA, A_GREEN, -BOX_X, 0);
worldA
  .spawn(
    { component: Transform, data: { pos: [0, 0, CAMERA_Z]} },
    {
      component: Camera,
      data: {
        ...perspective({ fov: CAMERA_FOV, aspect: CAMERA_ASPECT }),
        clearColor: [CLEAR.r, CLEAR.g, CLEAR.b, CLEAR.a],
      },
    },
  )
  .unwrap();
worldA
  .spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.7, -1], color: [1, 1, 1], intensity: 1.4 },
  })
  .unwrap();

const worldB = new World();
spawnLitBox(worldB, B_RED, BOX_X, 0);
spawnLitBox(worldB, B_BLUE, BOX_X, BOX_X);

// ── renderer + shader manifest ────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = ambientRequestAdapter;
}
const worldAttachment1 = renderer.attach(worldA);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const worldAttachment2 = renderer.attach(worldB);
if (!worldAttachment2.ok) throw worldAttachment2.error;

console.log(`[multi-world] backend=${renderer.inspect().capabilities.backendKind}`);

const rhiErrors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') rhiErrors.push({ code: event.error.code, hint: event.error.hint });
});


// ── frame loop: composite both worlds, owner = index 0 ────────────────────────
const targetFrames = MIN_FRAMES;
let frames = 0;
for (let i = 0; i < targetFrames; i++) {
  worldB.update().unwrap();
  worldA.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value, worldAttachment2.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) {
    console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
    process.exit(1);
  }
  const completed = await r.value.completed;
  if (!completed.ok) {
    console.error(`[smoke] frame ${i} completion error: ${completed.error.code}`);
    process.exit(1);
  }
  frames++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${frames} (target=${targetFrames})`);

// ── readback ──────────────────────────────────────────────────────────────────
if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated; engine did not call context.configure()');
  process.exit(1);
}
const bpp = 4;
const bytesPerRow = Math.ceil((RT_W * bpp) / 256) * 256;
const readback = device.createBuffer({ size: bytesPerRow * RT_H, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readback, bytesPerRow, rowsPerImage: RT_H },
    { width: RT_W, height: RT_H, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readback.mapAsync(0x01);
} catch (err) {
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const px = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();

// Average an odd NxN window (kept well inside each box's projected footprint).
function sampleWindow(cx, cy, half = 2) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= RT_W || y >= RT_H) continue;
      const off = y * bytesPerRow + x * bpp;
      r += (px[off] ?? 0) / 255;
      g += (px[off + 1] ?? 0) / 255;
      b += (px[off + 2] ?? 0) / 255;
      n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dominant = ([r, g, b]) => (r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b');

const [ax, ay] = projectToPixel(-BOX_X, 0);
const [bx, by] = projectToPixel(BOX_X, 0);
const probeA = sampleWindow(ax, ay);
const probeB = sampleWindow(bx, by);
// clearColor reference is sampled EMPIRICALLY from a background corner, not the
// linear CLEAR constant: the readback is sRGB-encoded, so comparing a probe to
// the raw linear clearColor would mis-measure the "non-clearColor" distance
// (a bug the m5-t1 v1 falsification variant caught). A sampled corner is
// sRGB-vs-sRGB, so distance is honest regardless of the encoding.
const clearRgb = sampleWindow(Math.floor(RT_W * 0.04), Math.floor(RT_H * 0.5));
const probes = {
  probeA: { px: [ax, ay], rgb: probeA.map((v) => +v.toFixed(3)), dominant: dominant(probeA) },
  probeB: { px: [bx, by], rgb: probeB.map((v) => +v.toFixed(3)), dominant: dominant(probeB), luma: +luma(probeB).toFixed(3) },
  clear: clearRgb.map((v) => +v.toFixed(3)),
};
console.log(`[smoke] probes=${JSON.stringify(probes)}`);

// ── verdict ───────────────────────────────────────────────────────────────────
const fail = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') fail.push(`(1) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (frames < MIN_FRAMES) fail.push(`(2) frames=${frames} < ${MIN_FRAMES}`);
if (rhiErrors.length > 0) fail.push(`(3) Renderer.onError fired ${rhiErrors.length}x: [${rhiErrors.map((e) => e.code).join(', ')}]`);
if (dist(probeA, clearRgb) <= NON_CLEAR_EPS) {
  fail.push(`(4) probeA ${JSON.stringify(probeA)} ~= clearColor (owner world A geometry not visible; dist ${dist(probeA, clearRgb).toFixed(4)})`);
}
if (dist(probeB, clearRgb) <= NON_CLEAR_EPS) {
  fail.push(`(5) both-worlds-geometry-visible: probeB ${JSON.stringify(probeB)} ~= clearColor (world B not merged; dist ${dist(probeB, clearRgb).toFixed(4)})`);
}
if (luma(probeB) <= LIT_LUMA_FLOOR) {
  fail.push(`(6) cross-world-lighting: probeB luma ${luma(probeB).toFixed(4)} <= ${LIT_LUMA_FLOOR} (world B not lit by world A's light)`);
}
if (dominant(probeA) === dominant(probeB)) {
  fail.push(`(7) probeA/probeB share dominant channel '${dominant(probeA)}' (worlds not rendering distinct materials)`);
}

if (fail.length > 0) {
  console.error(`[smoke] FAIL - ${fail.length} criteria failed:`);
  for (const f of fail) console.error(`  ${f}`);
  console.error('  rerun: pnpm --filter @forgeax/hello-multi-world smoke');
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 7 criteria GREEN: backend=webgpu, frames=${frames}, RhiError=0, ` +
    `probeA(${dominant(probeA)}) + probeB(${dominant(probeB)}) both non-clearColor, ` +
    `probeB luma ${luma(probeB).toFixed(3)} > ${LIT_LUMA_FLOOR} (cross-world lit), distinct worlds`,
);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
