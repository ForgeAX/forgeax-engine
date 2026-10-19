#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { runSmokeAppFrames, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy's 3d/skybox reproduction.
// FALSIFY=remove-skybox removes the component and must remove the skybox pass.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const falsify = process.env.FALSIFY ?? '';
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const errors = [];

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - webgpu import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) { ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = rafId++;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { createDevImportTransport } = await import('@forgeax/engine-runtime');
const { buildSkyboxWorld } = await import(pathToFileURL(resolve(appRoot, 'src', 'skybox.ts')));

const distDir = resolve(appRoot, 'dist');
const packIndexPath = resolve(distDir, 'pack-index.json');
let packIndexWire;
let packIndex;
try {
  packIndexWire = JSON.parse(readFileSync(packIndexPath, 'utf8'));
  packIndex = decodeCatalogWire(packIndexWire).unwrap();
} catch (error) {
  console.error(`[smoke] FAIL - cannot read ${packIndexPath}; run the demo build first: ${error}`);
  process.exit(1);
}
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
if (!hdrEntry) {
  console.error(`[smoke] FAIL - HDR GUID ${hdrGuid} is absent from ${packIndexPath}`);
  process.exit(1);
}
const hdrPackagePath = hdrEntry.packageUrl.replace(/^\//, '');
const hdrPackageBytes = new Uint8Array(readFileSync(resolve(distDir, hdrPackagePath)));
const hdrPackage = JSON.parse(new TextDecoder().decode(hdrPackageBytes));
const hdrAsset = hdrPackage.assets.find((asset) => asset.guid === hdrGuid);
if (!hdrAsset) {
  console.error(`[smoke] FAIL - HDR GUID ${hdrGuid} is absent from ${hdrEntry.packageUrl}`);
  process.exit(1);
}
const hdrArtifactPath = hdrAsset.artifacts.body.path;
const hdrArtifactUrl = `${hdrEntry.packageUrl.slice(0, hdrEntry.packageUrl.lastIndexOf('/') + 1)}${hdrArtifactPath}`;
const hdrBytes = new Uint8Array(
  readFileSync(resolve(dirname(resolve(distDir, hdrPackagePath)), hdrArtifactPath)),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === '/pack-index.json') {
    return { ok: true, json: () => Promise.resolve(packIndexWire), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  }
  if (url === hdrEntry.packageUrl) {
    return {
      ok: true,
      json: () => Promise.resolve(hdrPackage),
      arrayBuffer: () => Promise.resolve(hdrPackageBytes.buffer.slice(hdrPackageBytes.byteOffset, hdrPackageBytes.byteOffset + hdrPackageBytes.byteLength)),
    };
  }
  if (url === hdrArtifactUrl) {
    const buffer = new ArrayBuffer(hdrBytes.byteLength);
    new Uint8Array(buffer).set(hdrBytes);
    return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(buffer) };
  }
  return originalFetch(url);
};

const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) {
  console.error(`[smoke] FAIL - createApp: ${appResult.error.code} - ${appResult.error.hint}`);
  process.exit(1);
}
const app = appResult.value;
subscribeSmokeErrors(app.renderer, (error) => errors.push(error));
app.onError((error) => errors.push(error));

const guidResult = AssetGuid.parse(hdrGuid);
if (!guidResult.ok) {
  console.error(`[smoke] FAIL - AssetGuid.parse: ${guidResult.error.code}`);
  process.exit(1);
}
const assets = app.assets;
assets.configurePackIndex('/pack-index.json');
const hdrResult = await assets.loadByGuid(guidResult.value);
if (!hdrResult.ok) {
  console.error(`[smoke] FAIL - loadByGuid HDR: ${hdrResult.error.code} - ${hdrResult.error.hint}`);
  process.exit(1);
}

const world = app.world;
const equirect = world.allocSharedRef('EquirectAsset', hdrResult.value);
buildSkyboxWorld(world, equirect, width / height, { includeSkybox: falsify !== 'remove-skybox' });

const frameStartTimestamp = performance.now();
let callbacks = 0;
const frames = await runSmokeAppFrames(app, () => {
  const due = rafQueue.shift();
  if (!due) return false;
  due.callback(frameStartTimestamp + callbacks++ * 16.67);
  return true;
}, targetFrames);
await sharedDevice.queue.onSubmittedWorkDone();
const passNames = [...app.renderer.inspect().perFramePassNames];

const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: renderTarget },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height, depthOrArrayLayers: 1 },
);
sharedDevice.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const mapped = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, encodePng(width, height, tight));

let maxLuma = 0;
for (let i = 0; i < tight.length; i += 4) {
  maxLuma = Math.max(maxLuma, ((tight[i] ?? 0) * 0.299 + (tight[i + 1] ?? 0) * 0.587 + (tight[i + 2] ?? 0) * 0.114) / 255);
}
const hasSkybox = passNames.includes('skybox');
const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
if (falsify !== 'remove-skybox' && !hasSkybox) failures.push(`skybox pass missing: ${JSON.stringify(passNames)}`);
if (maxLuma <= 0.02) failures.push(`${falsify === 'remove-skybox' ? 'FALSIFY removed skybox and darkened frame' : 'HDR skybox is dark'}: maxLuma=${maxLuma.toFixed(4)}`);
console.log(`[smoke] backend=${rendererBackend(app.renderer)}`);
console.log(`[smoke] frames=${frames} passNames=${JSON.stringify(passNames)} maxLuma=${maxLuma.toFixed(4)} png=${pngOut}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('[smoke] PASS - HDR skybox rendered with zero engine errors');
process.exit(0);
