#!/usr/bin/env node
// apps/hello/2d-flashlight/scripts/smoke-dawn.mjs
//
// tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d M2 / m2-1.
//
// dawn-node smoke for the flat sprite-lit shading model. Two scenes match
// the requirements' AC-1 and AC-2 assertion coordinates one to one:
//
//   1. sweep-spot (AC-1). SpotLight at world origin, dirX=1, pos z=0. Sprite
//      plane covers x=[1, 3], y=[-1, 1]. The wedge center at world (2, 0)
//      lands inside the smoothstep cone at near-max range attenuation, so
//      the framebuffer-center pixel brightness (max channel / 255) must
//      be > 0.5.
//   2. point-circle (AC-2). PointLight at (0, 0, 0.01) with range=1 makes
//      a soft circle. Center world (0, 0) saturates via the KHR guard
//      dSq=max(0, 1e-4) so its readback brightness must be > 0.7; edge
//      world (1, 0) sits outside the quartic window (factor clamped to 0)
//      so its brightness must be < 0.1.
//
// Falsifiers: rebuild each local-light scene with intensity=0 and assert the
// sampled contribution drops below its positive-light threshold. This proves
// the smoke can detect a regression where a punctual contribution silently
// falls off the sprite-lit accumulator (charter feedback 61).
//
// Output literals (grep-friendly):
//   [hello-2d-flashlight] backend=<webgpu>
//   [smoke] case sweep-spot center=<r>,<g>,<b>
//   [smoke] case point-circle center=<r>,<g>,<b> edge=<r>,<g>,<b>
//   [smoke] case falsifier sweep-spot-zero center=<r>,<g>,<b>
//   [smoke] case falsifier point-circle-zero center=<r>,<g>,<b>
//   [smoke] PASS / FAIL - <reason>

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 800;
const HEIGHT = 600;
// AC-1 / AC-2 assertion thresholds (max-channel-brightness / 255).
const AC1_WEDGE_MIN = Number.parseFloat(process.env.SMOKE_AC1_MIN ?? '0.5');
const AC2_CENTER_MIN = Number.parseFloat(process.env.SMOKE_AC2_CENTER_MIN ?? '0.7');
const AC2_EDGE_MAX = Number.parseFloat(process.env.SMOKE_AC2_EDGE_MAX ?? '0.1');
const CLEAR_RGBA = [0.01, 0.01, 0.02, 1.0];
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
  console.error('  rerun: pnpm --filter @forgeax/hello-2d-flashlight smoke');
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
// (see apps/hello/sprite-lit/scripts/smoke-dawn.mjs same workaround).
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
const { Camera, MeshFilter, MeshRenderer, PointLight, SpotLight, TONEMAP_NONE } = await import('@forgeax/engine-render');
const { SPRITE_PREMULTIPLIED_ALPHA_BLEND } = await import('@forgeax/engine-render/authoring');
const { Transform } = await import('@forgeax/engine-scene');
const {
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
      // Mid-luminance quadrants -- keeps the sprite pixel brightness
      // well below saturation with 0-light so the smoke can distinguish
      // "light contribution present" from "texture alone".
      const palette = [
        [220, 180, 140, 255],
        [200, 200, 200, 255],
        [180, 200, 220, 255],
        [220, 200, 180, 255],
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
console.log(`[hello-2d-flashlight] backend=${renderer.inspect().capabilities.backendKind}`);


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

function spawnSprite(world, matHandle, x, y, z, sx, sy) {
  expectOk(
    world.spawn(
      {
        component: Transform,
        data: { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [sx, sy, 1] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    ),
    `spawn sprite (${x}, ${y}, ${z})`,
  );
}

function allocMaterial(world, tint, texHandle, samplerHandle) {
  return world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite-lit' },
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 },
      },
    ],
    parameters: SPRITE_LIT_PARAMETERS,
    // values field names align with sprite-lit.material.json paramSchema
    // (colorTint / region / pivotAndSize / baseColorTexture; post-#520 SSOT).
    values: {
      colorTint: tint,
      baseColorTexture: texHandle,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  });
}

function orthoCameraData({ left, right, bottom, top }) {
  return {
    fov: Math.PI / 4,
    aspect: WIDTH / HEIGHT,
    near: 0.1,
    far: 100,
    projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
    left,
    right,
    bottom,
    top,
    tonemap: TONEMAP_NONE,
    exposure: 1.0,
    whitePoint: 8.0,
    clearColor: [CLEAR_RGBA[0], CLEAR_RGBA[1], CLEAR_RGBA[2], CLEAR_RGBA[3]],
  };
}

async function buildTexture(world) {
  const textureHandle = world.allocSharedRef('TextureAsset', synthPod);
  const samplerHandle = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  return { ok: true, textureHandle, samplerHandle };
}

// Scene builders mirror the corresponding branches in
// apps/hello/2d-flashlight/src/main.ts so the smoke exercises the same
// draw calls the browser would issue.

async function buildSweepSpotWorld({ intensity }) {
  const world = new World();
  const texRes = await buildTexture(world);
  if (!texRes.ok) return { ok: false, error: texRes.error };
  const { textureHandle, samplerHandle } = texRes;

  expectOk(
    world.spawn(
      { component: Transform, data: { pos: [1.9, 0, 5], quat: [0, 0, 0, 1]} },
      { component: Camera, data: orthoCameraData({ left: -1.5, right: 1.5, bottom: -1.5, top: 1.5 }) },
    ),
    'spawn Camera (sweep-spot)',
  );

  expectOk(
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1]} },
      {
        component: SpotLight,
        data: {
          direction: [1.0, 0.0, 0.0],
          color: [1.0, 1.0, 1.0],
          intensity,
          range: 6.0,
          innerConeDeg: 15,
          outerConeDeg: 30,
          // Match the product scene: the flashlight illuminates the sprite
          // but does not cast a self-shadow onto its own planar receiver.
          castShadow: false,
        },
      },
    ),
    'spawn SpotLight (sweep-spot)',
  );

  const mat = allocMaterial(world, [1, 1, 1, 1], textureHandle, samplerHandle);
  spawnSprite(world, mat, 2, 0, 0, 2, 2);
  return { ok: true, world };
}

async function buildPointCircleWorld({ intensity = 2.0 } = {}) {
  const world = new World();
  const texRes = await buildTexture(world);
  if (!texRes.ok) return { ok: false, error: texRes.error };
  const { textureHandle, samplerHandle } = texRes;

  expectOk(
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1]} },
      { component: Camera, data: orthoCameraData({ left: -1.5, right: 1.5, bottom: -1.5, top: 1.5 }) },
    ),
    'spawn Camera (point-circle)',
  );

  expectOk(
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 0.01], quat: [0, 0, 0, 1]} },
      {
        component: PointLight,
        data: {
          color: [1.0, 1.0, 1.0],
          intensity,
          range: 1.0,
        },
      },
    ),
    'spawn PointLight (point-circle)',
  );

  const mat = allocMaterial(world, [1, 1, 1, 1], textureHandle, samplerHandle);
  spawnSprite(world, mat, 0, 0, 0, 2.4, 2.4);
  return { ok: true, world };
}

// Camera framing: sweep-spot uses left/right=[-1.5, 1.5] centred on pos x=1.9
// so pixel column 400 (WIDTH/2) maps to world x=1.9. Sprite center world
// x=2.0 maps to pixel column 427 -- we sample there for the AC-1 assertion.
// point-circle centres on world (0, 0) so framebuffer center is the AC-2
// center; edge world (1, 0) maps to pixel column (1/1.5+1)/2*800=667.

const PIXEL_SWEEP_CENTER = { x: Math.round(((2.0 - 1.9) / 1.5 + 1) / 2 * WIDTH), y: HEIGHT >> 1 };
const PIXEL_POINT_CENTER = { x: WIDTH >> 1, y: HEIGHT >> 1 };
const PIXEL_POINT_EDGE = { x: Math.round((1.0 / 1.5 + 1) / 2 * WIDTH), y: HEIGHT >> 1 };

async function renderAndReadback(world, label) {
  const attached = renderer.attach(world);
  if (!attached.ok) return { ok: false, error: `${label}: attach failed: ${attached.error.code}` };
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
    draws++;
  }
  await sharedDevice?.queue.onSubmittedWorkDone();
  if (drawErrors > 0) {
    return { ok: false, error: `${label}: ${drawErrors} draw errors over ${draws} frames` };
  }
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

  function samplePixel({ x, y }) {
    const off = y * bytesPerRow + x * bytesPerPixel;
    return [bytes[off + 0] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0];
  }
  // Scan for NaN/Inf via channel sums.
  let totalSum = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      totalSum += (bytes[off + 0] ?? 0) + (bytes[off + 1] ?? 0) + (bytes[off + 2] ?? 0);
    }
  }
  if (!Number.isFinite(totalSum)) {
    return { ok: false, error: `${label}: NaN/Inf detected in readback (sum=${totalSum})` };
  }
  return { ok: true, samplePixel, draws };
}

async function runSceneCase(label, buildFn, samplePoints) {
  const buildRes = await buildFn();
  if (!buildRes.ok) return { ok: false, error: `world build (${label}): ${buildRes.error.code}` };
  const rbRes = await renderAndReadback(buildRes.world, label);
  activeRenderTarget?.destroy?.();
  activeRenderTarget = null;
  if (!rbRes.ok) return rbRes;
  const samples = {};
  for (const [name, pt] of Object.entries(samplePoints)) {
    samples[name] = rbRes.samplePixel(pt);
  }
  return { ok: true, samples, draws: rbRes.draws };
}

function brightness(rgb) {
  return Math.max(rgb[0], rgb[1], rgb[2]) / 255;
}

// --- 4. Run the AC-1 / AC-2 cases + falsifier ---------------------------------

const failures = [];

const sweepRes = await runSceneCase(
  'sweep-spot',
  () => buildSweepSpotWorld({ intensity: 5.0 }),
  { center: PIXEL_SWEEP_CENTER },
);
if (!sweepRes.ok) {
  failures.push(sweepRes.error);
} else {
  const c = sweepRes.samples.center;
  console.log(`[smoke] case sweep-spot center=${c[0]},${c[1]},${c[2]}`);
  const b = brightness(c);
  if (b <= AC1_WEDGE_MIN) {
    failures.push(
      `AC-1 wedge-center brightness ${b.toFixed(3)} <= ${AC1_WEDGE_MIN} (rgb=${c[0]},${c[1]},${c[2]})`,
    );
  }
}

const pointRes = await runSceneCase(
  'point-circle',
  () => buildPointCircleWorld(),
  { center: PIXEL_POINT_CENTER, edge: PIXEL_POINT_EDGE },
);
if (!pointRes.ok) {
  failures.push(pointRes.error);
} else {
  const c = pointRes.samples.center;
  const e = pointRes.samples.edge;
  console.log(
    `[smoke] case point-circle center=${c[0]},${c[1]},${c[2]} edge=${e[0]},${e[1]},${e[2]}`,
  );
  const bc = brightness(c);
  const be = brightness(e);
  if (bc <= AC2_CENTER_MIN) {
    failures.push(
      `AC-2 point-center brightness ${bc.toFixed(3)} <= ${AC2_CENTER_MIN} (rgb=${c[0]},${c[1]},${c[2]})`,
    );
  }
  if (be >= AC2_EDGE_MAX) {
    failures.push(
      `AC-2 point-edge brightness ${be.toFixed(3)} >= ${AC2_EDGE_MAX} (rgb=${e[0]},${e[1]},${e[2]})`,
    );
  }
}

const pointFalsifierRes = await runSceneCase(
  'falsifier-point',
  () => buildPointCircleWorld({ intensity: 0.0 }),
  { center: PIXEL_POINT_CENTER },
);
if (!pointFalsifierRes.ok) {
  failures.push(pointFalsifierRes.error);
} else {
  const c = pointFalsifierRes.samples.center;
  console.log(`[smoke] case falsifier point-circle-zero center=${c[0]},${c[1]},${c[2]}`);
  const b = brightness(c);
  if (b >= AC2_EDGE_MAX) {
    failures.push(
      `falsifier: point-circle-zero brightness ${b.toFixed(3)} >= ${AC2_EDGE_MAX}; PointLight contribution not gating the circle`,
    );
  }
}

// Falsifier: same sweep-spot scene but SpotLight intensity=0 -- the wedge
// center must drop below the AC-1 threshold, proving the smoke's positive
// assertion is not blind to a zero-light regression.
const falsifierRes = await runSceneCase(
  'falsifier',
  () => buildSweepSpotWorld({ intensity: 0.0 }),
  { center: PIXEL_SWEEP_CENTER },
);
if (!falsifierRes.ok) {
  failures.push(falsifierRes.error);
} else {
  const c = falsifierRes.samples.center;
  console.log(`[smoke] case falsifier sweep-spot-zero center=${c[0]},${c[1]},${c[2]}`);
  const b = brightness(c);
  if (b > AC1_WEDGE_MIN) {
    failures.push(
      `falsifier: sweep-spot-zero brightness ${b.toFixed(3)} > ${AC1_WEDGE_MIN}; SpotLight contribution not gating the wedge`,
    );
  }
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`  rerun: pnpm --filter @forgeax/hello-2d-flashlight smoke`);
  sharedDevice?.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=${renderer.inspect().capabilities.backendKind}; sweep-spot + point-circle rendered ${SMOKE_MIN_FRAMES} frames; AC-1 wedge > ${AC1_WEDGE_MIN}; AC-2 center > ${AC2_CENTER_MIN} / edge < ${AC2_EDGE_MAX}; falsifiers gate zero-intensity spot + point`,
);
emitSmokeReceipt(
  'hello-2d-flashlight/smoke',
  Math.min(sweepRes.draws, pointRes.draws, pointFalsifierRes.draws, falsifierRes.draws),
);
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
