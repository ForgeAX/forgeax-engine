#!/usr/bin/env node
// apps/learn-render/2.lighting/5.light-casters/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 2.5 light-casters dawn-node smoke
// (feat-20260625-spot-light-shadow-mapping w17 / M4).
//
// This demo is the spot-shadow VISUAL milestone (AC-01: a spot light casts a
// directionally-correct shadow; AC-06: no acne). The scene mirrors src/index.ts:
//   - a 30x30 floor plane at y=-2 (Materials.standard, receives shadow)
//   - one obstructing cube at [0,-0.6,-3] (Materials.standard, casts shadow)
//   - a FIXED downward SpotLight at [0,4,-3] pointing -Y with castShadow=true
//   - the LO 2.5 10-cube grid + DirectionalLight + 4 PointLights (regression)
// A top-down camera frames the floor so the cube's shadow is on-screen.
//
// THE LOAD-BEARING ASSERTION: this is a SHADOW demo, so a pixel sampled on the
// floor DIRECTLY UNDER the obstructing cube (in the spot's shadow) MUST be
// measurably DARKER than a pixel on the floor OUTSIDE the cube's shadow but
// still inside the spot cone. shadowDelta = lit - shadow must exceed
// SMOKE_PIXEL_THRESHOLD (0.05).
//
// FALSIFY modes (NOT run in CI; prove the shadow assertion is discriminating --
// see plan-strategy 5.4):
//   - FALSIFY=no-shadow : fixed spot castShadow=false -> no shadow pass, floor
//     under the cube is no longer darkened -> shadowDelta collapses -> FAIL.
//   - FALSIFY=no-occluder : remove the obstructing cube -> nothing to cast a
//     shadow, both sample sites are lit equally -> shadowDelta collapses -> FAIL.
// Shader-internal falsifications (force evalSpotShadowed=1.0; invert the
// shadowAtlasTile>=0 gate) are exercised by hand-patching the shader during
// manual verification; they are documented in the implement report, not env-driven
// here (the shader is engine source, not demo source).
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-light-casters] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const COMBINED_LIGHT_MIN_DELTA = Number.parseFloat(process.env.COMBINED_LIGHT_MIN_DELTA ?? '0.25');
const SMOKE_WRITE_BASELINE = process.env.SMOKE_WRITE_BASELINE === '1';
const FALSIFY = process.env.FALSIFY ?? '';
const FALSIFY_NO_COMBINED_LIGHTS = FALSIFY === 'no-directional-point-lights';

const WIDTH = 400;
const HEIGHT = 300;

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const BASELINE_DIR = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'smoke-baselines',
  'learn-render-2-5-light-casters',
);
const BASELINE_PNG_PATH = resolve(BASELINE_DIR, 'spot-shadow.ref.png');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

// --- Minimal PNG encoder (no dependencies; mirrors hello-debug-draw smoke) ---

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

function writeU32(arr, off, val) {
  arr[off] = (val >>> 24) & 0xff;
  arr[off + 1] = (val >>> 16) & 0xff;
  arr[off + 2] = (val >>> 8) & 0xff;
  arr[off + 3] = val & 0xff;
}

function writePng(width, height, rgba) {
  const rawData = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    rawData[rowOff] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowOff + 1 + x * 4;
      rawData[dst] = rgba[src];
      rawData[dst + 1] = rgba[src + 1];
      rawData[dst + 2] = rgba[src + 2];
      rawData[dst + 3] = rgba[src + 3];
    }
  }
  const compressed = deflateSync(rawData);

  const ihdrData = new Uint8Array(13);
  writeU32(ihdrData, 0, width);
  writeU32(ihdrData, 4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const chunks = [];
  function addChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    typeBytes[0] = type.charCodeAt(0);
    typeBytes[1] = type.charCodeAt(1);
    typeBytes[2] = type.charCodeAt(2);
    typeBytes[3] = type.charCodeAt(3);
    const typeAndData = Buffer.concat([typeBytes, data]);
    const c = crc32(typeAndData);
    const len = data.length;
    const buf = new Uint8Array(12 + len);
    writeU32(buf, 0, len);
    buf.set(typeBytes, 4);
    buf.set(data, 8);
    writeU32(buf, 8 + len, c);
    chunks.push(buf);
  }

  addChunk('IHDR', ihdrData);
  addChunk('IDAT', compressed);
  addChunk('IEND', new Uint8Array(0));

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const totalLen = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const out = Buffer.alloc(totalLen);
  sig.forEach((b, i) => {
    out[i] = b;
  });
  let off = 8;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
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

// --- 2. Mock canvas (COPY_SRC so we can read back) --------------------------

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

// --- 3. Drive engine ECS path -----------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { createPlaneGeometry } = await import('@forgeax/engine-geometry');
const { Materials } = await import('@forgeax/engine-render');
const {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SpotLight,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: MANIFEST_URL },
  );
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

const initialInspection = renderer.inspect();
console.log(
  `[learn-render-light-casters] renderPath=${initialInspection.profile.renderPath} ` +
    `backend=${initialInspection.capabilities.backendKind} passes=${initialInspection.perFramePassNames.length}`,
);
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// LO 2.5 cube grid + lights (regression: AC-07 the original scene survives).
const CUBE_POSITIONS = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];
const gridMat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1] }));
for (const pos of CUBE_POSITIONS) {
  world.spawn(
    {
      component: Transform,
      data: { pos: [pos[0], pos[1], pos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [gridMat] } },
  );
}

if (!FALSIFY_NO_COMBINED_LIGHTS) {
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.2, -1, -0.3], color: [1, 1, 1], intensity: 0.5 },
  });
} else {
  console.log('[smoke] FALSIFY=no-directional-point-lights -- directional and four point lights omitted');
}

const POINT_LIGHT_POSITIONS = [
  [0.7, 0.2, 2.0],
  [2.3, -3.3, -4.0],
  [-4.0, 2.0, -12.0],
  [0.0, 0.0, -3.0],
];
const POINT_LIGHT_COLORS = [
  [1.0, 1.0, 1.0],
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
];
if (!FALSIFY_NO_COMBINED_LIGHTS) {
  for (let i = 0; i < POINT_LIGHT_POSITIONS.length; i++) {
    const plPos = POINT_LIGHT_POSITIONS[i];
    const plColor = POINT_LIGHT_COLORS[i];
    world.spawn(
      {
        component: Transform,
        data: { pos: [plPos[0], plPos[1], plPos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      {
        component: PointLight,
        data: { color: [plColor[0], plColor[1], plColor[2]], intensity: 100, range: 50 },
      },
    );
  }
}

// w16 spot-shadow scene: floor + obstructing cube + fixed downward spot.
const floorRes = createPlaneGeometry(30, 30);
if (!floorRes.ok) {
  console.error('[smoke] FAIL - createPlaneGeometry failed:', floorRes.error.code);
  process.exit(1);
}
const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
const floorMat = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: [0.55, 0.55, 0.6, 1], metallic: 0, roughness: 0.9 }),
);
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);
world
  .spawn(
    {
      component: Transform,
      data: { pos: [0, -2, -3], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W], scale: [1, 1, 1]},
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  )
  .unwrap();

// The spot-shadow sub-scene sits at x=SHADOW_X, well clear of the LO 2.5
// point-light cluster (x in {0.7,2.3,-4,0}, intensity 100) so the strong
// point-light floor glow does not saturate the shadow sample sites. Same
// coordinates as src/index.ts so the smoke validates the real demo scene.
const SHADOW_X = -9;
const SHADOW_Z = -3;

// FALSIFY=no-occluder removes the cube -> nothing casts a shadow.
const occluderPresent = FALSIFY !== 'no-occluder';
if (!occluderPresent) {
  console.log('[smoke] FALSIFY=no-occluder -- obstructing cube omitted (no shadow caster)');
} else {
  const obstructorMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.85, 0.5, 0.25, 1], metallic: 0, roughness: 0.6 }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [SHADOW_X, -0.6, SHADOW_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [obstructorMat] } },
    )
    .unwrap();
}

// FALSIFY=no-shadow turns off the fixed spot's shadow -> floor under the cube
// is no longer darkened (proves the shadow-darkness assertion can fail).
const spotShadowPresent = FALSIFY !== 'no-shadow';
if (!spotShadowPresent) {
  console.log('[smoke] FALSIFY=no-shadow -- fixed SpotLight castShadow=false');
}
// Spot offset to the +X side of the cube, angled down-and-toward-(-X) so the
// cube's shadow is cast laterally onto the floor where the top-down camera sees
// it next to the cube -- a directly-overhead spot would hide its shadow.
const SPOT_DIR_LEN = Math.hypot(-0.6, -1, 0);
world.spawn(
  {
    component: Transform,
    data: { pos: [SHADOW_X + 2.2, 4, SHADOW_Z], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  {
    component: SpotLight,
    data: {
      direction: [-0.6 / SPOT_DIR_LEN, -1 / SPOT_DIR_LEN, 0],
      color: [1, 1, 1],
      intensity: 40,
      range: 50,
      innerConeDeg: 22,
      outerConeDeg: 32,
      ...(spotShadowPresent ? {} : { castShadow: false }),
    },
  },
);

// Top-down camera looking straight down at the spot-shadow sub-scene so the
// lateral shadow is clearly on-screen, away from the point-light blowout.
const CAM_PITCH = -Math.PI / 2.3; // look mostly down
world.spawn(
  {
    component: Transform,
    data: {
      pos: [SHADOW_X, 6, SHADOW_Z + 2.5], quat: [Math.sin(CAM_PITCH / 2), 0, 0, Math.cos(CAM_PITCH / 2)], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
      clearColor: [0.02, 0.02, 0.04, 1],
    },
  },
);

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
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
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// --- 4. Pixel readback ------------------------------------------------------

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
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
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
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
// Average luminance over a small box (robust to PCF edge / dither noise).
const luminanceBox = (cx, cy, half) => {
  let sum = 0;
  let count = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const [r, g, b] = readRgba(x, y);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
};

// Sample sites empirically calibrated to this scene + top-down camera (verified
// by SMOKE_DUMP_GRID=1 + reading the baseline PNG):
//   shadowFloor   = inside the dark shadow patch cast to the -X side of the cube
//   litFloorLeft  = spot-lit floor left of the cube, outside its shadow
//   litFloorBelow = spot-lit floor below the cube, outside its shadow
// Both lit sites are clear of the point-light glow on the right so the only
// difference vs shadowFloor is the spot occlusion. Re-run with SMOKE_DUMP_GRID=1
// and Read the baseline PNG if the scene geometry ever changes.
const SITES = {
  shadowFloor: { x: 185, y: 140 },
  litFloorLeft: { x: 130, y: 128 },
  litFloorBelow: { x: 175, y: 210 },
  combinedLightsFloor: { x: 40, y: 150 },
};
const HALF = 5;
const pixelSamples = {};
const lumSamples = {};
for (const [name, s] of Object.entries(SITES)) {
  pixelSamples[name] = readRgba(s.x, s.y);
  lumSamples[name] = Number(luminanceBox(s.x, s.y, HALF).toFixed(4));
}
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);
console.log(`[smoke] lumSamples=${JSON.stringify(lumSamples)}`);

if (process.env.SMOKE_DUMP_GRID === '1') {
  const cols = 40;
  const rows = 30;
  let grid = '';
  for (let r = 0; r < rows; r++) {
    const py = Math.floor(((r + 0.5) / rows) * HEIGHT);
    let line = '';
    for (let c = 0; c < cols; c++) {
      const px = Math.floor(((c + 0.5) / cols) * WIDTH);
      const l = luminanceBox(px, py, 2);
      const ch = l < 0.1 ? '.' : l < 0.2 ? ':' : l < 0.35 ? '+' : l < 0.5 ? '*' : '#';
      line += ch;
    }
    grid += `${String(py).padStart(3)} ${line}\n`;
  }
  console.log(`[smoke] lumGrid (cols x=0..${WIDTH}):\n${grid}`);
}

// --- 5. Optional baseline write ---------------------------------------------

if (SMOKE_WRITE_BASELINE) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      rgba[dst] = bytes[off] ?? 0;
      rgba[dst + 1] = bytes[off + 1] ?? 0;
      rgba[dst + 2] = bytes[off + 2] ?? 0;
      rgba[dst + 3] = bytes[off + 3] ?? 255;
    }
  }
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(BASELINE_PNG_PATH, writePng(WIDTH, HEIGHT, rgba));
  console.log(`[smoke] baseline written to ${BASELINE_PNG_PATH}`);
}

// --- 6. Verdict -------------------------------------------------------------

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

const litFloorLum = Math.max(lumSamples.litFloorLeft, lumSamples.litFloorBelow);
const shadowDelta = Number((litFloorLum - lumSamples.shadowFloor).toFixed(4));
console.log(`[smoke] shadowDelta=${shadowDelta} (litFloor=${litFloorLum}, shadowFloor=${lumSamples.shadowFloor})`);

const CLEAR_LUM = 0.2126 * 0.02 + 0.7152 * 0.02 + 0.0722 * 0.04;
const combinedLightLuminance = lumSamples.combinedLightsFloor;
const combinedLightTypeWitness = combinedLightLuminance - CLEAR_LUM >= COMBINED_LIGHT_MIN_DELTA;
console.log(
  `[smoke] oracle=combined-directional-point-spot combinedLightsFloor=${combinedLightLuminance} deltaFromClear=${Number((combinedLightLuminance - CLEAR_LUM).toFixed(4))} witness=${combinedLightTypeWitness} threshold=${COMBINED_LIGHT_MIN_DELTA} falsifier=${FALSIFY_NO_COMBINED_LIGHTS ? 'no-directional-point-lights' : 'none'}`,
);

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);

// (c) the floor must actually be rendered (non-clear) at the lit site -- guards
// against an empty / black frame falsely passing the shadow delta.
if (litFloorLum - CLEAR_LUM < SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(c) lit floor luminance=${litFloorLum} ~= clear (${CLEAR_LUM.toFixed(4)}); floor not rendered / empty frame`,
  );
}

// (d) THE shadow assertion: lit floor must be clearly brighter than the
// shadowed floor under the cube. FALSIFY=no-shadow / no-occluder collapse this.
if (shadowDelta < SMOKE_PIXEL_THRESHOLD) {
  failures.push(
    `(d) shadowDelta=${shadowDelta} < ${SMOKE_PIXEL_THRESHOLD}; floor under cube not darkened by spot shadow (litFloor=${litFloorLum}, shadowFloor=${lumSamples.shadowFloor})`,
  );
}

if (!combinedLightTypeWitness) {
  failures.push(
    `(e) combined directional/point/spot witness rejected combinedLightsFloor=${combinedLightLuminance}; expected deltaFromClear>=${COMBINED_LIGHT_MIN_DELTA} outside the fixed spot's bright shadow sample region`,
  );
}

if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(f) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-5-light-casters' smoke",
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, floorRendered, spotShadowDelta=${shadowDelta} (>=${SMOKE_PIXEL_THRESHOLD}), oracle=combined-directional-point-spot, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
