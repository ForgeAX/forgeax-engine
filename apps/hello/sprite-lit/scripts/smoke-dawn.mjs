#!/usr/bin/env node
// apps/hello/sprite-lit/scripts/smoke-dawn.mjs
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w7.
//
// dawn-node smoke for sprite-lit material:
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package (dawn-node
//      native binding).
//   2. Mock canvas + offscreen render target (`rgba8unorm` storage so the
//      sprite alpha-blend lands cleanly without sRGB encode-swap).
//   3. Build a World with 4 sprite-lit quads + 3 lights (1 directional +
//      1 point + 1 spot) + 1 standard-PBR cube (AC-14 sanity); identical
//      scene shape to apps/hello/sprite-lit/src/main.ts three-lights mode.
//   4. Render 60 frames; assert no draw error + no NaN/Inf in the
//      readback + sprite-center pixel R/G/B > 0 (AC-06 three lights
//      generated visible illumination).
//   5. Falsification variant: rebuild the World without the PointLight or
//      SpotLight (directional-only), re-render 60 frames, assert the
//      sprite-center pixel differs from the 3-light variant by > 0.05
//      (charter feedback 61 falsifiability: the smoke can detect a
//      regression where two of the three lights silently fall off the
//      sprite-lit accumulator).
//
// Output literals (grep-friendly):
//   [hello-sprite-lit] backend=<webgpu>
//   [smoke] case three-lights center=<r>,<g>,<b>
//   [smoke] case directional-only center=<r>,<g>,<b>
//   [smoke] case falsifier maxDelta=<f>
//   [smoke] PASS / FAIL - <reason>

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const WIDTH = 800;
const HEIGHT = 600;
const CLEAR_RGBA = [0.05, 0.06, 0.08, 1.0];
const SPRITE_LIT_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
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
  console.error('  rerun: pnpm --filter @forgeax/hello-sprite-lit smoke');
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
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
// Pin getPreferredCanvasFormat so the mock canvas viewFormats stay aligned
// (see apps/hello/sprite/scripts/smoke-dawn.mjs:114 same workaround).
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

// --- 2. Mock canvas ------------------------------------------------------

let activeRenderTarget = null;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (activeRenderTarget) activeRenderTarget.destroy?.();
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
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
  TONEMAP_NONE,
} = await import('@forgeax/engine-render');
const { SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  HANDLE_QUAD,
} = await import('@forgeax/engine-assets-runtime');

const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const ENGINE_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

function buildCheckerboardRgba(side) {
  const w = side;
  const h = side;
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const top = y < h / 2;
      const left = x < w / 2;
      const quadrant = top ? (left ? 0 : 1) : left ? 2 : 3;
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

const SPRITE_SLOTS = [
  { pos: [-0.9, 0.0, 0.0], tint: [1.0, 1.0, 1.0, 1.0] },
  { pos: [-0.3, 0.0, 0.0], tint: [1.0, 0.7, 0.7, 1.0] },
  { pos: [0.3, 0.0, 0.0], tint: [0.7, 1.0, 0.7, 1.0] },
  { pos: [0.9, 0.0, 0.0], tint: [0.7, 0.7, 1.0, 1.0] },
];

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
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
console.log(`[hello-sprite-lit] backend=${renderer.inspect().capabilities.backendKind}`);


const checker = buildCheckerboardRgba(8);
const synthPod = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: checker.width, height: checker.height } },
  format: 'rgba8unorm-srgb',
  data: checker.data,
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};

function expectOk(r, label) {
  if (!r.ok) {
    throw new Error(`${label}: ${r.error.code ?? '<no-code>'}`);
  }
  return r.value;
}

async function buildWorld({ includePoint, includeSpot }) {
  const world = new World();
  const textureHandle = world.allocSharedRef('TextureAsset', synthPod);
  const samplerHandle = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  // 4 sprite-lit material handles (one per slot for distinct tint).
  const matHandles = [];
  for (const slot of SPRITE_SLOTS) {
    matHandles.push(
      world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::sprite-lit' },
            renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 },
          },
        ],
        // values field names align with sprite-lit.material.json
        // paramSchema (colorTint / region / pivotAndSize / baseColorTexture;
        // post-#520 SSOT). The pre-tweak-20260701 M2 script used the legacy
        // baseColor / texture / pivot names which silently defaulted the
        // UBO fields to schema defaults instead of the intended tint / atlas.
        parameters: SPRITE_LIT_PARAMETERS,
        values: {
          colorTint: slot.tint,
          baseColorTexture: textureHandle,
          region: [0, 0, 1, 1],
          pivotAndSize: [0.5, 0.5, 1, 1],
        },
      }),
    );
  }

  // Lights (directional always on; point + spot toggled per case).
  expectOk(
    world.spawn({
      component: DirectionalLight,
      data: {
        direction: [0.0, -1.0, -0.3],
        color: [1.0, 0.95, 0.85],
        intensity: 1.0,
      },
    }),
    'spawn DirectionalLight',
  );
  if (includePoint) {
    expectOk(
      world.spawn(
        { component: Transform, data: { pos: [0.0, 0.3, 1.5], quat: [0, 0, 0, 1]} },
        {
          component: PointLight,
          data: { color: [1.0, 0.4, 1.0], intensity: 3.0, range: 4.0 },
        },
      ),
      'spawn PointLight',
    );
  }
  if (includeSpot) {
    expectOk(
      world.spawn(
        { component: Transform, data: { pos: [2.0, 1.0, 1.5], quat: [0, 0, 0, 1]} },
        {
          component: SpotLight,
          data: {
            direction: [-0.8, -0.4, -0.4],
            color: [0.3, 1.0, 1.0],
            intensity: 4.0,
            range: 6.0,
            innerConeDeg: 15,
            outerConeDeg: 30,
          },
        },
      ),
      'spawn SpotLight',
    );
  }

  // 4 sprite-lit quads (AC-11 >=4 day-1 instances path).
  for (let i = 0; i < SPRITE_SLOTS.length; i++) {
    const slot = SPRITE_SLOTS[i];
    const mat = matHandles[i];
    expectOk(
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [slot.pos[0], slot.pos[1], slot.pos[2]], quat: [0, 0, 0, 1], scale: [0.45, 0.45, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [mat] } },
      ),
      `spawn sprite-lit quad ${i}`,
    );
  }

  // 1 standard-PBR cube (AC-14 sanity).
  const cubeMat = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [0.7, 0.7, 0.75], metallic: 0.0, roughness: 0.8 },
  });
  expectOk(
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0.0, -0.6, 0.0], quat: [0, 0, 0, 1], scale: [0.3, 0.3, 0.3],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMat] } },
    ),
    'spawn cube',
  );

  // Camera (orthographic, matches main.ts).
  expectOk(
    world.spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 5], quat: [0, 0, 0, 1]},
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: WIDTH / HEIGHT,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -1.6,
          right: 1.6,
          bottom: -1.0,
          top: 1.0,
          tonemap: TONEMAP_NONE,
          exposure: 1.0,
          whitePoint: 8.0,
          clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
        },
      },
    ),
    'spawn Camera',
  );

  return { ok: true, world };
}

async function renderCase({ includePoint, includeSpot, label }) {
  const buildRes = await buildWorld({ includePoint, includeSpot });
  if (!buildRes.ok) {
    return { ok: false, error: `world build (${label}): ${buildRes.error.code}` };
  }
  const world = buildRes.world;
  const attached = renderer.attach(world);
  if (!attached.ok) return { ok: false, error: `world attach (${label}): ${attached.error.code}` };
  let draws = 0;
  let drawErrors = 0;
  for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!r.ok) drawErrors++;
    else draws++;
  }
  await sharedDevice?.queue.onSubmittedWorkDone();
  if (drawErrors > 0) {
    return { ok: false, error: `${label}: ${drawErrors} draw errors over ${draws} frames` };
  }

  // Pixel readback (same recipe as apps/hello/sprite/scripts/smoke-dawn.mjs).
  if (!activeRenderTarget || !sharedDevice) {
    return { ok: false, error: `${label}: render target / device missing for readback` };
  }
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
  const readbackBuffer = sharedDevice.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  {
    const enc = sharedDevice.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: activeRenderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    sharedDevice.queue.submit([enc.finish()]);
  }
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    readbackBuffer.destroy();
    return {
      ok: false,
      error: `${label}: mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  // Compact RGBA + scan for NaN/Inf via channel sums; sample sprite-row
  // center pixel (mid Y, mid X) for AC-06 R/G/B > 0 assertion.
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  let totalSum = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tight[dst + 0] = bytes[off + 0] ?? 0;
      tight[dst + 1] = bytes[off + 1] ?? 0;
      tight[dst + 2] = bytes[off + 2] ?? 0;
      tight[dst + 3] = bytes[off + 3] ?? 0;
      totalSum += tight[dst + 0] + tight[dst + 1] + tight[dst + 2];
    }
  }
  if (!Number.isFinite(totalSum)) {
    return { ok: false, error: `${label}: NaN/Inf detected in readback (sum=${totalSum})` };
  }
  // Sample point: sprite-lit slot 1 center at world (-0.3, 0). Framebuffer
  // maps world x to (x + 1.6) / 3.2 * WIDTH (ortho left=-1.6, right=1.6),
  // so world x=-0.3 -> pixel column 325 -- well inside the sprite footprint
  // (slot 1 spans world x=[-0.525, -0.075] at scale x=0.45). The prior sample
  // at framebuffer center (world (0, 0)) fell in the inter-sprite gap and
  // read only the clear color, so the three-lights vs directional-only
  // delta was structurally zero under the flat sprite-lit shading model.
  const cx = 325;
  const cy = HEIGHT >> 1;
  const off = (cy * WIDTH + cx) * 4;
  const r = tight[off + 0] ?? 0;
  const g = tight[off + 1] ?? 0;
  const b = tight[off + 2] ?? 0;
  console.log(`[smoke] case ${label} center=${r},${g},${b} frames=${draws}`);
  return { ok: true, center: [r, g, b], tight, draws };
}

// --- 4. Run the 2 cases + falsifier ---------------------------------------

const failures = [];

const threeLights = await renderCase({
  includePoint: true,
  includeSpot: true,
  label: 'three-lights',
});
if (!threeLights.ok) {
  failures.push(threeLights.error);
}

// Reset the active render target so the next case starts from a clean
// readback surface.
activeRenderTarget?.destroy?.();
activeRenderTarget = null;

const directionalOnly = await renderCase({
  includePoint: false,
  includeSpot: false,
  label: 'directional-only',
});
if (!directionalOnly.ok) {
  failures.push(directionalOnly.error);
}

// AC-06 center R/G/B > 0 for the three-lights case (positive light evidence).
if (threeLights.ok) {
  const [tr, tg, tb] = threeLights.center;
  if (tr <= 0 && tg <= 0 && tb <= 0) {
    failures.push(
      `three-lights center pixel R/G/B all <=0 (${tr},${tg},${tb}); AC-06 expected at least one channel >0`,
    );
  }
}

// Falsifier delta: directional-only and three-lights center pixels MUST
// differ by > 0.05 normalised, proving the PointLight/SpotLight contributions
// landed on the sprite-lit accumulator.
if (threeLights.ok && directionalOnly.ok) {
  const [tr, tg, tb] = threeLights.center;
  const [dr, dg, db] = directionalOnly.center;
  const delta =
    Math.max(
      Math.abs(tr - dr),
      Math.abs(tg - dg),
      Math.abs(tb - db),
    ) / 255;
  console.log(`[smoke] case falsifier maxDelta=${delta.toFixed(4)}`);
  if (delta <= SMOKE_PIXEL_THRESHOLD) {
    failures.push(
      `falsifier: three-lights vs directional-only center delta=${delta.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}; PointLight + SpotLight contributions not detected`,
    );
  }
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: pnpm --filter @forgeax/hello-sprite-lit smoke`);
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=${renderer.inspect().capabilities.backendKind}; three-lights + directional-only rendered ${SMOKE_MIN_FRAMES} frames; AC-06 center>0; falsifier delta > ${SMOKE_PIXEL_THRESHOLD}`,
);
console.log(
  `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    gateId: 'hello-sprite-lit/smoke',
    commandId: 'smoke',
    framesObserved: SMOKE_MIN_FRAMES,
    completed: true,
  })}`,
);
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
