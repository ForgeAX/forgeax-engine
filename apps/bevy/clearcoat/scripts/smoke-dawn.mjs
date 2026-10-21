#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { runSmokeAppFrames, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const errors = [];
const { create, globals } = await import('@forgeax/engine-dawn-node');
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
  renderTarget ??= device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x04 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
  return renderTarget;
}
const mockCanvas = {
  tagName: 'CANVAS', isConnected: true, width, height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return { configure(d) { ensureRenderTarget(d.device, d.format ?? 'rgba8unorm'); }, unconfigure() {}, getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); } };
  }, addEventListener() {}, removeEventListener() {},
};
const rafQueue = [];
globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { createDevImportTransport } = await import('@forgeax/engine-runtime');
const { buildClearcoatWorld } = await import(resolve(appRoot, 'src', 'clearcoat.ts'));
const distDir = resolve(appRoot, 'dist');
const packIndexWire = JSON.parse(readFileSync(resolve(distDir, 'pack-index.json'), 'utf8'));
const packIndex = decodeCatalogWire(packIndexWire).unwrap();
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
if (!hdrEntry) { console.error(`[smoke] missing HDR GUID ${hdrGuid}`); process.exit(1); }
const hdrPackagePath = hdrEntry.packageUrl.replace(/^\//, '');
const hdrPackageBytes = new Uint8Array(readFileSync(resolve(distDir, hdrPackagePath)));
const hdrPackage = JSON.parse(new TextDecoder().decode(hdrPackageBytes));
const hdrArtifactPath = hdrPackage.assets.find((asset) => asset.guid === hdrGuid).artifacts.body.path;
const hdrArtifactUrl = `${hdrEntry.packageUrl.slice(0, hdrEntry.packageUrl.lastIndexOf('/') + 1)}${hdrArtifactPath}`;
const hdrBytes = new Uint8Array(readFileSync(resolve(dirname(resolve(distDir, hdrPackagePath)), hdrArtifactPath)));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === '/pack-index.json') return { ok: true, json: () => Promise.resolve(packIndexWire), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  if (url === hdrEntry.packageUrl) return { ok: true, json: () => Promise.resolve(hdrPackage), arrayBuffer: () => Promise.resolve(hdrPackageBytes.buffer.slice(hdrPackageBytes.byteOffset, hdrPackageBytes.byteOffset + hdrPackageBytes.byteLength)) };
  if (url === hdrArtifactUrl) return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(hdrBytes.buffer.slice(hdrBytes.byteOffset, hdrBytes.byteOffset + hdrBytes.byteLength)) };
  if (typeof url === 'string' && url.startsWith('/')) {
    return new Response(readFileSync(resolve(distDir, `.${url}`)));
  }
  return originalFetch(url);
};
const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) { console.error(`[smoke] createApp failed: ${appResult.error.code}`); process.exit(1); }
const app = appResult.value;
subscribeSmokeErrors(app.renderer, (error) => errors.push(error));
app.onError((error) => errors.push(error));
const guid = AssetGuid.parse(hdrGuid);
if (!guid.ok) { console.error(`[smoke] GUID parse failed: ${guid.error.code}`); process.exit(1); }
app.assets.configurePackIndex('/pack-index.json');
const hdr = await app.assets.load(guid.value, 'equirect');
if (!hdr.ok) { console.error(`[smoke] HDR load failed: ${hdr.error.code}`); process.exit(1); }
const equirect = hdr.value;
await buildClearcoatWorld(app.world, app.assets, equirect, width / height);
const frameStartTimestamp = performance.now();
let callbacks = 0;
const frames = await runSmokeAppFrames(app, () => {
  const callback = rafQueue.shift();
  if (!callback) return false;
  callback(frameStartTimestamp + callbacks++ * 16.67);
  return true;
}, targetFrames);
await sharedDevice.queue.onSubmittedWorkDone();
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
sharedDevice.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const mapped = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap(); readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true }); writeFileSync(pngOut, encodePng(width, height, tight));
const lumaAt = (x, y) => ((tight[(y * width + x) * 4] ?? 0) * 0.299 + (tight[(y * width + x) * 4 + 1] ?? 0) * 0.587 + (tight[(y * width + x) * 4 + 2] ?? 0) * 0.114) / 255;
const patchMean = (x0, x1, y0, y1) => { let sum = 0; let count = 0; for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += lumaAt(x, y); count += 1; } return sum / count; };
const leftLuma = patchMean(45, 125, 45, 145);
const rightLuma = patchMean(195, 275, 45, 145);
let maxLuma = 0;
for (let i = 0; i < tight.length; i += 4) maxLuma = Math.max(maxLuma, lumaAt(i / 4 % width, Math.floor(i / 4 / width)));
const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
if (maxLuma <= 0.02) failures.push(`clearcoat scene is dark: maxLuma=${maxLuma.toFixed(4)}`);
if (Math.abs(leftLuma - rightLuma) <= 0.001) failures.push(`coat contrast missing: left=${leftLuma.toFixed(4)} right=${rightLuma.toFixed(4)}`);
console.log(`[smoke] backend=${rendererBackend(app.renderer)} frames=${frames} leftLuma=${leftLuma.toFixed(4)} rightLuma=${rightLuma.toFixed(4)} png=${pngOut}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(1);
}
console.log('[smoke] PASS - coated and uncoated PBR spheres rendered with measurable contrast and zero engine errors');
sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(0);
