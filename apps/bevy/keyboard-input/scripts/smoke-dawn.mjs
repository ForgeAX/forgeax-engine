#!/usr/bin/env node
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { runSmokeAppFrames, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const width = 320;
const height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
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
  if (!adapter) return adapter;
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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { return ensureRenderTarget(sharedDevice, 'rgba8unorm'); },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const phases = [
  { downKeys: new Set(['?']), upKeys: new Set(), downCodes: new Set(['KeyA']), upCodes: new Set() },
  { downKeys: new Set(['?']), upKeys: new Set(), downCodes: new Set(['KeyA']), upCodes: new Set() },
  { downKeys: new Set(), upKeys: new Set(['?']), downCodes: new Set(), upCodes: new Set(['KeyA']) },
  { downKeys: new Set(), upKeys: new Set(), downCodes: new Set(), upCodes: new Set() },
];
let phaseIndex = 0;
const input = {
  sample() {
    const phase = phases[Math.min(phaseIndex++, phases.length - 1)];
    return {
      ...phase,
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    };
  },
  detach() {},
};

const rafQueue = [];
globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { Update } = await import('@forgeax/engine-ecs');
const { INPUT_SNAPSHOT_RESOURCE_KEY } = await import('@forgeax/engine-input');
const { FRAME_START_SCAN_SYSTEM_NAME } = await import('@forgeax/engine-input');
const { buildKeyboardInputWorld, readKeyboardInputState, stepKeyboardInput } = await import(resolve(appRoot, 'src', 'keyboard-input.ts'));
const appResult = await createApp(mockCanvas, { input, platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl });
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) { console.error(`[smoke] createApp failed: ${appResult.error.code}`); process.exit(1); }
const app = appResult.value;
const errors = [];
subscribeSmokeErrors(app.renderer, (error) => errors.push(error));
app.onError((error) => errors.push(error));
buildKeyboardInputWorld(app.world);
app.world.addSystem(Update, {
  name: 'bevy-keyboard-input-read',
  after: [FRAME_START_SCAN_SYSTEM_NAME],
  queries: [],
  fn: (world) => stepKeyboardInput(world, world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY)),
});
const frames = await runSmokeAppFrames(app, () => {
  const callback = rafQueue.shift();
  if (!callback) return false;
  callback();
  return true;
}, targetFrames);
const state = readKeyboardInputState(app.world);
const snapshot = app.world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);

const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
const encoder = sharedDevice.createCommandEncoder();
encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
sharedDevice.queue.submit([encoder.finish()]);
await readback.mapAsync(0x01);
const mapped = new Uint8Array(readback.getMappedRange().slice(0));
readback.unmap();
readback.destroy();
const tight = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, writeReferencePng(tight, width, height));
let visiblePixels = 0;
for (let i = 0; i < tight.length; i += 4) if ((tight[i] ?? 0) + (tight[i + 1] ?? 0) + (tight[i + 2] ?? 0) > 30) visiblePixels += 1;
console.log(`[smoke] frames=${frames} visiblePixels=${visiblePixels} codePresses=${state.justPressedCodeA} codeReleases=${state.releasedCodeA} logicalPresses=${state.justPressedQuestion} logicalReleases=${state.releasedQuestion} snapshotDown=${snapshot.keyboard.down('never')} errors=${errors.length} png=${pngOut}`);
const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < targetFrames) failures.push(`frames=${frames} < ${targetFrames}`);
if (visiblePixels <= 1000) failures.push(`visiblePixels=${visiblePixels}`);
if (state.heldCodeA || state.heldQuestion) failures.push(`keys remain held: ${JSON.stringify(state)}`);
if (state.justPressedCodeA !== 1 || state.releasedCodeA !== 1) failures.push(`code edges=${JSON.stringify(state)}`);
if (state.justPressedQuestion !== 1 || state.releasedQuestion !== 1) failures.push(`logical edges=${JSON.stringify(state)}`);
if (errors.length > 0) failures.push(`errors=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) { console.error(`[smoke] FAIL - ${failures.join('; ')}`); sharedDevice.destroy?.(); process.exit(1); }
console.log(`[smoke] PASS - backend=webgpu, frames=${frames}, physical and logical keyboard edges proven, errors=0`);
sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
