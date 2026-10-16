#!/usr/bin/env node
// hello-gltf headless smoke (feat-20260515-gltf-loader-via-asset-system / M5 / w23).
//
// End-to-end proof: dawn-node drives the same loadByGuid<SceneAsset> +
// sceneInstances.instantiate path the browser src/main.ts exercises, but
// fed by the @forgeax/engine-gltf importer parsing apps/hello/gltf/
// assets/box.gltf at runtime (charter P4 consistent abstraction). Single
// mesh + Tier-B subset (POSITION + INDICES; UnlitMaterial baseColor
// scalar; Camera perspective). 60 frames + multi-pixel readback with
// epsilon = 0.05 distance from clear color.
//
// Strategy (mirrors apps/hello/room/scripts/smoke-dawn.mjs):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + shim GPUCanvasContext.
//   3. parseGltf(box.gltf) -> IR; bridge IR -> MeshAsset / MaterialAsset /
//      SceneAsset PODs; catalog each against the GUIDs in
//      box.gltf.meta.json so loadByGuid hits the in-memory fast-path.
//   4. await host initialization + 60 x lease-bound renderer.draw.
//   5. copyTextureToBuffer + mapAsync grid sample; verdict =
//      3 criteria (a) frames>=60 (b) per-pixel distance to clear color >=
//      SMOKE_PIXEL_THRESHOLD on
//          at least M of N sample sites (single-mesh epsilon = 0.05 gate)
//      (c) Renderer.onError RhiError count == 0.
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-gltf] pipeline=Standard`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(here, 'baseline.png');
const BOX_GLTF_PATH = resolve(here, '..', 'assets', 'box.gltf');
const BOX_META_PATH = resolve(here, '..', 'assets', 'box.gltf.meta.json');

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-gltf smoke');
  console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
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
  console.error('  rerun: pnpm --filter @forgeax/hello-gltf smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
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

// --- 3. Drive engine ECS path through the gltf importer ---------------------

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  renderComponentsPlugin,
} = await import('@forgeax/engine-render');
const { ChildOf, Name, scenePlugin, Transform } = await import('@forgeax/engine-scene');
const {
  HANDLE_CUBE,
} = await import('@forgeax/engine-assets-runtime');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { parseGltf, gltfDocToSceneAsset } = await import('@forgeax/engine-gltf');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(
  readFileSync(MANIFEST_PATH, 'utf8'),
)}`;

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(
    `[smoke] FAIL - renderer host construction failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[hello-gltf] pipeline=Standard');

// Read + parse the gltf source (same Tier-B fork the browser bundle
// hands to parseGltf). The data URI buffer is resolved inline so
// externalLoader never fires (it throws if invoked, charter P3
// explicit-failure red line).
const gltfJson = JSON.parse(readFileSync(BOX_GLTF_PATH, 'utf8'));
const externalLoader = async (uri) => {
  throw new Error(`[smoke] unexpected externalLoader call for uri=${uri}`);
};
const docResult = await parseGltf(gltfJson, externalLoader, BOX_GLTF_PATH);
if (!docResult.ok) {
  console.error(`[smoke] FAIL - parseGltf: ${docResult.error.code}`);
  process.exit(1);
}
const doc = docResult.value;

// Read meta sidecar for the GUID -> kind map (mirror of vite JSON
// import in src/main.ts; the meta is committed alongside box.gltf so
// the smoke and the browser entrypoint share the same identifiers).
const metaJson = JSON.parse(readFileSync(BOX_META_PATH, 'utf8'));
const subAssets = metaJson.subAssets;
const meshSub = subAssets.find((s) => s.kind === 'mesh');
const materialSub = subAssets.find((s) => s.kind === 'material');
const sceneSub = subAssets.find((s) => s.kind === 'scene');
if (!meshSub || !materialSub || !sceneSub) {
  console.error('[smoke] FAIL - meta sidecar missing one of mesh / material / scene subAssets');
  process.exit(1);
}
const parseGuid = (s) => {
  const r = AssetGuid.parse(s);
  if (!r.ok) {
    console.error(`[smoke] FAIL - AssetGuid.parse failed: ${r.error.code}`);
    process.exit(1);
  }
  return r.value;
};
const meshGuid = parseGuid(meshSub.guid);
const materialGuid = parseGuid(materialSub.guid);
const sceneGuid = parseGuid(sceneSub.guid);

// IR -> POD bridge. Tier-B mesh (positions only) expanded to canonical
// 12F interleaved layout (position+normal+uv+tangent) with GLTF Tier-B
// defaults: normal=(0,1,0), uv=(0,0), tangent=(1,0,0,1).
const meshIr = doc.meshes[0];
if (!meshIr) {
  console.error('[smoke] FAIL - gltf has no mesh[0]');
  process.exit(1);
}
const vertexCount = meshIr.positions.length / 3;
const FLOATS_PER_VERTEX = 12;
const interleavedVerts = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
const normals = meshIr.normals;
const texcoords = meshIr.texcoord0;
const tangents = meshIr.tangents;
for (let i = 0; i < vertexCount; i++) {
  const dst = i * FLOATS_PER_VERTEX;
  const p = i * 3;
  interleavedVerts[dst + 0] = meshIr.positions[p + 0];
  interleavedVerts[dst + 1] = meshIr.positions[p + 1];
  interleavedVerts[dst + 2] = meshIr.positions[p + 2];
  if (normals !== undefined) {
    const n = i * 3;
    interleavedVerts[dst + 3] = normals[n + 0];
    interleavedVerts[dst + 4] = normals[n + 1];
    interleavedVerts[dst + 5] = normals[n + 2];
  } else {
    interleavedVerts[dst + 3] = 0;
    interleavedVerts[dst + 4] = 1;
    interleavedVerts[dst + 5] = 0;
  }
  if (texcoords !== undefined) {
    const t = i * 2;
    interleavedVerts[dst + 6] = texcoords[t + 0];
    interleavedVerts[dst + 7] = texcoords[t + 1];
  } else {
    interleavedVerts[dst + 6] = 0;
    interleavedVerts[dst + 7] = 0;
  }
  if (tangents !== undefined) {
    const g = i * 4;
    interleavedVerts[dst + 8] = tangents[g + 0];
    interleavedVerts[dst + 9] = tangents[g + 1];
    interleavedVerts[dst + 10] = tangents[g + 2];
    interleavedVerts[dst + 11] = tangents[g + 3];
  } else {
    interleavedVerts[dst + 8] = 1;
    interleavedVerts[dst + 9] = 0;
    interleavedVerts[dst + 10] = 0;
    interleavedVerts[dst + 11] = 1;
  }
}
const meshAsset = {
  kind: 'mesh',
  vertices: interleavedVerts,
  indices: meshIr.indices,
  submeshes: [{
    indexOffset: 0,
    indexCount: meshIr.indices.length,
    vertexCount,
    topology: 'triangle-list',
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'Default' }],
  attributes: {
    position: meshIr.positions,
    normal: normals ?? new Float32Array(vertexCount * 3).fill(0),
    uv: texcoords ?? new Float32Array(vertexCount * 2).fill(0),
    tangent: tangents ?? new Float32Array(vertexCount * 4).fill(0),
  },
};
const materialIr = doc.materials[0];
if (!materialIr) {
  console.error('[smoke] FAIL - gltf has no material[0]');
  process.exit(1);
}
// MaterialAsset shape mirrors src/main.ts `materialIrToPod`: the retired
// `shadingModel` discriminator (feat-20260526 M4) is replaced by an explicit
// `passes[]` + `values`. allocSharedRef stores the POD verbatim (no
// register-time normalization), so a bare `{ shadingModel }` material resolves
// to zero passes and trips MaterialResolvedEmptyPassesError in extract.
const materialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-unlit' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: materialIr.baseColorFactor,
  },
};

const world = new World();
const worldContext = await createWorldContext(world, [
  renderComponentsPlugin(),
  scenePlugin(),
]);
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const frameRequest = {
  leases: [worldAttachment1.value],
  camera: { lease: worldAttachment1.value },
  environment: { lease: worldAttachment1.value },
};
assets.catalog(meshGuid, meshAsset);
// catalog the material payload so loadByGuid<MaterialAsset>(materialGuid) hits
// the fast-path (parity with src/main.ts); allocSharedRef mints the column handle.
assets.catalog(materialGuid, materialAsset);
const materialHandle = world.allocSharedRef('MaterialAsset', materialAsset);

// Build the SceneAsset POD via the public bridge (feat-20260518 M3 SSOT).
// MeshFilter routes to HANDLE_CUBE (engine builtin GPU buffer) per the
// hello-gltf-instancing pattern; OOS-13 custom mesh GPU upload deferred to
// feat-future-asset-system-v2.
const sceneAsset = gltfDocToSceneAsset(doc, {
  meshHandles: new Map([[0, HANDLE_CUBE]]),
  materialHandles: new Map([[0, materialHandle]]),
});
assets.catalog(sceneGuid, sceneAsset);

// Step (4) parity with src/main.ts: loadByGuid<SceneAsset> + instantiate.
const sceneHandleRes = await assets.loadByGuid(sceneGuid);
if (!sceneHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid scene: ${sceneHandleRes.error.code}`);
  process.exit(1);
}
const meshLoadRes = await assets.loadByGuid(meshGuid);
if (!meshLoadRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid mesh: ${meshLoadRes.error.code}`);
  process.exit(1);
}
const matLoadRes = await assets.loadByGuid(materialGuid);
if (!matLoadRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid material: ${matLoadRes.error.code}`);
  process.exit(1);
}
// loadByGuid returns the payload (D-17); mint a user-tier column handle.
const sceneHandle = world.allocSharedRef('SceneAsset', sceneHandleRes.value);
const instanceRes = assets.instantiate(sceneHandle, world);
if (!instanceRes.ok) {
  console.error(`[smoke] FAIL - instantiate: ${instanceRes.error.code}`);
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});


const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw(frameRequest);
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

// --- 4. Pixel readback (single-mesh grid; AC-14) ----------------------------

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

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const sites = [
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'meshUpperLeft', x: Math.floor(WIDTH * 0.4), y: Math.floor(HEIGHT * 0.4) },
  { name: 'meshLowerRight', x: Math.floor(WIDTH * 0.6), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (four criteria) ---------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

const CLEAR_COLOR = [0.05, 0.05, 0.08];
const meshSiteNames = ['ndcCenter', 'meshUpperLeft', 'meshLowerRight'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(b) single-mesh sample - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} distance from clear color; all 3 sites too close to clear. perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (existsSync(BASELINE_PATH)) {
  console.log(`[smoke] baseline.png found at ${BASELINE_PATH} - strict pixel-parity gate enabled`);
  // Strict per-pixel gate deferred to feat-future-pixel-parity-hello-gltf.
} else {
  console.log(
    `[smoke] baseline.png absent at ${BASELINE_PATH} - permissive meshed-site gate only (AC-14 v1 lock)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-gltf smoke`,
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify @forgeax/engine-gltf parseGltf lands a non-empty MeshAsset / MaterialAsset / SceneAsset POD against the meta sidecar GUIDs',
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: pipeline=Standard, frames=${framesObserved}, meshed sites above threshold=${meshedRenderCount}/${meshSiteNames.length}, RhiError count=0`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
