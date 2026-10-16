import { driveReadyAppFrames } from '../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// Shared dawn-node driver for the projection smoke and the perf probe:
// real createApp + rAF path on a mock canvas, one readback at the end.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const width = 480;
export const height = 270;
const TIMING_BLOCK = 8;

/**
 * The engine shader manifest is the slowest step of a run. `PROJECTION_MANIFEST`
 * names a JSON file that later runs in the same session reuse; the perf parent
 * builds it once for all child lanes.
 */
export async function projectionManifest() {
  const cached = process.env.PROJECTION_MANIFEST;
  if (cached !== undefined && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = await buildEngineShaderManifest({});
  if (cached !== undefined) writeFileSync(cached, JSON.stringify(manifest));
  return manifest;
}

/**
 * @param {{ appRoot: string, mode?: import('../src/scene.ts').ProjectionMode, grid?: number,
 *   gridLane?: import('../src/scene.ts').ProjectionGridLane, frames: number, timeFrames?: boolean,
 *   size?: { width: number, height: number } }} options
 */
export async function runProjection({ appRoot, mode, grid = 0, gridLane, timeLanes, frames, timeFrames = false, size = { width, height } }) {
  const { width: targetWidth, height: targetHeight } = size;
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
  let sharedDevice;
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (adapterOptions) => {
    const adapter = await originalRequestAdapter(adapterOptions);
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
  const ensureRenderTarget = (device, format) => {
    renderTarget ??= device.createTexture({
      size: { width: targetWidth, height: targetHeight, depthOrArrayLayers: 1 },
      format,
      usage: 0x10 | 0x04 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
  const mockCanvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: targetWidth,
    height: targetHeight,
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
  const rafQueue = [];
  globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};

  const manifest = await projectionManifest();
  const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
  process.once('exit', () => URL.revokeObjectURL(manifestUrl));
  const { createApp } = await import('@forgeax/engine-app/browser');
  const { createDevImportTransport } = await import('@forgeax/engine-runtime');
  const { buildProjectionWorld } = await import(pathToFileURL(resolve(appRoot, 'src', 'scene.ts')).href);
  const created = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas), }, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
  gpu.requestAdapter = originalRequestAdapter;
  if (!created.ok) throw new Error(`createApp failed: ${created.error.code}`);
  const app = created.value;
  const errors = [];
  app.renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
  app.onError((error) => errors.push(error));
  const setGridLane = buildProjectionWorld(app.world, { ...(mode ? { mode } : {}), grid, ...(gridLane ? { gridLane } : {}) });
  const started = app.start();
  if (!started.ok) throw new Error(`app.start failed: ${started.error.code}`);

  const frameMs = [];
  // timeLanes alternates grid materials per block on one device, so paired
  // lanes share clock state; laneMs[lane] collects that lane's blocks.
  const laneMs = {};
  let lane = timeLanes?.[0];
  const start = performance.now();
  let completed = 0;
  let blockStart = performance.now();
  for (let i = 0; i < frames; i += 1) {
    if (timeLanes && i % TIMING_BLOCK === 0) {
      lane = timeLanes[(i / TIMING_BLOCK) % timeLanes.length];
      setGridLane(lane);
    }
    const tick = () => {
      const callback = rafQueue.shift();
      if (!callback) return false;
      callback(start + i * 16.67);
    };
    if (timeFrames) {
      if (tick() === false) break;
    } else {
      await driveReadyAppFrames(app.renderer, tick);
    }
    completed += 1;
    if (timeFrames && i % TIMING_BLOCK === TIMING_BLOCK - 1) {
      // One GPU sync per block keeps the queue full, so the GPU does not idle
      // and down-clock between frames; the sample is GPU-complete throughput.
      await sharedDevice.queue.onSubmittedWorkDone();
      const now = performance.now();
      frameMs.push((now - blockStart) / TIMING_BLOCK);
      if (lane !== undefined) (laneMs[lane] ??= []).push((now - blockStart) / TIMING_BLOCK);
      blockStart = now;
    } else if (!timeFrames && i % 16 === 15) {
      await sharedDevice.queue.onSubmittedWorkDone();
      await delay(1);
    }
  }
  await sharedDevice.queue.onSubmittedWorkDone();
  app.stop();

  const bytesPerRow = Math.ceil((targetWidth * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * targetHeight, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: targetHeight }, { width: targetWidth, height: targetHeight, depthOrArrayLayers: 1 });
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + targetWidth * 4), y * targetWidth * 4);
  const backend = app.renderer.inspect().capabilities.backendKind;
  const dispose = () => { URL.revokeObjectURL(manifestUrl); sharedDevice.destroy?.(); delete globalThis.navigator.gpu; };
  return { pixels, frames: completed, frameMs, laneMs, errors, backend, dispose };
}

/** Mean display-encoded channel values over an inclusive-exclusive pixel rectangle, plus luma variance. */
export function patch(pixels, [x0, x1, y0, y1], stride = width) {
  const sum = [0, 0, 0];
  const lumas = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * stride + x) * 4;
      const rgb = [0, 1, 2].map((channel) => (pixels[offset + channel] ?? 0) / 255);
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += rgb[channel];
      lumas.push(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
    }
  }
  const count = lumas.length;
  const [r, g, b] = sum.map((value) => value / count);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const variance = lumas.reduce((acc, value) => acc + (value - luma) ** 2, 0) / count;
  return { r, g, b, luma, std: Math.sqrt(variance), max: Math.max(...lumas) };
}

/** Mean absolute per-channel difference between two equally sized rectangles. */
export function patchDifference(pixels, a, b, stride = width) {
  let sum = 0;
  let count = 0;
  for (let dy = 0; dy < a[3] - a[2]; dy += 1)
    for (let dx = 0; dx < a[1] - a[0]; dx += 1) {
      const pa = ((a[2] + dy) * stride + a[0] + dx) * 4;
      const pb = ((b[2] + dy) * stride + b[0] + dx) * 4;
      for (let channel = 0; channel < 3; channel += 1) sum += Math.abs((pixels[pa + channel] ?? 0) - (pixels[pb + channel] ?? 0)) / 255;
      count += 3;
    }
  return sum / count;
}
