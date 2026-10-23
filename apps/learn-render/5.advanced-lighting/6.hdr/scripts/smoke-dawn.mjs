#!/usr/bin/env node
import { HDR_EFFECT_WGSL, HDR_EXPOSURE_POSTPROCESS_ID } from '../src/hdr-pipeline.ts';
// apps/learn-render/5.advanced-lighting/6.hdr/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.6 - HDR dawn-node smoke.
// Registers two custom RenderPipeline (HDR exposure + LDR passthrough),
// drives >=150 frames per mode (>=60 total), asserts perFramePassNames is
// exactly ['main', 'postHdr'], onError == 0, AND reads a tunnel floor-wall
// pixel to assert the wall surface actually renders + is lit (criterion (e)).
//
// Wall-pixel gate (verify round 1 V1): the structural assertions read zero
// scene pixels, so they cannot catch a missing-walls regression. Criterion (e)
// samples a wall pixel (NOT the far-end marker cube, which would mask the
// defect) and requires it non-black. The tunnel mesh is an INWARD-facing box
// (invertMesh, mirroring src/index.ts): the single-sided PBR shader clamps
// NdotL=max(dot(N,L),0) to 0 on the outward-normal HANDLE_CUBE inner walls, so
// a camera-inside tunnel built from the plain cube renders black. Flipping the
// wall normals (and re-winding triangles) makes the interior point lights give
// NdotL > 0 -> lit walls -> non-black pixel.
//
// WALL FALSIFY mode (env FORGEAX_HDR_WALL_FALSIFY=1): builds the tunnel from the
// OUTWARD-normal box instead. The interior walls then render black, criterion
// (e) FAILs, and the smoke exits non-zero -- proving the wall-pixel gate has
// discriminating power (it is not pinned to an always-non-black sample). NOT in
// CI; the default path uses the inward mesh and must be GREEN.
//
// FALSIFY mode (env FORGEAX_LEARN_RENDER_5_6_HDR_SMOKE_FALSIFY=1):
// skips installPipeline so the URP default 9-pass chain runs instead;
// perFramePassNames will not match ['main', 'postHdr'] and the smoke
// MUST exit with [smoke] FAIL. Plan-decisions D-5(a) / plan-strategy
// section 5.4: implement the falsification check, not just the
// confirmation.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-6-hdr] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const PER_MODE_FRAMES = Math.max(150, Math.ceil(SMOKE_MIN_FRAMES / 2));
const WIDTH = 512;
const HEIGHT = 512;

const FALSIFY = process.env.FORGEAX_LEARN_RENDER_5_6_HDR_SMOKE_FALSIFY === '1';

// Wall-pixel discrimination falsify: build the tunnel from the OUTWARD-normal
// box so its interior walls render black -> criterion (e) FAILs (proves the
// wall-pixel gate is discriminating). NOT in CI.
const WALL_FALSIFY = process.env.FORGEAX_HDR_WALL_FALSIFY === '1';

const hereDir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Mirror src/index.ts inline WGSL (kept in sync by hand; C3/C-B3). The exposure
// is data-driven via the @group(1) @binding(2) params UBO (feat-20260621 M-B2) —
// NOT a hardcoded `let exposure : f32 = 1.0;` literal. Grep
// `exp(-hdrColor * params.exposure)` finds both src/index.ts and this smoke.
//
// FALSIFY mode (AC-B10 mirror discrimination): set FORGEAX_HDR_FALSIFY=1 to read
// the params UBO at the WRONG binding (binding(1), the sampler slot) instead of
// binding(2). That makes the WGSL incompatible with the 3-entry BGL the engine
// composes for `entry.params !== undefined`, so the smoke FAILs — proving the
// mirror is sensitive to the params channel actually being wired. NOT in CI.
const HDR_FALSIFY = process.env.FORGEAX_HDR_FALSIFY === '1';
const HDR_PARAMS_BINDING = HDR_FALSIFY ? 1 : 2;

// 16 B params: [exposure(f32), pad, pad, pad] — mirrors src/index.ts.
function packExposureBytes(exposure, mode = 0) {
  const buf = new ArrayBuffer(16);
  new Float32Array(buf)[0] = exposure;
  new Float32Array(buf)[1] = mode;
  return new Uint8Array(buf);
}

// Read one RGBA8 pixel from a texture at (px, py). copyTextureToBuffer requires
// bytesPerRow to be a 256-byte multiple, so we copy a 1x1 region into a 256 B
// buffer and read the first 4 bytes. Returns [r, g, b, a] in 0..255.
async function readPixelRGBA8(device, texture, px, py) {
  const readbackBuffer = device.createBuffer({
    size: 256,
    usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: { x: px, y: py, z: 0 } },
    { buffer: readbackBuffer, bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readbackBuffer.mapAsync(0x0001); // MAP_READ
  const bytes = new Uint8Array(readbackBuffer.getMappedRange().slice(0, 4));
  const out = [bytes[0], bytes[1], bytes[2], bytes[3]];
  readbackBuffer.unmap();
  readbackBuffer.destroy?.();
  return out;
}
// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-6-hdr' smoke",
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

// --- 2. Mock canvas with offscreen render target ---

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

// --- 3. Asset fixture check ---

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, MeshFilter, MeshRenderer, PointLight, PostProcessParams, TONEMAP_NONE } = await import('@forgeax/engine-render');
const { createFullscreenRenderFeature } = await import('@forgeax/engine-app');
const { Transform } = await import('@forgeax/engine-scene');


// Mirror src/index.ts invertMesh: turn a box inside-out (negate normals + re-wind
// triangles) so its INTERIOR walls light under the single-sided PBR shader. The
// interleaved `vertices` (12-float stride: pos3+normal3+uv2+tangent4) is the
// render-record consumer; negate the normal floats at offset 3..5 per vertex.
function invertMesh(mesh) {
  const vertices = mesh.vertices.slice();
  for (let base = 0; base < vertices.length; base += 12) {
    vertices[base + 3] = -vertices[base + 3];
    vertices[base + 4] = -vertices[base + 4];
    vertices[base + 5] = -vertices[base + 5];
  }
  const normalAttr =
    mesh.attributes.normal instanceof Float32Array ? mesh.attributes.normal.slice() : undefined;
  if (normalAttr !== undefined) {
    for (let i = 0; i < normalAttr.length; i++) normalAttr[i] = -normalAttr[i];
  }
  const indices = mesh.indices.slice();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
  return {
    ...mesh,
    vertices,
    indices,
    attributes: normalAttr === undefined ? mesh.attributes : { ...mesh.attributes, normal: normalAttr },
  };
}
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed:', woodDecodeRes.error.code);
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-6-hdr] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
let assets;
try {
  const feature = createFullscreenRenderFeature({
    identity: 'learn-render::5-6-hdr-lo-exposure',
    source: HDR_EFFECT_WGSL.replace('@binding(2) var<uniform>', `@binding(${HDR_PARAMS_BINDING}) var<uniform>`),
    params: { byteSize: 16, defaultValue: packExposureBytes(1.0) },
  });
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    { features: FALSIFY ? [] : [feature] },
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

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry unavailable');
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// Register wood texture under its GUID.
const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}
const woodTexAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: woodDecoded.width, height: woodDecoded.height } },
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mips: woodDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
};
const world = new World({ assets: assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// Catalogue the wood texture under its GUID, then mint a shared-ref column handle.
const woodHandle = world.assets.create(woodTexAsset).unwrap();

const tunnelMat = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.85,
    baseColorTexture: unwrapHandle(woodHandle),
  },
}).unwrap();

const strongMat = world.assets.create({
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
  ],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.4,
    // feat-20260621 M-B1 (R-B2): light-box emissive DEMOTED to a dim marker;
    // the overbright comes from the strong PointLight below, not self-emission.
    emissive: [1.0, 1.0, 1.0],
    emissiveIntensity: 0.4,
  },
}).unwrap();

// Tunnel: inward-facing box so the interior walls light (mirrors src/index.ts).
// WALL_FALSIFY uses the OUTWARD box -> black walls -> criterion (e) FAILs.
const tunnelMeshRes = createBoxGeometry(1, 1, 1);
if (!tunnelMeshRes.ok) {
  console.error('[smoke] FAIL - createBoxGeometry failed:', tunnelMeshRes.error.code);
  process.exit(1);
}
const tunnelMesh = WALL_FALSIFY ? tunnelMeshRes.value : invertMesh(tunnelMeshRes.value);
const tunnelMeshHandle = world.assets.create(tunnelMesh).unwrap();
if (WALL_FALSIFY) {
  console.warn(
    '[learn-render-6-hdr] WALL_FALSIFY mode: outward-normal tunnel (interior walls render black)',
  );
}
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, -25], quat: [0, 0, 0, 1], scale: [5, 5, 50],},
    },
    { component: MeshFilter, data: { assetHandle: tunnelMeshHandle } },
    { component: MeshRenderer, data: { materials: [tunnelMat] } },
  )
  .unwrap();

// Strong light at far end
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, -45], quat: [0, 0, 0, 1], scale: [0.25, 0.25, 0.25],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [strongMat] } },
  )
  .unwrap();
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, -45], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  // feat-20260621 M-B1 (R-B1): strong far-end PointLight is the physical
  // overbright source (intensity ~200 + range ~60m -> far-wall radiance > 1.0).
  {
    component: PointLight,
    data: { color: [1.0, 1.0, 1.0], intensity: 200.0, range: 60.0 },
  },
);

// Camera
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
      tonemap: TONEMAP_NONE,
    },
  },
);

// --- 5. Register two custom RenderPipelines + their assets ---

const exposureEntity = world.spawn({
  component: PostProcessParams,
  data: { shader: HDR_EXPOSURE_POSTPROCESS_ID, data: packExposureBytes(1.0) },
}).unwrap();

const frameStart = Date.now();
const presentationDeadline = frameStart + 120_000;
let framesObserved = 0;
// Await each frame's GPU work so the standard-PBR material's async PSO compile
// resolves (a synchronous loop leaves it 'rhi-not-available' -> skip-draw ->
// black scene; mirrors 5.1 advanced-lighting smoke header). Prerequisite for
// the wall-pixel readback below to observe real geometry.
// Pending receipts waited on pipeline preparation and presented nothing.
for (let i = 0; i < PER_MODE_FRAMES; ) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  if (!r.ok) {
    console.error(`[smoke] draw hdr frame ${i} error: ${r.error.code}`);
    i++;
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
    else framesObserved++;
    if (!completed.ok || r.value.presentation === 'ready' || Date.now() > presentationDeadline) i++;
  }
  await sharedDevice.queue.onSubmittedWorkDone();
}

// --- Wall-pixel discrimination gate (verify round 1 V1) ---
// The structural assertions (backend / frames / passNames / onError) read ZERO
// scene pixels, so a GREEN structural smoke cannot catch the missing-walls
// defect. After the HDR-mode frames, sample a TUNNEL-WALL pixel that is NOT the
// far-end marker cube: the floor strip just below center (x=WIDTH/2,
// y=HEIGHT*0.82) lands on the wood floor wall, which a working LO 5.6 scene
// lights via the point light(s). The far-wall CENTER pixel is deliberately
// avoided -- it is occluded by the emissive marker cube and would pass even
// when every wall is missing (false positive). This gate requires an actual
// lit wall surface to be non-black.
const wallSampleX = Math.floor(WIDTH / 2);
const wallSampleY = Math.floor(HEIGHT * 0.82);
const wallPixel = await readPixelRGBA8(sharedDevice, renderTarget, wallSampleX, wallSampleY);
const wallLuma = wallPixel[0] + wallPixel[1] + wallPixel[2];
console.log(
  `[smoke] tunnel floor-wall pixel (${wallSampleX},${wallSampleY}) rgba=[${wallPixel.join(', ')}] (sum=${wallLuma})`,
);

world.set(exposureEntity, PostProcessParams, {data: packExposureBytes(1.0, 1)}).unwrap();
// Pending receipts waited on pipeline preparation and presented nothing.
for (let i = 0; i < PER_MODE_FRAMES; ) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  if (!r.ok) {
    console.error(`[smoke] draw ldr frame ${i} error: ${r.error.code}`);
    i++;
  } else {
    const completed = await r.value.completed;
    if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
    else framesObserved++;
    if (!completed.ok || r.value.presentation === 'ready' || Date.now() > presentationDeadline) i++;
  }
}

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, per-mode=${PER_MODE_FRAMES})`,
);

// --- 7. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);
const ldrWallPixel = await readPixelRGBA8(device, renderTarget, wallSampleX, wallSampleY);
const modeDifference = Math.max(...wallPixel.slice(0, 3).map((channel, i) => Math.abs(channel - ldrWallPixel[i])));
console.log(`[smoke] HDR/LDR wall difference=${modeDifference}`);

const failures = [];
if (modeDifference === 0) failures.push('HDR and LDR must produce different wall pixels through the shared fullscreen feature');
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// (e) Tunnel wall pixel must be non-black: the inward-facing wall surface renders
// and is lit by the interior point lights (verify round 1 V1). FALSIFY skips
// installPipeline so the wall is not in our offscreen target -- the readback is
// only meaningful on the real HDR path. WALL_FALSIFY uses the outward box, so a
// black pixel here is EXPECTED and (e) must fail (discrimination proof).
const WALL_PIXEL_MIN_SUM = 8; // sum of R+G+B; black is 0
if (!FALSIFY && wallLuma < WALL_PIXEL_MIN_SUM) {
  failures.push(
    `(e) tunnel wall pixel rgb sum=${wallLuma} < ${WALL_PIXEL_MIN_SUM} ` +
      '(interior wall surface not rendered/lit; expected lit wood wall). ' +
      'On the default path this is a regression; under FORGEAX_HDR_WALL_FALSIFY=1 ' +
      'it is the expected discrimination failure (outward-normal walls go black).',
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-6-hdr' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - Standard host criteria GREEN: frames=${framesObserved}, RhiError count=0, floor-wall pixel sum=${wallLuma} (non-black), wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
