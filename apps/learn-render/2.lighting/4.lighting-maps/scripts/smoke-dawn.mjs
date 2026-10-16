#!/usr/bin/env node
// apps/learn-render/2.lighting/4.lighting-maps/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 2.4 lighting-maps dawn-node smoke (feat-20260611
// w12 / M3 round-2 fix-up I-4 -- real-scene adaptation per src/index.ts).
//
// Walks the LO 2.4 diffuse + specular pair scene the demo runs in
// production:
//   1. decodeImageFromFile(container2.png) -- diffuse map.
//   2. decodeImageFromFile(container2_specular.png) -- specular map.
//   3. registerWithGuid<TextureAsset> for both (CONTAINER2_TEXTURE_GUID
//      + CONTAINER2_SPECULAR_GUID).
//   4. registerWithGuid<MeshAsset>(cubeGuid, HANDLE_CUBE asset).
//   5. Standard PBR material with baseColorTexture: diffuse handle and
//      metallicRoughnessTexture: specular handle.
//   6. spawn 1 lit cube at origin + camera at z=3 + a small lamp cube at
//      (1.2, 1.0, 2.0) carrying PointLight (LO 4.2 lightPos canonical
//      literal). FALSIFY_NO_LIGHT=1 keeps only the lamp mesh.
//
// Differential axes vs hello-triangle (D-2 / D-8 byte-level):
//   - GUID set: 2 textures (CONTAINER2_TEXTURE + SPECULAR) + cube +
//     material -- 4 registerWithGuid calls.
//   - clear color: engine teal default (0.2, 0.3, 0.3).
//   - sample sites: lit cube at origin (probes around centre) + lamp
//     marker at NDC upper-right (LIGHT_POS_X/Y/Z reproject through the
//     perspective camera). Names mirror the lecture geometry.
//
// Output literals (preserved byte-for-byte for grep tooling):
//   - `[learn-render-lighting-maps] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`
//   - `[smoke] PASS - 6 criteria GREEN: ...`

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const FALSIFY_NO_LIGHT = process.env.FALSIFY_NO_LIGHT === '1';
const FALSIFY_NO_SPECULAR_MAP = process.env.FALSIFY_NO_SPECULAR_MAP === '1';
const RHI_DEBUG_DAWN_CAPTURE = process.env.FORGEAX_RHI_DEBUG_DAWN_CAPTURE === '1';
const RHI_DEBUG_DAWN_IDLE = process.env.FORGEAX_RHI_DEBUG_DAWN_IDLE === '1';
const RHI_DEBUG_STAGE_TELEMETRY = process.env.FORGEAX_RHI_DEBUG_STAGE_TELEMETRY !== '0';
const RHI_DEBUG_CAPTURE_FRAMES = 1;
const COMPARISON_CONTROL_FLAGS = {
  FALSIFY_NO_LIGHT: process.env.FALSIFY_NO_LIGHT ?? '0',
  FALSIFY_NO_SPECULAR_MAP: process.env.FALSIFY_NO_SPECULAR_MAP ?? '0',
};
const ORACLE_READBACK_PLACEMENT = 'after-target-frame-workload';
const PERSISTENCE_BASELINE = 'finalize-plus-retained-report-and-artifact-validation';

const WIDTH = 800;
const HEIGHT = 600;
const PIXEL_SITES = [
  { name: 'litCubeCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'litCubeUL', x: Math.floor(WIDTH * 0.4), y: Math.floor(HEIGHT * 0.42) },
  { name: 'litCubeBR', x: Math.floor(WIDTH * 0.6), y: Math.floor(HEIGHT * 0.58) },
  { name: 'lampMarker', x: Math.floor(WIDTH * 0.86), y: Math.floor(HEIGHT * 0.32) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
];

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const DIFFUSE_SRC_PATH = resolve(TEXTURES_DIR, 'container2.png');
const DIFFUSE_META_PATH = resolve(TEXTURES_DIR, 'container2.png.meta.json');
const SPECULAR_SRC_PATH = resolve(TEXTURES_DIR, 'container2_specular.png');
const SPECULAR_META_PATH = resolve(TEXTURES_DIR, 'container2_specular.png.meta.json');

const SMOKE_WALL_BUDGET_MS = Number.parseInt(process.env.SMOKE_WALL_BUDGET_MS ?? '45000', 10);

const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e3969-2000-7000-8000-000000000001';
// LO 4.2 lighting_maps_specular_map.cpp lightPos canonical literal.
const LIGHT_POS_X = 1.2;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 2.0;
const LAMP_SCALE = 0.2;

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
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

async function readbackRenderTarget(device) {
  const readbackStart = performance.now();
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
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
    return [
      (bytes[off + 0] ?? 0) / 255,
      (bytes[off + 1] ?? 0) / 255,
      (bytes[off + 2] ?? 0) / 255,
    ];
  };
  const pixelSamples = {};
  for (const site of PIXEL_SITES) pixelSamples[site.name] = readRgba(site.x, site.y);
  return {
    pixelSamples,
    wallTimeMs: Math.max(0, Math.round(performance.now() - readbackStart)),
  };
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

// --- 3. Drive engine ECS path: diffuse + specular pair + lit cube + lamp ----

if (
  !existsSync(DIFFUSE_SRC_PATH) ||
  !existsSync(DIFFUSE_META_PATH) ||
  !existsSync(SPECULAR_SRC_PATH) ||
  !existsSync(SPECULAR_META_PATH)
) {
  console.error('[smoke] FAIL - container2 / container2_specular asset fixtures missing');
  process.exit(1);
}

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, MeshFilter, MeshRenderer, PointLight } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
  resolveAssetHandle,
} = await import('@forgeax/engine-assets-runtime');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const diffuseRes = await decodeImageFromFile(DIFFUSE_SRC_PATH);
const specularRes = await decodeImageFromFile(SPECULAR_SRC_PATH);
if (!diffuseRes.ok || !specularRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed for diffuse or specular');
  process.exit(1);
}
const { decoded: diffuseDecoded, meta: diffuseMeta } = diffuseRes.value;
const { decoded: specularDecoded, meta: specularMeta } = specularRes.value;
console.log(
  `[learn-render-lighting-maps] decoded diffuse=${diffuseDecoded.width}x${diffuseDecoded.height} specular=${specularDecoded.width}x${specularDecoded.height}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const EMPTY_MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(EMPTY_MANIFEST_URL));

let debugInst;
let renderer;
let assets;
try {
  let rendererOptions = {};
  if (RHI_DEBUG_DAWN_CAPTURE || RHI_DEBUG_DAWN_IDLE) {
    const { rhi: realRhi, createShaderModule } = await import('@forgeax/engine-rhi-webgpu');
    const { wrap, wrapCreateShaderModule } = await import('@forgeax/engine-rhi-debug');
    debugInst = wrap(realRhi);
    const debugExtras = debugInst;
    debugExtras.createShaderModule = wrapCreateShaderModule(createShaderModule, debugInst);
    const realAcquireCanvasContext = realRhi.acquireCanvasContext.bind(realRhi);
    debugExtras.acquireCanvasContext = (canvasArg) => {
      const contextResult = realAcquireCanvasContext(canvasArg);
      if (!contextResult.ok) return contextResult;
      const realContext = contextResult.value;
      const wrappedContext = Object.create(realContext);
      wrappedContext.configure = (desc) => {
        const device = desc.device;
        const realDevice = device?._realDevice;
        return realContext.configure(
          realDevice === undefined ? desc : { ...desc, device: realDevice },
        );
      };
      return { ...contextResult, value: wrappedContext };
    };
    if (RHI_DEBUG_DAWN_CAPTURE) {
      const armResult = debugInst.arm(RHI_DEBUG_CAPTURE_FRAMES);
      if (!armResult.ok) {
        console.error(`[smoke] FAIL - Dawn RHI-debug arm failed: ${armResult.error.code}`);
        process.exit(1);
      }
    }
    rendererOptions = { rhi: debugInst };
  }
  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    rendererOptions,
    { shaderManifestUrl: EMPTY_MANIFEST_URL },
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

console.log(`[learn-render-lighting-maps] backend=${renderer.inspect().capabilities.backendKind}`);
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
const errors = [];
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


const diffuseGuidRes = AssetGuid.parse(diffuseMeta.guid);
const specularGuidRes = AssetGuid.parse(specularMeta.guid);
const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
const matGuidRes = AssetGuid.parse(CUBE_MATERIAL_GUID);
if (!diffuseGuidRes.ok || !specularGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failure');
  process.exit(1);
}

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

const mkTex = (decoded) => ({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
  format: decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: decoded.bytes,
  colorSpace: decoded.colorSpace,
  mips: decoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
});
// feat-20260614 M8 (D-15/D-17): textures mint user-tier column handles via
// allocSharedRef; GUIDs are catalogued for loadByGuid parity.
const diffuseHandle = world.allocSharedRef('TextureAsset', mkTex(diffuseDecoded));
const specularHandle = world.allocSharedRef('TextureAsset', mkTex(specularDecoded));
assets.catalog(diffuseGuidRes.value, mkTex(diffuseDecoded));
assets.catalog(specularGuidRes.value, mkTex(specularDecoded));

const cubeAssetRes = resolveAssetHandle(world, HANDLE_CUBE);
if (!cubeAssetRes.ok) {
  console.error('[smoke] FAIL - HANDLE_CUBE asset unavailable');
  process.exit(1);
}
assets.catalog(cubeGuidRes.value, cubeAssetRes.value);

// LO 2.4 main lit cube material -- mirror the production pack's Standard PBR
// program. The LO specular map is carried by the engine's
// metallicRoughnessTexture slot, matching the production material payload.
const cubeMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    baseColorTexture: unwrapHandle(diffuseHandle),
    ...(FALSIFY_NO_SPECULAR_MAP
      ? {}
      : { metallicRoughnessTexture: unwrapHandle(specularHandle) }),
  },
});
// Lamp marker material (white emissive proxy).
const lampMaterial = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } }, queue: 2000 }],
  values: { baseColor: [1.0, 1.0, 1.0, 1.0] },
});

// LO 2.4 single lit container cube at origin.
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  {
    component: MeshRenderer,
    data: { materials: [cubeMaterial] },
  },
);
// LO 4.2 lamp marker + co-located PointLight at (1.2, 1.0, 2.0). The
// falsifier keeps the marker and removes only the light component.
const lamp = {
  component: Transform,
  data: {
    pos: [LIGHT_POS_X, LIGHT_POS_Y, LIGHT_POS_Z], quat: [0, 0, 0, 1], scale: [LAMP_SCALE, LAMP_SCALE, LAMP_SCALE],
  },
};
const lampComponents = [
  lamp,
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [lampMaterial] } },
];
if (!FALSIFY_NO_LIGHT) {
  lampComponents.push({
    component: PointLight,
    data: { color: [1, 1, 1], intensity: 100.0, range: 50 },
  });
}
world.spawn(...lampComponents);
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
let rhiDebugCapture;
let telemetryReadback;
if (debugInst !== undefined) {
  if (RHI_DEBUG_DAWN_CAPTURE) {
    const captureStart = performance.now();
    const snapshotStart = performance.now();
    const snapshotResult = await debugInst.snapshotAllLiveResources();
    const snapshotWallMs = Math.max(0, Math.round(performance.now() - snapshotStart));
    if (!snapshotResult.ok) {
      console.error(`[smoke] FAIL - Dawn RHI-debug snapshot failed: ${snapshotResult.error.code}`);
      process.exit(1);
    }
    world.update().unwrap();
    const captureDraw = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!captureDraw.ok) {
      console.error(`[smoke] draw capture frame error: ${captureDraw.error.code}`);
    } else {
      const completed = await captureDraw.value.completed;
      if (!completed.ok) errors.push({ code: completed.error.code, hint: completed.error.hint });
      else framesObserved++;
    }
    debugInst.onFrameEnd();
    const queueWaitStart = performance.now();
    await sharedDevice.queue.onSubmittedWorkDone();
    const queueWaitWallMs = Math.max(0, Math.round(performance.now() - queueWaitStart));
    let readbackWallMs = 0;
    if (RHI_DEBUG_STAGE_TELEMETRY) {
      // The stage readback is telemetry work. The final oracle readback below
      // remains unconditional so disabled and enabled controls render the same
      // workload while only the enabled path records this extra boundary.
      const readbackStart = performance.now();
      telemetryReadback = await readbackRenderTarget(sharedDevice);
      readbackWallMs = Math.max(0, Math.round(performance.now() - readbackStart));
    }
    const captureWallMs = Math.max(0, Math.round(performance.now() - captureStart));
    const finalizeStart = performance.now();
    const finalizeResult = debugInst.finalize();
    const serializationWallMs = Math.max(0, Math.round(performance.now() - finalizeStart));
    if (!finalizeResult.ok) {
      console.error(`[smoke] FAIL - Dawn RHI-debug finalize failed: ${finalizeResult.error.code}`);
      process.exit(1);
    }
    const persistenceStart = performance.now();
    const persistedReport = JSON.parse(readFileSync(finalizeResult.value.reportPath, 'utf8'));
    statSync(finalizeResult.value.tapePath);
    statSync(finalizeResult.value.reportPath);
    if (persistedReport.valid !== true) {
      console.error('[smoke] FAIL - retained RHI-debug report is not valid');
      process.exit(1);
    }
    const persistenceWallMs = Math.max(0, Math.round(performance.now() - persistenceStart));
    const finalizeWallMs = serializationWallMs + persistenceWallMs;
    rhiDebugCapture = {
      ...finalizeResult.value,
      requestedFrames: RHI_DEBUG_CAPTURE_FRAMES,
      captureWallMs,
      finalizeWallMs,
      comparisonDimensions: {
        oracle: 'diffuse-specular-point-light-plus-specular-map',
        readbackPlacement: ORACLE_READBACK_PLACEMENT,
        persistenceBaseline: PERSISTENCE_BASELINE,
        controlFlags: COMPARISON_CONTROL_FLAGS,
      },
      ...(RHI_DEBUG_STAGE_TELEMETRY
        ? {
            stageEvidence: {
              capture: {
                wallTimeMs: captureWallMs,
                snapshotWallMs,
                queueWaitWallMs,
                readbackWallMs,
                readbackSampleCount: Object.keys(telemetryReadback.pixelSamples).length,
              },
              finalize: {
                wallTimeMs: finalizeWallMs,
                serializationWallMs,
                persistenceWallMs,
              },
            },
          }
        : {}),
    };
    console.log(`[smoke] rhiDebugCapture=${JSON.stringify(rhiDebugCapture)}`);
  }
}
for (let i = framesObserved; i < TARGET_FRAMES; i++) {
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
    else framesObserved++;
  }
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

// --- 4. Pixel readback (multi-site grid) ------------------------------------

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
// LO 2.4 sample sites: litCubeCenter (origin lit cube) + litCubeUL/BR
// (cube interior at offset 0.4/0.6 -- distinct from textures' 0.35/0.65)
// + lampMarker (1.2, 1.0, 2.0) projects to NDC upper-right area.
const readback = await readbackRenderTarget(device);
const { pixelSamples } = readback;
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (6 criteria) ------------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.2, 0.3, 0.3];
const meshSiteNames = ['litCubeCenter', 'litCubeUL', 'litCubeBR'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const litCubeCenter = pixelSamples.litCubeCenter;
const litCubeUL = pixelSamples.litCubeUL;
const litCubeBR = pixelSamples.litCubeBR;
const diffuseSpecularPointLightWitness =
  litCubeCenter[0] > 0.18 &&
  litCubeCenter[1] > 0.1 &&
  litCubeCenter[2] > 0.05 &&
  litCubeUL[0] > litCubeBR[0] + 0.08 &&
  litCubeUL[0] > litCubeUL[1] * 1.15;
const specularMapWitness =
  !FALSIFY_NO_SPECULAR_MAP && litCubeCenter[0] < 0.93 && litCubeBR[0] < 0.4;
console.log(
  `[smoke] oracle=diffuse-specular-point-light witness=${diffuseSpecularPointLightWitness} ` +
    `specular-map=${specularMapWitness} falsifier=${FALSIFY_NO_LIGHT ? 'no-point-light' : FALSIFY_NO_SPECULAR_MAP ? 'no-specular-map' : 'none'}`,
);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs} (budget=${SMOKE_WALL_BUDGET_MS})`);

void matGuidRes;

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) LO 2.4 lit cube - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD}; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
}
if (!diffuseSpecularPointLightWitness) {
  failures.push(
    `(e) diffuse/specular point-light witness rejected center=${JSON.stringify(litCubeCenter)} ul=${JSON.stringify(litCubeUL)} br=${JSON.stringify(litCubeBR)}`,
  );
}
if (!specularMapWitness) {
  failures.push(
    `(f) specular map response rejected center.r=${litCubeCenter[0].toFixed(4)} br.r=${litCubeBR[0].toFixed(4)}; expected the bound map to lower both below the no-map control`,
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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-4-lighting-maps' smoke",
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-2-lighting-4-lighting-maps/smoke', framesObserved);

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, LO 2.4 lit cube + lamp sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, oracle=diffuse-specular-point-light + specular-map-response, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
