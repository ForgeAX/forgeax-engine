import { driveReadyAppFrames } from '../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
// Shared dawn-node driver for the foliage smoke and the on/off perf probe:
// real createApp + rAF path on a mock canvas, one readback at the end.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const width = 320;
export const height = 180;

/**
 * `scene: 'furnace'` builds the white-furnace scene and reads `furnaceMode`;
 * the default `foliage` scene reads `mode`, `grid` and `gridMaterial`.
 *
 * @param {{ appRoot: string, scene?: 'foliage' | 'furnace', mode?: 'transmission' | 'no-transmission',
 *   furnaceMode?: 'split' | 'additive', grid?: number,
 *   gridMaterial?: 'diffuse-transmission' | 'standard', frames: number, timeFrames?: boolean }} options
 */
export async function runFoliage({ appRoot, scene = 'foliage', mode, furnaceMode, grid = 0, gridMaterial, frames, timeFrames = false }) {
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
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: 0x10 | 0x04 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
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
  const rafQueue = [];
  globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};

  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const { FOLIAGE_MATERIAL_PACKAGES } = await import(pathToFileURL(resolve(appRoot, 'src', 'material-contract.ts')).href);
  const manifest = await buildEngineShaderManifest({
    materialPackages: FOLIAGE_MATERIAL_PACKAGES.map((file) => resolve(appRoot, 'src', file)),
  });
  const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
  process.once('exit', () => URL.revokeObjectURL(manifestUrl));
  const { createApp } = await import('@forgeax/engine-app/browser');
  const { createDevImportTransport } = await import('@forgeax/engine-runtime');
  const { buildFoliageWorld } = await import(pathToFileURL(resolve(appRoot, 'src', 'foliage.ts')).href);
  const { buildWhiteFurnaceWorld } = await import(pathToFileURL(resolve(appRoot, 'src', 'white-furnace.ts')).href);
  const captureDirectory = process.env.FORGEAX_FOLIAGE_CAPTURE_DIR;
  const recorder = captureDirectory === undefined ? undefined :
    (await import('@forgeax/engine-rhi-debug')).attachRecorder(await import('@forgeax/engine-rhi-webgpu')).unwrap();
  const created = await createApp(mockCanvas, { ...(recorder === undefined ? {} : { rhi: recorder.backend.rhi }), platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl, importTransport: createDevImportTransport() });
  gpu.requestAdapter = originalRequestAdapter;
  if (!created.ok) throw new Error(`createApp failed: ${created.error.code}`);
  const app = created.value;
  const errors = [];
  app.renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
  app.onError((error) => errors.push(error));
  if (scene === 'furnace') buildWhiteFurnaceWorld(app.world, { aspect: width / height, mode: furnaceMode ?? 'split' });
  else buildFoliageWorld(app.world, { aspect: width / height, mode, grid, ...(gridMaterial ? { gridMaterial } : {}) });
  const started = app.start();
  if (!started.ok) throw new Error(`app.start failed: ${started.error.code}`);

  const frameMs = [];
  const start = performance.now();
  const firstFrameCapture = recorder?.captureFrame();
  if (recorder !== undefined) (await recorder.frameBoundary()).unwrap();
  let completed = 0;
  for (let i = 0; i < frames; i += 1) {
    const before = performance.now();
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
    if (i === 0 && recorder !== undefined && firstFrameCapture !== undefined) {
      await sharedDevice.queue.onSubmittedWorkDone();
      (await recorder.frameBoundary()).unwrap();
      await mkdir(captureDirectory, { recursive: true });
      const captured = (await firstFrameCapture).unwrap();
      await writeFile(resolve(captureDirectory, `${scene}-first-frame.rhitape`), captured.bytes);
      const { decodeTape, buildFrameModel } = await import('@forgeax/engine-rhi-debug');
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const creates = new Map([...tape.bootstrap.map((row) => row.create), ...tape.events]
        .filter((row) => row?.handleId !== undefined).map((row) => [row.handleId, row]));
      // Check the actual first shadow draw, including layouts created inside
      // the frame. A later stable capture can omit the failed cache fill.
      for (const work of model.works) {
        const pass = model.passes[work.passIndex];
        if (!tape.events[pass?.beginEventIndex]?.desc?.label?.startsWith('shadow')) continue;
        const pipeline = creates.get(work.pipeline.pipelineHandleId);
        const layout = creates.get(pipeline?.layoutHandleId);
        const group = creates.get(work.bindings.find((binding) => binding.groupIndex === 1)?.bindGroupId);
        if (layout === undefined || group === undefined) continue;
        const expected = creates.get(layout.bglHandleIds[1]);
        const actual = creates.get(group.layoutHandleId);
        if (JSON.stringify(expected?.desc.entries) !== JSON.stringify(actual?.desc.entries))
          throw new Error(`First-frame shadow work ${work.workIndex}: material layout ${group.layoutHandleId} differs from pipeline layout ${layout.bglHandleIds[1]}`);
      }
      await writeFile(resolve(captureDirectory, `${scene}-first-frame-model.json`), JSON.stringify(model, null, 2));
    }
    if (timeFrames) {
      // Wait for the GPU per frame so the sample covers shading, not only submission.
      await sharedDevice.queue.onSubmittedWorkDone();
      frameMs.push(performance.now() - before);
    } else if (i % 16 === 15) {
      await sharedDevice.queue.onSubmittedWorkDone();
      await delay(1);
    }
  }
  await sharedDevice.queue.onSubmittedWorkDone();
  app.stop();

  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer: readback, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const mapped = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  const backend = app.renderer.inspect().capabilities.backendKind;
  const dispose = () => { URL.revokeObjectURL(manifestUrl); sharedDevice.destroy?.(); delete globalThis.navigator.gpu; };
  return { pixels, frames: completed, frameMs, errors, backend, dispose };
}

/** Mean linear-ish sRGB channel values over an inclusive-exclusive pixel rectangle. */
export function patch(pixels, [x0, x1, y0, y1]) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += (pixels[offset + channel] ?? 0) / 255;
      count += 1;
    }
  }
  const [r, g, b] = sum.map((value) => value / count);
  return { r, g, b, luma: 0.299 * r + 0.587 * g + 0.114 * b };
}
