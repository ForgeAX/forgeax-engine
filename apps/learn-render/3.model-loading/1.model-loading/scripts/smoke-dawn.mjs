#!/usr/bin/env node
import testQuality from '../../../../../scripts/test/render-quality.json' with { type: 'json' };
import { decodeCatalogWire } from '@forgeax/engine-pack';
// learn-render 3.1 model-loading dawn-node smoke.
//
// The smoke loads Sponza via the canonical load path
// (configurePackIndex + load + instantiate), mirroring
// production and the demo's src/index.ts. The HDR Skylight also loads via
// load.
//
// A thin static file server (globalThis.fetch monkeypatch) serves every
// sub-asset from the built dist/ directory as-is, so load resolves the
// scene + its full cross-ref graph without a dev server. The build already
// decoded textures to RGBA .bin; the smoke reads those pre-decoded bins
// directly — no on-the-fly decode, same path as production.
//
// Verdict criteria:
//   (a) backend=webgpu (dawn-node bound the WebGPU adapter)
//   (b) frames>=60 (the standard smoke gate)
//   (c) Renderer error event fired 0 times for RhiError / RuntimeError / EcsError
//       families (the production crash channel)
//   (d) console.error fired 0 times during render
//
// Falsification (FALSIFY=wrong-guid): load with a deliberately-wrong
// SceneAsset GUID must return an error and the smoke must exit non-zero.
//   FALSIFY=wrong-guid pnpm -F @forgeax/app-learn-render-3-model-loading-1-model-loading smoke

import { readCatalogRows } from '@forgeax/engine-types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const FALSIFY = process.env.FALSIFY ?? '';

const WIDTH = 200;
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(here, '..', 'dist');
const SPONZA_SCENE_GUID = '019e4fe2-523b-7506-99e5-ccd39795ecda';
const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const FALSIFY_WRONG_GUID = FALSIFY === 'wrong-guid';

// --- 1. dawn.node binding setup --------------------------------------------

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
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
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

// --- 2. Mock canvas with offscreen render target --------------------------

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

// --- 3. Load Sponza + HDR via canonical load path -------------------

// 3a. Read pack-index, build URL maps.
const PACK_INDEX_PATH = resolve(DIST_DIR, 'pack-index.json');
let packIndexWire;
let packIndexJson;
try {
  packIndexWire = JSON.parse(readFileSync(PACK_INDEX_PATH, 'utf8'));
  packIndexJson = decodeCatalogWire(packIndexWire).unwrap();
} catch (err) {
  console.error(`[smoke] FAIL - cannot read pack-index at ${PACK_INDEX_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Build: URL -> disk path. Artifact URLs are registered from the pack
// descriptor when that pack is fetched; the smoke therefore exercises the
// same package-relative resolution contract as the runtime.
const packIndexRows = readCatalogRows(packIndexJson);
if (packIndexRows === undefined) throw new Error('Invalid published Catalog');
const urlToPath = new Map();
for (const entry of packIndexRows) {
  if (!urlToPath.has(entry.packageUrl)) {
    urlToPath.set(entry.packageUrl, resolve(DIST_DIR, entry.packageUrl.replace(/^\//, '')));
  }
}
console.log(`[smoke] pack-index: ${packIndexRows.length} entries, ${urlToPath.size} URLs`);

const MANIFEST_PATH = resolve(DIST_DIR, 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { renderComponentsPlugin, Skylight } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, PointLight } = await import('@forgeax/engine-render');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

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
  console.error(`[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[learn-render 3.1 smoke] Standard host constructed');

const world = new World({ assets: assets });
const worldContext = await createWorldContext(world, [
  renderComponentsPlugin(),
  scenePlugin(),
]);
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;

// 3b. Find HDR entry.
const hdrEntry = packIndexRows.find((e) => e.guid === NEWPORT_LOFT_GUID);
if (!hdrEntry) {
  console.error(`[smoke] FAIL - HDR GUID ${NEWPORT_LOFT_GUID} not found in pack-index`);
  process.exit(1);
}
console.log(`[smoke] HDR pack-index entry: kind=${hdrEntry.kind} format=${hdrEntry.metadata?.format} ${hdrEntry.metadata?.width}x${hdrEntry.metadata?.height}`);

// 3c. Install fetch monkeypatch: thin static file server over dist/.
//
// - /pack-index.json: served from memory.
// - .pack.json files: read from dist/, return parsed JSON.
// - All .bin files: read pre-decoded bytes from dist/ as-is.
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
  const urlStr = typeof url === 'string' ? url : String(url);

  if (urlStr === '/pack-index.json') {
    return { ok: true, json: () => Promise.resolve(packIndexWire), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  }

  const filePath = urlToPath.get(urlStr);
  if (!filePath) {
    console.error(`[smoke] fetch miss: ${urlStr}`);
    return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  }

  // .pack.json files.
  if (urlStr.endsWith('.json')) {
    let buf;
    try {
      buf = readFileSync(filePath);
    } catch {
      return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
    }
    const text = new TextDecoder().decode(buf);
    const pack = JSON.parse(text);
    const packageDirectory = urlStr.slice(0, urlStr.lastIndexOf('/') + 1);
    const packageDirectoryPath = dirname(filePath);
    for (const asset of pack.assets ?? []) {
      for (const descriptor of Object.values(asset.artifacts ?? {})) {
        if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.path !== 'string') {
          continue;
        }
        const artifactUrl = `${packageDirectory}${descriptor.path.replace(/^\/+/, '')}`;
        urlToPath.set(artifactUrl, resolve(packageDirectoryPath, descriptor.path));
      }
    }
    return {
      ok: true,
      json: () => Promise.resolve(pack),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  // All .bin files (texture, mesh, scene, HDR, embedded).
  return {
    ok: true,
    json: () => Promise.resolve({}),
    arrayBuffer: async () => {
      let buf;
      try {
        buf = readFileSync(filePath);
      } catch {
        throw new Error(`ENOENT: no such file, open '${filePath}'`);
      }
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
  };
};

// 3d. Configure the catalog, load a managed scene handle, then instantiate.
assets.configurePackIndex('/pack-index.json');

const sceneGuidStr = FALSIFY_WRONG_GUID ? '00000000-0000-0000-0000-000000000000' : SPONZA_SCENE_GUID;
if (FALSIFY_WRONG_GUID) {
  console.warn('[smoke] FALSIFY=wrong-guid: loading a deliberately-wrong SceneAsset GUID');
}

const loadStart = Date.now();
const sceneGuidRes = AssetGuid.parse(sceneGuidStr);
if (!sceneGuidRes.ok) {
  console.error(`[smoke] FAIL - AssetGuid.parse(scene): ${sceneGuidRes.error.code}`);
  process.exit(1);
}

const sceneRes = await assets.load(sceneGuidRes.value, 'scene');
if (!sceneRes.ok) {
  if (FALSIFY_WRONG_GUID) {
    console.error(`[smoke] FALSIFY=wrong-guid PASS - load correctly failed: ${sceneRes.error.code} (exit non-zero proves gate is falsifiable)`);
    process.exit(1);
  }
  console.error('[smoke] FAIL - assets.load(scene):', sceneRes.error);
  process.exit(1);
}

if (FALSIFY_WRONG_GUID) {
  console.error('[smoke] FALSIFY=wrong-guid BROKEN - load succeeded with wrong GUID (gate is NOT falsifiable)');
  process.exit(1);
}

const sceneHandle = sceneRes.value;
const instRes = assets.instantiate(sceneHandle, world);
if (!instRes.ok) {
  console.error(`[smoke] FAIL - scene instantiate: ${instRes.error.code}`);
  process.exit(1);
}
const loadWall = Date.now() - loadStart;
console.log(`[smoke] Sponza scene instantiated via load (load wall=${loadWall}ms)`);

// 3e. HDR Skylight.
const hdrGuidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
if (!hdrGuidRes.ok) {
  console.error(`[smoke] FAIL - AssetGuid.parse(HDR): ${hdrGuidRes.error.code}`);
  process.exit(1);
}

const hdrPodRes = await assets.load(hdrGuidRes.value, 'equirect');
if (!hdrPodRes.ok) {
  console.error(`[smoke] FAIL - load(HDR): ${hdrPodRes.error.code} - ${hdrPodRes.error.hint ?? ''}`);
  process.exit(1);
}
const hdrPod = assets.read(hdrPodRes.value).unwrap();
// Skylight consumes the loaded handle; the read snapshot above is only for
// metadata reporting. The renderer prepares its cubemap and IBL projection.
const equirect = hdrPodRes.value;

world.spawn({
  component: Skylight,
  data: { equirect, intensity: 1.0 },
});
console.log(`[smoke] HDR load + Skylight spawn OK (format=${hdrPod.format} ${hdrPod.width}x${hdrPod.height})`);

globalThis.fetch = originalFetch;

// --- 4. Spawn lights + camera (mirror src/main.ts) ------------------------

const d = [-0.3, -1.0, -0.3];
const invLen = 1 / Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
world.spawn(
  { component: DirectionalLight, data: { castShadow: true,
    direction: [d[0] * invLen, d[1] * invLen, d[2] * invLen],
    color: [1.0, 0.95, 0.85], intensity: 3.0,
    mapSize: testQuality.shadowMapSize, shadowDistance: 36, depthBias: 0.00001,
  } },
);

const pointDefs = [
  { pos: [-6.4, 1.6, 0], color: [1.0, 0.85, 0.5], intensity: 32, range: 20 },
  { pos: [6.4, 1.6, 0], color: [0.4, 0.85, 1.0], intensity: 32, range: 20 },
  { pos: [0, 1.6, -3.2], color: [0.95, 0.4, 0.85], intensity: 32, range: 20 },
  { pos: [0, 1.6, 3.2], color: [1.0, 1.0, 1.0], intensity: 32, range: 20 },
];
for (const pd of pointDefs) {
  world.spawn(
    { component: Transform, data: { pos: [pd.pos[0], pd.pos[1], pd.pos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
    { component: PointLight, data: { color: [pd.color[0], pd.color[1], pd.color[2]],
      intensity: pd.intensity, range: pd.range } },
  );
}

world.spawn(
  { component: Transform, data: { pos: [-11, 1.6, -0.4], quat: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.08, far: 120 } },
);

// --- 5. Wire error capture ------------------------------------------------

const errors = [];
const consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
  originalConsoleError(...args);
};
renderer.subscribe((event) => { if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint }); });


// --- 6. Run frames -------------------------------------------------------

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
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
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms)`);

// --- 7. Pixel readback ----------------------------------------------------

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
const pixelBytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readBgra = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const b = (pixelBytes[off + 0] ?? 0) / 255;
  const g = (pixelBytes[off + 1] ?? 0) / 255;
  const r = (pixelBytes[off + 2] ?? 0) / 255;
  return [r, g, b];
};
const sites = [
  { name: 'atriumCenter', x: Math.floor(WIDTH * 0.5), y: Math.floor(HEIGHT * 0.55) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readBgra(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 8. Verdict -----------------------------------------------------------

const failures = [];
if (assets === undefined) failures.push('(a) host asset owner is unavailable');
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
const rhiErrors = errors.filter((e) =>
  e.code.startsWith('rhi-') || e.code.startsWith('runtime-') || e.code.startsWith('ecs-'));
if (rhiErrors.length > 0) {
  failures.push(`(c) Renderer.onError fired ${rhiErrors.length} times: [${rhiErrors.map((e) => e.code).join(', ')}]`);
}
const renderConsoleErrors = consoleErrors.filter((line) => !line.startsWith('[smoke]'));
if (renderConsoleErrors.length > 0) {
  failures.push(
    `(d) console.error fired ${renderConsoleErrors.length} times during render: [${renderConsoleErrors.slice(0, 3).join(' | ').slice(0, 300)}]`,
  );
}
void SMOKE_PIXEL_THRESHOLD;

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  device?.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - ${framesObserved} frames, Standard host`);
device?.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
