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
const tintGuid = '019e3969-1d46-79d1-9d22-ffd8c6859c64';
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
  adapter.requestDevice = async (descriptor) => { const device = await originalRequestDevice(descriptor); sharedDevice ??= device; return device; };
  return adapter;
};
let renderTarget;
function ensureRenderTarget(device, format) { renderTarget ??= device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format, usage: 0x10 | 0x04 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); return renderTarget; }
const mockCanvas = { tagName: 'CANVAS', isConnected: true, width, height, getContext(kind) { if (kind !== 'webgpu') return null; return { configure(d) { ensureRenderTarget(d.device, d.format ?? 'rgba8unorm'); }, unconfigure() {}, getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); } }; }, addEventListener() {}, removeEventListener() {} };
const rafQueue = [];
globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { createDevImportTransport } = await import('@forgeax/engine-runtime');
const { buildSpecularTintWorld } = await import(resolve(appRoot, 'src', 'specular-tint.ts'));
const distDir = resolve(appRoot, 'dist');
const packIndexWire = JSON.parse(readFileSync(resolve(distDir, 'pack-index.json'), 'utf8'));
const packIndex = decodeCatalogWire(packIndexWire).unwrap();
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
const tintEntry = packIndex.find((entry) => entry.guid === tintGuid);
if (!hdrEntry || !tintEntry) { console.error('[smoke] missing specular tint assets'); process.exit(1); }
const packageData = (entry) => {
  const packagePath = entry.packageUrl.replace(/^\//, '');
  const packageBytes = new Uint8Array(readFileSync(resolve(distDir, packagePath)));
  const pack = JSON.parse(new TextDecoder().decode(packageBytes));
  const asset = pack.assets.find((candidate) => candidate.guid === entry.guid);
  const artifactPath = asset.artifacts.body.path;
  return {
    packageBytes,
    pack,
    artifactUrl: `${entry.packageUrl.slice(0, entry.packageUrl.lastIndexOf('/') + 1)}${artifactPath}`,
    bytes: new Uint8Array(readFileSync(resolve(dirname(resolve(distDir, packagePath)), artifactPath))),
  };
};
const hdrData = packageData(hdrEntry); const tintData = packageData(tintEntry);
const hdrBytes = hdrData.bytes; const tintBytes = tintData.bytes;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === '/pack-index.json') return { ok: true, json: () => Promise.resolve(packIndexWire), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  if (url === hdrEntry.packageUrl) return { ok: true, json: () => Promise.resolve(hdrData.pack), arrayBuffer: () => Promise.resolve(hdrData.packageBytes.buffer.slice(hdrData.packageBytes.byteOffset, hdrData.packageBytes.byteOffset + hdrData.packageBytes.byteLength)) };
  if (url === hdrData.artifactUrl) return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(hdrBytes.buffer.slice(hdrBytes.byteOffset, hdrBytes.byteOffset + hdrBytes.byteLength)) };
  if (url === tintEntry.packageUrl) return { ok: true, json: () => Promise.resolve(tintData.pack), arrayBuffer: () => Promise.resolve(tintData.packageBytes.buffer.slice(tintData.packageBytes.byteOffset, tintData.packageBytes.byteOffset + tintData.packageBytes.byteLength)) };
  if (url === tintData.artifactUrl) return { ok: true, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(tintBytes.buffer.slice(tintBytes.byteOffset, tintBytes.byteOffset + tintBytes.byteLength)) };
  return originalFetch(url);
};
const appResult = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) { console.error(`[smoke] createApp failed: ${appResult.error.code}`); process.exit(1); }
const app = appResult.value;
subscribeSmokeErrors(app.renderer, (error) => errors.push(error)); app.onError((error) => errors.push(error));
const hdrParsed = AssetGuid.parse(hdrGuid); const tintParsed = AssetGuid.parse(tintGuid);
if (!hdrParsed.ok || !tintParsed.ok) { console.error('[smoke] GUID parse failed'); process.exit(1); }
app.assets.configurePackIndex('/pack-index.json');
const hdr = await app.assets.load(hdrParsed.value, 'equirect'); const tint = await app.assets.load(tintParsed.value, 'texture');
if (!hdr.ok || !tint.ok) { console.error(`[smoke] asset load failed: ${hdr.ok ? tint.error.code : hdr.error.code}`); process.exit(1); }
const equirect = hdr.value;
const texture = tint.value;
buildSpecularTintWorld(app.world, equirect, texture, width / height);
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
sharedDevice.queue.submit([encoder.finish()]); await readback.mapAsync(0x01);
const mapped = new Uint8Array(readback.getMappedRange().slice(0)); readback.unmap(); readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true }); writeFileSync(pngOut, encodePng(width, height, tight));
const patchMean = (x0, x1, y0, y1) => { const sum = [0, 0, 0]; let count = 0; for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const index = (y * width + x) * 4; sum[0] += tight[index] ?? 0; sum[1] += tight[index + 1] ?? 0; sum[2] += tight[index + 2] ?? 0; count += 1; } return sum.map((value) => value / count / 255); };
const neutral = patchMean(25, 95, 45, 145); const solid = patchMean(125, 195, 45, 145); const mappedPatch = patchMean(225, 295, 45, 145);
let maxLuma = 0; for (let i = 0; i < tight.length; i += 4) maxLuma = Math.max(maxLuma, ((tight[i] ?? 0) * 0.299 + (tight[i + 1] ?? 0) * 0.587 + (tight[i + 2] ?? 0) * 0.114) / 255);
const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (errors.length > 0) failures.push(`engine errors=${errors.map((error) => error.code).join(',')}`);
if (maxLuma <= 0.02) failures.push(`specular tint scene is dark: maxLuma=${maxLuma.toFixed(4)}`);
if (Math.abs(solid[0] - neutral[0]) + Math.abs(solid[1] - neutral[1]) + Math.abs(solid[2] - neutral[2]) <= 0.01) failures.push(`solid tint missing: neutral=${neutral.map((value) => value.toFixed(4)).join(',')} solid=${solid.map((value) => value.toFixed(4)).join(',')}`);
if (Math.abs(mappedPatch[0] - neutral[0]) + Math.abs(mappedPatch[1] - neutral[1]) + Math.abs(mappedPatch[2] - neutral[2]) <= 0.01) failures.push(`texture-map witness missing: neutral=${neutral.map((value) => value.toFixed(4)).join(',')} mapped=${mappedPatch.map((value) => value.toFixed(4)).join(',')}`);
console.log(`[smoke] backend=${rendererBackend(app.renderer)} frames=${frames} neutral=${neutral.map((value) => value.toFixed(4)).join(',')} solid=${solid.map((value) => value.toFixed(4)).join(',')} mapped=${mappedPatch.map((value) => value.toFixed(4)).join(',')} png=${pngOut}`);
if (failures.length > 0) { console.error(`[smoke] FAIL - ${failures.join('; ')}`); sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(1); }
console.log('[smoke] PASS - neutral, solid-tinted, and texture-mapped dielectric specular witnesses rendered with zero engine errors');
sharedDevice.destroy?.(); delete globalThis.navigator.gpu; process.exit(0);
