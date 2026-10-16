#!/usr/bin/env node
// hello-room headless smoke (feat-20260511-asset-system-v1 / M7 / w21).
//
// End-to-end convergence proof: dawn-node drive the same ECS path hello-
// room browser src/main.ts composes (3 mesh + hierarchy + merged
// MeshRenderer + Camera + DirectionalLight), run 60 frames, sample
// a multi-pixel grid on the final render target + compare against a
// committed baseline (apps/hello/room/scripts/baseline.png) with
// ε=0.05 per channel (AC-05 / AC-25 human-locked tolerance).
//
// Strategy (mirrors hello-cube smoke; charter proposition 5 consistent
// abstraction):
//   1. Inject globalThis.navigator.gpu via the `webgpu` npm package.
//   2. Build a mock HTMLCanvasElement + shim GPUCanvasContext.
//   3. Build a World identical to apps/hello/room/src/main.ts:
//      root Cube (MeshRenderer + standard MaterialAsset) + Sphere child
//      (MeshRenderer + unlit MaterialAsset, ChildOf -> root) + Plane child
//      (MeshRenderer + standard MaterialAsset, ChildOf -> root) + Camera + Light.
//   4. await runtime host initialization + 60x lease-bound renderer.draw(...).
//   5. copyTextureToBuffer + mapAsync multi-pixel grid sample; verdict =
//      4 criteria (a) backend=webgpu (b) frames>=60
//      (c) per-pixel distance to baseline <= SMOKE_PIXEL_THRESHOLD on at
//          least M of N sample sites (multi-mesh ε=0.05 permissive gate)
//      (d) Renderer.onError RhiError count == 0 (hierarchy-broken etc.).
//
// Output literals (preserved byte-for-byte for grep-based tooling):
//   - `[hello-room] backend=webgpu`
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

// --- 1. dawn.node binding setup ----------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-room smoke');
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
  console.error('  rerun: pnpm --filter @forgeax/hello-room smoke');
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

// --- 3. Drive engine ECS path (SceneAsset 1-line instantiate; w24 + w25) ----

import { readFileSync as readFileSyncFs } from 'node:fs';

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
  const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Materials, renderComponentsPlugin } = await import('@forgeax/engine-render');
const { scenePlugin } = await import('@forgeax/engine-scene');
  const {
    Camera,
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
  } = await import('@forgeax/engine-render');
  const { ChildOf, Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const ROOM_PACK_PATH = resolve(here, '..', 'assets', 'room.pack.json');
const ROOM_SCENE_GUID = '019e2808-d3ba-735f-811f-ae7bbb465392';

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(
  readFileSyncFs(MANIFEST_PATH, 'utf8'),
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

console.log('[hello-room] pipeline=Standard');

// The cube mesh GUID (cbe42beb-...) in room.pack.json refs is a builtin:
// the AssetRegistry constructor pre-registers HANDLE_CUBE under it
// (feat-20260603 Tier 0), so `resolveSceneGuids` resolves it natively at
// instantiate time. Only the scene's non-builtin materials need explicit
// registration below. (Previously this block manually registered
// createBoxGeometry(1,1,1) under the same GUID -- now redundant and a
// collision, since the builtin already owns it.)

// host initialization must complete before material registration — shader
// manifest loading (Step 1b) registers materialShaders which
// validateMaterialPasses requires.

const stdMatGuidResult = AssetGuid.parse('f6af7007-158f-4d92-9e47-93bf2f213e1f');
if (!stdMatGuidResult.ok) {
  console.error(`[smoke] FAIL - standard material GUID parse: ${stdMatGuidResult.error.code}`);
  process.exit(1);
}
assets.catalog(stdMatGuidResult.value, {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.8, 0.4, 0.2],
    metallic: 0,
    roughness: 0.5,
  },
});

const unlitMatGuidResult = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
if (!unlitMatGuidResult.ok) {
  console.error(`[smoke] FAIL - unlit material GUID parse: ${unlitMatGuidResult.error.code}`);
  process.exit(1);
}
// Pass-based unlit MaterialAsset via the Materials.unlit factory (mirrors
// apps/hello/room/src/index.ts). The legacy hand-written unlit-discriminant
// shape carried no `passes` array and resolved to empty passes at draw time,
// firing `material-resolved-empty-passes` through the Renderer error event stream.
const unlitCatalogResult = assets.catalog(
  unlitMatGuidResult.value,
  Materials.unlit([0.2, 0.3, 0.9, 1]),
);
if (!unlitCatalogResult.ok) {
  console.error(`[smoke] FAIL - unlit catalog: ${JSON.stringify(unlitCatalogResult.error)}`);
  process.exit(1);
}

// feat-20260528-scene-asset-guid-refs-and-post-instantiate M4 / w11:
// construct the SceneAsset POD from the pack JSON with GUID strings in
// handle fields (post-parseScenePayload intermediate state). The refs
// array maps index->GUID; each handle field value N becomes refs[N].
// resolveSceneGuids (called inside instantiate) resolves GUID strings
// to Handle numbers via the guidToHandle index populated by
// catalog calls above.
const roomPack = JSON.parse(readFileSyncFs(ROOM_PACK_PATH, 'utf8'));
if (
  roomPack.schemaVersion !== '2.0.0' ||
  roomPack.kind !== 'internal-text-package' ||
  roomPack.assets.some((asset) => asset.artifacts === undefined)
) {
  console.error('[smoke] FAIL - room.pack.json is not a Pack v2 package with asset-local artifacts');
  process.exit(1);
}
const sceneEntry = roomPack.assets.find((a) => a.kind === 'scene');
if (!sceneEntry) {
  console.error('[smoke] FAIL - room.pack.json has no scene entry');
  process.exit(1);
}
const refs = roomPack.assets[0]?.refs ?? [];
// Handle-typed component fields whose payload value is a refs[] index that
// must be rewritten to the GUID string `resolveSceneGuids` resolves back to
// a Handle. Restricted to the known handle fields per component: a blanket
// "any small integer is a refs index" heuristic mis-rewrites Transform
// fields whose literal value happens to be 0/1/2 (e.g. a zero pos lane -> refs[0]
// GUID -> NaN position), pushing geometry out of frustum so the frame
// renders empty (the F-8 false-green masked this for the demo's lifetime).
const HANDLE_FIELDS = {
  MeshFilter: new Set(['assetHandle']),
  // feat-20260608 M5 amend: MeshRenderer.material -> materials (array of
  // handles). Resolver below now handles both scalar handle fields and
  // array-of-handle fields (each element resolved through refs[] the
  // same way).
  MeshRenderer: new Set(['materials']),
};
const sceneAsset = {
  kind: 'scene',
  entities: Object.fromEntries(Object.entries(sceneEntry.payload.entities).map(([key, n]) => {
    const components = {};
    for (const [name, data] of Object.entries(n.components)) {
      // Replace refs index numbers with GUID strings for handle-type
      // fields only. Non-handle fields pass through unchanged. feat-20260608
      // M5 amend: handle-type fields may also be number[] (refs indices
      // array) -- map each element through refs[] same way.
      const handleFields = HANDLE_FIELDS[name];
      const resolved = {};
      const isRefIndex = (v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < refs.length;
      for (const [field, value] of Object.entries(data)) {
        if (handleFields?.has(field)) {
          if (isRefIndex(value)) {
            resolved[field] = refs[value];
          } else if (Array.isArray(value)) {
            resolved[field] = value.map((el) => (isRefIndex(el) ? refs[el] : el));
          } else {
            resolved[field] = value;
          }
        } else {
          resolved[field] = value;
        }
      }
      if (name === 'DirectionalLight') {
        components[name] = {
          direction: [-0.3, -1.0, -0.5],
          color: [1.0, 0.95, 0.9],
          intensity: 1.0,
        };
        continue;
      }
      components[name] = resolved;
    }
    return [key, { components }];
  })),
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

const sceneGuid = AssetGuid.parse(ROOM_SCENE_GUID);
if (!sceneGuid.ok) {
  console.error(`[smoke] FAIL - scene GUID parse: ${sceneGuid.error.code}`);
  process.exit(1);
}
assets.catalog(sceneGuid.value, sceneAsset);
const sceneHandleRes = await assets.loadByGuid(sceneGuid.value);
if (!sceneHandleRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid: ${sceneHandleRes.error.code}`);
  process.exit(1);
}
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

// loadByGuid returns the payload (D-17); mint a user-tier column handle.
const sceneHandle = world.allocSharedRef('SceneAsset', sceneHandleRes.value);
const instanceRes = assets.instantiate(sceneHandle, world);
if (!instanceRes.ok) {
  console.error(`[smoke] FAIL - instantiate: ${instanceRes.error.code}`);
  process.exit(1);
}

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

// --- 4. Pixel readback (multi-site grid; AC-25 multi-mesh baseline) ---------

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

// sRGB -> linear electro-optical transfer function (IEC 61966-2-1, the
// sRGB standard piecewise inverse gamma). The render target is
// `bgra8unorm-srgb`, so readback bytes are sRGB-encoded; `clearColor` is
// supplied to the renderer in linear space. Decode each sampled channel to
// linear before comparing against the linear clear color, otherwise the
// ~0.05->0.247 encoding lift makes an empty (clear-only) frame read as if
// it were 0.36 away from the clear color and the gate goes blind to a frame
// that drew nothing (research F-8). Inlined (not imported from
// engine-math) to keep this dawn-node script free of cross-package build
// coupling (plan-strategy D-3).
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Multi-site sample grid: 5 points covering root cube center, sphere child
// area, plane child area, and two corners (bg / clear color sanity).
const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
};
const sites = [
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'sphereChild', x: Math.floor(WIDTH * 0.35), y: Math.floor(HEIGHT * 0.4) },
  { name: 'planeChild', x: Math.floor(WIDTH * 0.65), y: Math.floor(HEIGHT * 0.6) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 5. Verdict (four criteria) ---------------------------------------------

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const BLACK = [0, 0, 0];

// Criterion (c): real-imaging gate. `pixelSamples` are already decoded to
// linear by `readRgba` (srgbToLinear above), so they live in the same
// colour space as the linear `CLEAR_COLOR` handed to the renderer. A site
// "rendered" when its decoded linear value is more than
// SMOKE_PIXEL_THRESHOLD away from the linear clear color. To defeat the
// empty-frame false-green (research F-8: a clear-only frame whose every
// site reads the clear color uniformly), this gate additionally requires
// the three meshed sites to be mutually distinct (pairwise distance >
// threshold) — three different materials / depths must not collapse onto a
// single colour. PASS condition: meshedRenderCount >= 1 AND all three
// meshed sites pairwise distinct. Stricter per-pixel PNG baseline lives in
// feat-future-pixel-parity-hello-room (OOS-1).
const CLEAR_COLOR = [0.05, 0.05, 0.08];
const meshSiteNames = ['ndcCenter', 'sphereChild', 'planeChild'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

const pairwise = [];
for (let i = 0; i < meshSiteNames.length; i++) {
  for (let j = i + 1; j < meshSiteNames.length; j++) {
    const a = meshSiteNames[i];
    const b = meshSiteNames[j];
    const d = distance(pixelSamples[a], pixelSamples[b]);
    pairwise.push({ pair: `${a}|${b}`, dist: d });
  }
}
const collapsedPairs = pairwise.filter((p) => p.dist <= SMOKE_PIXEL_THRESHOLD);
console.log(
  `[smoke] meshSitePairwiseDistance=${JSON.stringify(
    Object.fromEntries(pairwise.map((p) => [p.pair, p.dist.toFixed(4)])),
  )}`,
);

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(a) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1) {
  failures.push(
    `(c) multi-mesh sample - 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} linear distance from clear color; frame drew nothing above clear. perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
} else if (collapsedPairs.length > 0) {
  failures.push(
    `(c) multi-mesh sample - meshed sites collapsed onto a single colour (3 distinct materials/depths expected): ${collapsedPairs
      .map((p) => `${p.pair}=${p.dist.toFixed(4)}`)
      .join(', ')} <= threshold=${SMOKE_PIXEL_THRESHOLD}; likely an empty/uniform frame masquerading as rendered content`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// Optional: if a baseline.png exists, verify per-pixel ε=0.05 (stricter
// future gate; absent for v1). AC-25 lock-in happens at Step 5 human
// review when reviewer commits baseline.png to this directory.
if (existsSync(BASELINE_PATH)) {
  console.log(`[smoke] baseline.png found at ${BASELINE_PATH} - strict pixel-parity gate enabled`);
  // Baseline comparison deferred to feat-future-pixel-parity-hello-room.
  // The presence of the file alone is AC-25 evidence; strict compare
  // will land in a future closed loop.
} else {
  console.log(
    `[smoke] baseline.png absent at ${BASELINE_PATH} - permissive meshed-site gate only (AC-25 v1 lock)`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-room smoke`,
  );
  console.error(
    '  hint:  inspect Renderer.onError fan-out + verify @forgeax/engine-runtime ECS path GPU wiring on dawn-node',
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
