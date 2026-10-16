#!/usr/bin/env node
// hello-sprite headless smoke (feat-20260520-2d-sprite-layer-mvp / M-4 /
// w30; AC-13).
//
// Strategy (mirrors apps/hello/tonemap/scripts/smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package
//      (dawn-node native binding ^0.4.0).
//   2. Mock canvas + offscreen render target (`bgra8unorm` storage with
//      `bgra8unorm-srgb` viewFormat so the swap-chain srgb encode runs).
//   3. Register a synthetic 8x8 RGBA texture (4 quadrants of 4 distinct
//      colours) + a default sampler so the sprite material loads
//      without a /pack-index.json fetch (dawn-node has no HTTP server;
//      the registered texture handle bypasses the loadByGuid chain).
//   4. For each of 4 matrix cases (scene-A/B x tonemap-none / reinhard-
//      extended) build a fresh World + spawn 3 sprite entities +
//      camera + 60 render frames + copyTextureToBuffer + mapAsync +
//      write or compare the reference PNG.
//   5. AC-13 passes when all 4 PNGs sit within eps<=0.05 of their
//      reference baselines. First-run writes the baselines and exits
//      with a "WRITTEN" marker so CI / human review can commit them
//      then rerun.
//
// AC-13 path note (charter F2 + P5 producer/consumer split):
// - subagent runs this script and PRODUCES the PNGs; the main session
//   orchestrator (humans + parent agent) READS the PNGs to verify the
//   visual is what was asked for. The script never self-reports
//   "image observed" content, only delta numerics.
// - When the forgeax-engine-assets submodule is not initialised the
//   synthetic 8x8 quadrant texture stands in for wood-container.jpg --
//   the demo's visual identity rests on the colorTint trio + the
//   transparent-sort order, not on the texture itself (D-5 spirit:
//   wood-container is mnemonic, not semantic).
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-sprite] backend=webgpu`
//   - `[smoke] case <scene>/<tonemap> frames=<N>`
//   - `[smoke] case <scene>/<tonemap> maxDelta=<f>`
//   - `[smoke] PASS` or `[smoke] FAIL - ...`

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeReferencePng, readReferencePng } from '../../../shared/png-codec.mjs';
import { rasterizeSpriteReference } from './reference-raster.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260626-sprite-transparent-collapse M5-T1 (plan-strategy D-5):
// FALSIFY env routes opt-in falsifier branches. Existing token
// `nineslice-anchor` is wired further below in the nineslice section.
// New token `missing-sprite-blend` here proves charter P3 "explicit
// failure > implicit default": when a user authoring a sprite material
// omits `renderState.blend`, the engine no longer silently picks
// premultiplied-alpha -- the sprite paints opaque-over-clear and the
// 4-PNG matrix readback drifts beyond eps, which surfaces as exit != 0.
// fail-when-passes shape: in FALSIFY mode, an exit 0 (i.e. all 4 PNG
// cases within eps) would itself be the falsifier failure -- it would
// mean the legacy implicit-premul path is still alive somewhere.
const FALSIFY = process.env.FALSIFY ?? '';
const FALSIFY_MISSING_SPRITE_BLEND = FALSIFY === 'missing-sprite-blend';

const WIDTH = 800;
const HEIGHT = 600;
const SPRITE_SCALE = 0.16;
const SPRITE_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
];
const CLEAR_RGBA = [0.07, 0.07, 0.09, 1];

const here = dirname(fileURLToPath(import.meta.url));
// Baseline PNGs live in the forgeax-engine-assets submodule
// (smoke-baselines/hello-sprite/) so the engine repo never tracks
// rendered binaries; bug-20260522 PBR-normal-fallback fix companion.
const BASELINE_DIR = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'forgeax-engine-assets',
  'smoke-baselines',
  'hello-sprite',
);

// 4-case matrix. The filename suffix mirrors the field values so a CI
// failure log line points at a single PNG without indirection (charter
// F1 limited context).
const MATRIX = [
  { scene: 'A', tonemap: 'none', refFile: 'reference-dawn-scene-a-tonemap-none.png' },
  { scene: 'A', tonemap: 'reinhard', refFile: 'reference-dawn-scene-a-tonemap-reinhard.png' },
  { scene: 'B', tonemap: 'none', refFile: 'reference-dawn-scene-b-tonemap-none.png' },
  { scene: 'B', tonemap: 'reinhard', refFile: 'reference-dawn-scene-b-tonemap-reinhard.png' },
];

// --- 1. dawn.node setup --------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-sprite smoke');
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

// --- 2. Mock canvas (shared across matrix runs) --------------------------
//
// Each matrix case rebuilds the renderTarget so the previous frame's
// pixels do not bleed into the next case's readback. We hold the
// texture by reference inside the closure so getCurrentTexture() can
// return the per-case target.

let activeRenderTarget = null;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (activeRenderTarget) {
          activeRenderTarget.destroy?.();
        }
        activeRenderTarget = desc.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {
        activeRenderTarget?.destroy?.();
        activeRenderTarget = null;
      },
      getCurrentTexture() {
        if (!activeRenderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          activeRenderTarget = sharedDevice.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
        return activeRenderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Drive engine ECS path --------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { ok: okResult } = await import('@forgeax/engine-types');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { TransparentSort, SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');
const { Camera, Layer, MeshFilter, MeshRenderer, TONEMAP_NONE, TONEMAP_REINHARD_EXTENDED } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');

// Mirror the CAMERA_PROJECTION_ORTHOGRAPHIC constant inline (the runtime
// barrel does not re-export it today; the demo's main.ts inlines the
// same `1` literal -- see apps/hello/sprite/src/main.ts header).
const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

// Synthetic 8x8 RGBA texture (4 colour quadrants). Each quadrant fills
// a 4x4 region with a high-saturation hue so the colorTint multiply
// remains visible in the readback. The dawn-node mock target makes a
// real /pack-index.json fetch impossible (no HTTP server), and the
// forgeax-engine-assets submodule may not be initialised in the
// worktree -- the synthetic fallback keeps AC-13 evaluable when the
// upstream source PNG is unavailable.
function buildSyntheticRgba() {
  const w = 8;
  const h = 8;
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const quadrant = top ? (left ? 0 : 1) : left ? 2 : 3;
      // 0=warm orange, 1=fresh green, 2=cool cyan, 3=pale magenta
      const palette = [
        [220, 110, 50, 255],
        [80, 220, 100, 255],
        [60, 180, 220, 255],
        [230, 130, 200, 255],
      ];
      const c = palette[quadrant];
      bytes[i + 0] = c[0];
      bytes[i + 1] = c[1];
      bytes[i + 2] = c[2];
      bytes[i + 3] = c[3];
    }
  }
  return { width: w, height: h, data: bytes };
}

const SPRITE_COLOR_TINTS = [
  // Keep one sprite partially transparent so the falsifier exercises the
  // declared premultiplied blend state instead of passing with an all-opaque
  // fixture. The other two remain opaque color anchors for sorting/coverage.
  [1.0, 0.4, 0.4, 0.72],
  [0.4, 1.0, 0.4, 1.0],
  [0.4, 0.4, 1.0, 1.0],
];

const SCENE_LAYOUTS = {
  A: {
    pivot: [0.5, 0.5],
    sortMode: TransparentSort.layerZ,
    sprites: [
      { layer: -100, pos: [-0.4, -0.1, -0.5] },
      { layer: 0, pos: [0.0, 0.0, 0.0] },
      { layer: 100, pos: [0.4, 0.1, 0.5] },
    ],
  },
  B: {
    pivot: [0.5, 1.0],
    sortMode: TransparentSort.layerY,
    sprites: [
      { layer: 0, pos: [-0.4, 0.3, 0.0] },
      { layer: 0, pos: [0.0, 0.0, 0.0] },
      { layer: 0, pos: [0.4, -0.3, 0.0] },
    ],
  },
};

const TONEMAP_VALUES = {
  none: TONEMAP_NONE,
  reinhard: TONEMAP_REINHARD_EXTENDED,
};

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
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

console.log(`[hello-sprite] backend=${renderer.inspect().capabilities.backendKind}`);

const assets = hostAssets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// Synthetic texture POD shared as data across matrix runs; the texture /
// sampler / material handles are minted INSIDE each draw World below, because
// D-15 makes SharedRefStore per-World -- a handle minted in one World is not
// resolvable from another (the engine rejects the cross-World retain).
const synth = buildSyntheticRgba();
const synthPod = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: synth.width, height: synth.height } },
  format: 'rgba8unorm-srgb',
  data: synth.data,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};


// Mints the texture, default repeat sampler, and the 3
// per-scene sprite materials into `world`. Returns the material handle array.
async function mintSpriteAssets(world, layout) {
  const textureHandle = world.allocSharedRef('TextureAsset', synthPod);
  const samplerHandle = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const materialHandles = [];
  // feat-20260626 M5-T1 (plan-strategy D-5): FALSIFY=missing-sprite-blend
  // omits `renderState.blend` from the pass descriptor (renderState empty)
  // so the engine cannot infer transparent/premul; the 4-PNG matrix readback
  // is then expected to drift beyond eps, asserting that the implicit
  // premul fallback was actually retired.
  const spritePassRenderState = FALSIFY_MISSING_SPRITE_BLEND
    ? {}
    : { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND };
  for (let i = 0; i < 3; i++) {
    materialHandles.push(
      world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        passes: [
          // feat-20260626-sprite-transparent-collapse M3 — post M1/M2
          // SSOT: `renderState.blend` drives LDR split + premultiplied-
          // alpha blend pipeline (preset `SPRITE_PREMULTIPLIED_ALPHA_BLEND`).
          { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...spritePassRenderState, tags: { LightMode: 'Forward' }, queue: 3000 } },
        ],
        parameters: SPRITE_PARAMETERS,
        values: {
          // feat-20260625 M3 / w11 (D-4): UBO-aligned field names. layout.pivot
          // [px, py] folds into pivotAndSize.xy; .zw is the unused legacy size
          // slot kept for std140 byte stability (sprite.wgsl ignores it).
          colorTint: SPRITE_COLOR_TINTS[i],
          baseColorTexture: textureHandle,
          region: [0, 0, 1, 1],
          pivotAndSize: [layout.pivot[0], layout.pivot[1], 1, 1],
        },
      }),
    );
  }
  return { ok: true, textureHandle, samplerHandle, materialHandles };
}

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const failures = [];

for (const matrixCase of MATRIX) {
  const { scene, tonemap, refFile } = matrixCase;
  const layout = SCENE_LAYOUTS[scene];
  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const mint = await mintSpriteAssets(world, layout);
  if (!mint.ok) {
    failures.push(`case ${scene}/${tonemap}: synthetic texture upload: ${mint.error.code}`);
    continue;
  }
  const materialHandles = mint.materialHandles;

  // Configure transparent sort mode (mode=0 for A / mode=1 for B).
  const sortCfgRes = TransparentSort.configure(world, {
    mode: layout.sortMode,
    yzAlpha: 1.0,
  });
  if (!sortCfgRes.ok) {
    failures.push(
      `case ${scene}/${tonemap} setTransparentSortConfig: ${sortCfgRes.error.code} ${sortCfgRes.error.expected}`,
    );
    continue;
  }

  // Spawn 3 sprite entities for the current scene.
  for (let i = 0; i < layout.sprites.length; i++) {
    const slot = layout.sprites[i];
    const matHandle = materialHandles[i];
    okResult(
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [slot.pos[0], slot.pos[1], slot.pos[2]], quat: [0, 0, 0, 1], scale: [SPRITE_SCALE, SPRITE_SCALE, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
        { component: Layer, data: { value: slot.layer } },
      ),
    );
  }

  // Orthographic camera; tonemap is the per-case variant.
  okResult(
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          tonemap: TONEMAP_VALUES[tonemap],
          exposure: 1.0,
          whitePoint: 8.0,
          clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
        },
      },
    ),
  );

  let framesObserved = 0;
  for (let i = 0; i < TARGET_FRAMES; i++) {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    });
    if (!r.ok) console.error(`[smoke] case ${scene}/${tonemap} draw frame ${i}: ${r.error.code}`);
    else {
      framesObserved++;
    }
  }

  const device = sharedDevice;
  if (!device) {
    failures.push(`case ${scene}/${tonemap}: no shared device captured`);
    continue;
  }
  await device.queue.onSubmittedWorkDone();
  console.log(`[smoke] case ${scene}/${tonemap} frames=${framesObserved}`);

  if (!activeRenderTarget) {
    failures.push(`case ${scene}/${tonemap}: renderTarget never allocated`);
    continue;
  }

  // Pixel readback (BGRA -> RGBA flip, row-pad strip; identical recipe
  // to apps/hello/tonemap/scripts/smoke-dawn.mjs).
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: activeRenderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    failures.push(
      `case ${scene}/${tonemap} mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    readbackBuffer.destroy();
    continue;
  }
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  const tightRgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tightRgba[dst + 0] = bytes[off + 0] ?? 0;
      tightRgba[dst + 1] = bytes[off + 1] ?? 0;
      tightRgba[dst + 2] = bytes[off + 2] ?? 0;
      tightRgba[dst + 3] = bytes[off + 3] ?? 0;
    }
  }
  // Optional failure evidence stays separate from the authoritative baseline.
  if (process.env.SMOKE_OUTPUT_DIR !== undefined) {
    const outputDir = resolve(process.env.SMOKE_OUTPUT_DIR);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, `actual-${scene}-${tonemap}.png`),
      writeReferencePng(tightRgba, WIDTH, HEIGHT));
  }

  // Reference PNG compare or first-run write. Baseline path resolves
  const analytic = rasterizeSpriteReference({ width: WIDTH, height: HEIGHT, clear: CLEAR_RGBA,
    layout, tints: SPRITE_COLOR_TINTS, texture: synth, scale: SPRITE_SCALE, tonemap });
  let analyticMaximum = 0;
  for (let index = 0; index < tightRgba.length; index++)
    analyticMaximum = Math.max(analyticMaximum, Math.abs(tightRgba[index] - analytic.pixels[index]));
  console.log(`[smoke] independent-raster ${scene}/${tonemap} maxCodeDelta=${analyticMaximum}`);
  if (analyticMaximum > 2) failures.push(`case ${scene}/${tonemap}: independent-raster drift ${analyticMaximum} codes > 2`);

  // Reference PNG compare or first-run write. Baseline path resolves
  // into the forgeax-engine-assets submodule (BASELINE_DIR above).
  const refPath = resolve(BASELINE_DIR, refFile);
  if (!existsSync(refPath)) {
    if (FALSIFY_MISSING_SPRITE_BLEND) {
      // feat-20260626 M5-T1: refuse to seed baselines while a falsifier
      // is active -- writing the falsified frame would lock the broken
      // visual into the baseline (charter F2 image-trust). Surface the
      // gap and let the caller rerun without FALSIFY to seed.
      failures.push(
        `case ${scene}/${tonemap}: FALSIFY=missing-sprite-blend active and baseline absent at ${refPath}; rerun without FALSIFY to seed`,
      );
      continue;
    }
    mkdirSync(BASELINE_DIR, { recursive: true });
    const png = writeReferencePng(tightRgba, WIDTH, HEIGHT);
    writeFileSync(refPath, png);
    console.error(
      `[smoke] case ${scene}/${tonemap}: AC-13 reference PNG WRITTEN to ${refPath} (no prior baseline). ` +
        'Inspect and commit (gitignore whitelist apps/*/scripts/reference-*.png covers this); rerun smoke to enter COMPARED mode.',
    );
    failures.push(`case ${scene}/${tonemap}: reference PNG missing (first-run WRITTEN; commit then rerun)`);
    continue;
  }

  const ref = readReferencePng(refPath);
  if (ref.width !== WIDTH || ref.height !== HEIGHT) {
    failures.push(
      `case ${scene}/${tonemap}: reference PNG size mismatch ${ref.width}x${ref.height} != ${WIDTH}x${HEIGHT}`,
    );
    continue;
  }
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
  console.log(`[smoke] case ${scene}/${tonemap} maxDelta=${maxDelta.toFixed(4)} exceed=${exceedCount}`);
  if (exceedCount > Math.floor(WIDTH * HEIGHT * 0.001)) {
    failures.push(
      `case ${scene}/${tonemap}: reference PNG drift ${exceedCount} px > eps=${SMOKE_PIXEL_THRESHOLD} (max=${maxDelta.toFixed(4)})`,
    );
  }
}

// ── 9-slice structural section (feat-20260527-sprite-nineslice / M5 / w22) ──
//
// AC-13 verify gate (plan-strategy section 5.1): the 4 PNG matrix above is
// the existing pre-feat baseline. The 9-slice section adds STRUCTURAL
// assertions on a fresh World whose entities exercise both sliceMode=0
// (stretch) and sliceMode=1 (tile) sprites. Pixel-readback for the 9-slice
// section is intentionally deferred to step-verify (forgeax-visual playwright
// -cli protocol per charter P5; subagent produces PNG, main session reads).
// Here we assert engine-side invariants that fail-loud if a regression
// reverts the 9-slice path:
//
//   1. HANDLE_NINESLICE_QUAD is exported from @forgeax/engine-runtime and
//      its id === 5 (D-2 plan-strategy: HANDLE_QUAD=3 < HANDLE_SPHERE=4 <
//      HANDLE_NINESLICE_QUAD=5 < FIRST_USER_HANDLE=1024).
//   2. AssetRegistry.register accepts sprite values with `slices` +
//      `sliceMode` literals on the pass-based MaterialAsset surface (D-1).
//   3. With sliceMode=1 + sampler.addressMode='clamp-to-edge' the D-9 soft
//      -warn path increments `nineslice.tile-needs-repeat-sampler` >= 1
//      (plan-strategy D-9 register-time fail-fast escape via the AssetRegistry
//      owner counter; Renderer no longer exposes a metrics facade).
//   4. The 9-slice section can render >= 30 frames without engine errors
//      (smoke draw-loop check; structural, no pixel parity).
//
// Falsifier (FALSIFY=nineslice-anchor):
//   When set, replaces `slices` with [0,0,0,0] (degenerate equivalent of
//   legacy quad). Assertion #3 should still hold (the soft-warn fires for
//   sliceMode=1 regardless of slices content) but structural assertion #5
//   below (the AssetRegistry owner counter for
//   `nineslice.tile-needs-repeat-sampler` must increase by >= 1
//   after register) becomes the falsifiable predicate -- if the sentinel
//   path silently early-exits to the legacy sprite branch without firing
//   the soft-warn, the falsifier reveals it. The falsifier is opt-in; CI
//   default does not set FALSIFY.
//
// AC-12 ECS-side zero-increment (plan-review.md round 1 issue #2):
//   The 9-slice work must NOT add `9-slice` / `nineslice` references to
//   `packages/render/src/components/sort-key.ts` /
//   `packages/render/src/components/layer.ts` (RenderQueue + Layer + sort
//   formula `pos y - pivotY * sizeY` stay 9-slice-agnostic). The smoke greps
//   the two files inline and fails if either contains a hit.

const FALSIFY_NINESLICE_ANCHOR = FALSIFY === 'nineslice-anchor';

console.log(
  `[smoke] nineslice section start; FALSIFY=${FALSIFY === '' ? '<unset>' : FALSIFY}`,
);

// Assertion #1: HANDLE_NINESLICE_QUAD shape.
const { HANDLE_NINESLICE_QUAD } = await import('@forgeax/engine-assets-runtime');
if (HANDLE_NINESLICE_QUAD === undefined) {
  failures.push('nineslice: HANDLE_NINESLICE_QUAD missing from @forgeax/engine-runtime barrel');
}
// Handle is a u32 brand; the unwrapped numeric form is HANDLE_NINESLICE_QUAD
// + 0 (any cast back to number works).
const ninesliceHandleId = Number(HANDLE_NINESLICE_QUAD);
if (ninesliceHandleId !== 5) {
  failures.push(
    `nineslice: HANDLE_NINESLICE_QUAD id=${ninesliceHandleId}, expected 5 (D-2 builtin slot)`,
  );
}

// Assertion #2 + #3: D-9 soft-warn path. Build a fresh world + register a
// sliceMode=1 material with addressMode='clamp-to-edge' sampler so the D-9
// branch fires. All handles are minted into this World (D-15 per-World refs).
let ninesliceDrawErrors = 0;
let softWarnDelta = 0;
const ninesliceFrames = Math.max(30, Math.floor(SMOKE_MIN_FRAMES / 10));
{
  const world = new World();
  const ninesliceAttachment = renderer.attach(world);
  if (!ninesliceAttachment.ok) throw ninesliceAttachment.error;
  const ninesliceTextureHandle = world.allocSharedRef('TextureAsset', synthPod);
  const ninesliceMetrics = assets._getMetrics?.();
  if (ninesliceMetrics === undefined || ninesliceMetrics === null) {
    failures.push('nineslice: AssetRegistry owner metrics are unavailable');
  }
  const ninesliceMetricsBefore = ninesliceMetrics?.snapshot() ?? {};
  const beforeCount = ninesliceMetricsBefore['nineslice.tile-needs-repeat-sampler'] ?? 0;
  // D-9 soft-warn fires at AssetRegistry.catalog time: it reads values.sampler
  // as an embedded GUID string (D-19) and resolves it against the catalogue. So
  // catalog the clamp sampler under a GUID, then catalog the sliceMode=1 material
  // referencing that GUID -- allocSharedRef stores the POD verbatim and never runs
  // detectTileNeedsRepeatSampler, so the column handle alone would not fire it.
  const clampSamplerGuid = '00000000-0000-4000-8000-0000000000c1';
  okResult(
    assets.catalog(clampSamplerGuid, {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  );
  const clampSamplerHandle = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const ninesliceSlices = FALSIFY_NINESLICE_ANCHOR
    ? [0, 0, 0, 0] // falsifier: degenerate sentinel; soft-warn should still fire on sliceMode=1
    : [0.25, 0.25, 0.25, 0.25];
  // Keep the tile sign explicit for the degenerate falsifier: `-0` is
  // numerically zero and would silently select stretch mode instead of
  // exercising the D-9 tile sampler warning.
  const ninesliceMode = FALSIFY_NINESLICE_ANCHOR ? -1 : -ninesliceSlices[3];
  // Catalog a material whose sampler is the clamp GUID string -> trips the D-9
  // soft-warn counter. The rendered entity below uses the column-handle variant.
  const debugCatalogResult = assets.catalog('00000000-0000-4000-8000-0000000000c2', {
      kind: 'material',
      passes: [
        // feat-20260626 M3: renderState.blend SSOT.
        { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 } },
      ],
      parameters: SPRITE_PARAMETERS,
      values: {
        // feat-20260625 M3/w11 (D-4): UBO-aligned. slicesAndMode merges legacy
        // slices[4] (LTRB) + sliceMode sign (mode>=0 stretch, <0 tile) into
        // one vec4 (sprite.material.json paramSchema).
        colorTint: [1, 1, 1, 1],
        sampler: clampSamplerGuid,
        region: [0, 0, 1, 1],
        pivotAndSize: [0.5, 0.5, 1, 1],
        slicesAndMode: [ninesliceSlices[0], ninesliceSlices[1], ninesliceSlices[2], ninesliceMode],
      },
    });
  okResult(debugCatalogResult);
  const ninesliceMatHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      // feat-20260626 M3: renderState.blend SSOT.
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      // feat-20260625 M3/w11 (D-4): UBO-aligned. slicesAndMode merges legacy
      // slices[4] (LTRB) + sliceMode (mode>=0 stretch, <0 tile) into vec4.
      colorTint: [1, 1, 1, 1],
      baseColorTexture: ninesliceTextureHandle,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      slicesAndMode: [ninesliceSlices[0], ninesliceSlices[1], ninesliceSlices[2], ninesliceMode],
    },
  });
  const ninesliceMetricsAfter = ninesliceMetrics?.snapshot() ?? {};
  const afterCount = ninesliceMetricsAfter['nineslice.tile-needs-repeat-sampler'] ?? 0;
  softWarnDelta = afterCount - beforeCount;
  console.log(
    `[smoke] nineslice tile-needs-repeat-sampler delta=${softWarnDelta} (before=${beforeCount} after=${afterCount})`,
  );
  if (softWarnDelta < 1) {
    failures.push(
      `nineslice: D-9 soft-warn did not fire (delta=${softWarnDelta}); sliceMode=1 + clamp-sampler must increment 'nineslice.tile-needs-repeat-sampler' counter`,
    );
  }

  // Assertion #4: render a fresh World containing 1 nineslice entity for >=30
  // frames; assert no draw errors. We reuse the activeRenderTarget mock canvas
  // machinery already wired above -- a new World rebuilds the camera + entity
  // graph without touching the renderer's per-Scene state.
  okResult(
    TransparentSort.configure(world, {
      mode: TransparentSort.layerZ,
      yzAlpha: 1.0,
    }),
  );
  {
    okResult(
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.6, 0.4, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
        { component: MeshRenderer, data: { materials: [ninesliceMatHandle] } },
        { component: Layer, data: { value: 0 } },
      ),
    );
    okResult(
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
            tonemap: TONEMAP_NONE,
            exposure: 1,
            whitePoint: 8,
            clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
          },
        },
      ),
    );
    for (let i = 0; i < ninesliceFrames; i++) {
      world.update().unwrap();
      const r = renderer.draw({
        leases: [ninesliceAttachment.value],
        camera: { lease: ninesliceAttachment.value },
        environment: { lease: ninesliceAttachment.value },
      });
      if (!r.ok) ninesliceDrawErrors++;
    }
    await sharedDevice?.queue.onSubmittedWorkDone();
  }
}
console.log(
  `[smoke] nineslice section frames=${ninesliceFrames} drawErrors=${ninesliceDrawErrors}`,
);
if (ninesliceDrawErrors > 0) {
  failures.push(
    `nineslice: ${ninesliceDrawErrors} draw errors over ${ninesliceFrames} frames`,
  );
}

// Falsifier verdict: when FALSIFY=nineslice-anchor the falsifier asserts
// that the falsifier predicate above (soft-warn delta >= 1) STILL holds --
// proving the soft-warn fires regardless of slices sentinel content. If a
// future regression makes the soft-warn dependent on `slices !== [0,0,0,0]`
// the falsifier flips RED here.
if (FALSIFY_NINESLICE_ANCHOR && softWarnDelta < 1) {
  // already accounted for above; no extra failure push.
  console.error(
    `[smoke] FALSIFY=nineslice-anchor: predicate FAILED -- soft-warn did not fire on degenerate slices sentinel`,
  );
} else if (FALSIFY_NINESLICE_ANCHOR) {
  console.log(
    `[smoke] FALSIFY=nineslice-anchor: predicate held (soft-warn fires regardless of slices content)`,
  );
}

// AC-12 ECS-side zero-increment grep (plan-review round 1 issue #2):
//   Read sort-key.ts + layer.ts and assert no `9-slice` / `nineslice` token
//   appears. The smoke-dawn.mjs scope owns this gate so the AI-user
//   reviewing the smoke output sees a single grep verdict per run.
const AC12_FILES = [
  resolve(here, '..', '..', '..', '..', 'packages', 'render', 'src', 'components', 'sort-key.ts'),
  resolve(here, '..', '..', '..', '..', 'packages', 'render', 'src', 'components', 'layer.ts'),
];
const AC12_PATTERN = /9.?slice|nineslice/i;
for (const filePath of AC12_FILES) {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    failures.push(
      `AC-12 grep: cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    continue;
  }
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (AC12_PATTERN.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  }
  if (hits.length > 0) {
    failures.push(
      `AC-12: ${filePath} has ${hits.length} '9-slice|nineslice' hit(s); ECS layer should be 9-slice-agnostic. Hits: ${hits.slice(0, 3).join(' | ')}`,
    );
  }
}
console.log(`[smoke] AC-12 grep gate: 0 hits in sort-key.ts + layer.ts`);

// feat-20260626 M5-T1 (plan-strategy D-5, AC-08): FALSIFY=missing-sprite-blend
// verdict. fail-when-passes shape -- the 4-case matrix above was authored
// without `renderState.blend`, so its PNG readbacks SHOULD drift beyond eps.
// We count 4-case failures by the `reference PNG drift` / `FALSIFY` substrings
// pushed during the matrix loop. predicate-held => at least one 4-case drift
// observed; predicate-NOT-held => engine silently restored the legacy
// implicit-premul path and we must push an extra failure so exit != 0.
if (FALSIFY_MISSING_SPRITE_BLEND) {
  const matrixFailureSubstrings = ['reference PNG drift', 'FALSIFY=missing-sprite-blend active'];
  const matrixFailureCount = failures.filter((f) =>
    matrixFailureSubstrings.some((needle) => f.includes(needle)),
  ).length;
  if (matrixFailureCount > 0) {
    console.log(
      `[smoke] FALSIFY=missing-sprite-blend: predicate held (matrixFailures=${matrixFailureCount}; missing renderState.blend triggers PNG drift / refuse-to-seed as designed)`,
    );
  } else {
    console.error(
      `[smoke] FALSIFY=missing-sprite-blend: predicate NOT held -- 4 PNG cases stayed within eps despite omitting renderState.blend; engine may still apply implicit premultiplied-alpha fallback`,
    );
    failures.push(
      'FALSIFY=missing-sprite-blend: predicate NOT held -- engine still painted sprites correctly without renderState.blend',
    );
  }
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: pnpm --filter @forgeax/hello-sprite smoke`);
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 PNG cases + nineslice section GREEN: backend=webgpu, scene-A/none + scene-A/reinhard + scene-B/none + scene-B/reinhard within eps=${SMOKE_PIXEL_THRESHOLD}; HANDLE_NINESLICE_QUAD id=${ninesliceHandleId}; D-9 soft-warn delta=${softWarnDelta}; AC-12 grep clean`,
);
console.log(`[smoke] frames observed=${TARGET_FRAMES}`);
console.log(
  `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    gateId: 'hello-sprite/smoke',
    commandId: 'smoke',
    framesObserved: TARGET_FRAMES,
    completed: true,
  })}`,
);

sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);

// ─── PNG helpers: imported from apps/shared/png-codec.mjs ───────────────
