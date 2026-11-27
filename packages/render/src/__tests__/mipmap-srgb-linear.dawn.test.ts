import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { numMipLevels, ok, type TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { nativeAdapterFixture, nativeDeviceFixture } from './native-device-fixture';
import {
  prepareDerivedTextureGeneratorPrograms,
  prepareTextureGeneratorPrograms,
  prepareWaterImpulseNoise,
  prepareWaterSurfaceTextures,
  prepareWaterVolumeRecipe,
} from './texture-generators.commands';
import {
  sampledSrgbPixel,
  verifyBuiltinColorMipFilters,
  verifyGpuTextureGeneration,
  verifyWaterImpulseMipChain,
  verifyWaterSurfaceTextures,
} from './texture-generators.gpu-fixture';

it.each([
  { name: 'sRGB mid-gray', format: 'rgba8unorm-srgb', width: 2, values: [188], expected: 188 },
  { name: 'linear mid-gray', format: 'rgba8unorm', width: 2, values: [128], expected: 128 },
  { name: 'nine-level chain', format: 'rgba8unorm', width: 256, values: [128], expected: 128 },
  {
    name: 'sRGB black-white average',
    format: 'rgba8unorm-srgb',
    width: 2,
    values: [0, 255],
    expected: 188,
  },
  {
    name: 'linear black-white average',
    format: 'rgba8unorm',
    width: 2,
    values: [0, 255],
    expected: 128,
  },
] as const)('uploads $name through managed residency and reads the real final mip', async ({
  format,
  width,
  values,
  expected,
}) => {
  const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = gpu._internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => gpu.createShaderModule(device, descriptor),
    device.caps,
  );
  const levels = numMipLevels({ width, height: width });
  const data = new Uint8Array(width * width * 4);
  for (let pixel = 0; pixel < width * width; pixel++) {
    const value = values[pixel % values.length] ?? 0;
    data.set([value, value, value, 255], pixel * 4);
  }
  const asset: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height: width } },
    format,
    colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
    mips: { kind: 'generate' },
    data,
  };
  const readback = device.createBuffer({ size: 256, usage: 9 }).unwrap();
  try {
    const reference = assets.create(asset).unwrap();
    (await store.uploadTexture(reference, assets.read(reference).unwrap())).unwrap();
    const mipWork = store.prepareTextureMips().unwrap();
    if (mipWork !== undefined) {
      assert(mipWork.buffer);
      device.queue.submit([mipWork.buffer]).unwrap();
      mipWork.complete(true);
    }
    const texture = store._getTextureGpuTexture(reference);
    assert(texture);
    expect(levels).toBe(width === 256 ? 9 : 2);
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture: texture.handle, mipLevel: levels - 1 },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const pixel = new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4);
    mapped.unmap();
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs((pixel[channel] ?? 0) - expected)).toBeLessThanOrEqual(1);
    expect(pixel[3]).toBe(255);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    store.destroyAll();
    assets.dispose();
    raw.destroy();
  }
});

it('generates, samples 60 completed frames and replays generated and resident GPU textures', async () => {
  const provider = await nativeAdapterFixture();
  const recorder = attachRecorder({
    ...gpu,
    rhi: { ...gpu.rhi, requestAdapter: async () => ok(provider.adapter) },
  }).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  let raw = provider.native;
  raw.pushErrorScope('validation');
  try {
    await verifyGpuTextureGeneration(
      device,
      (_device, descriptor) => recorder.backend.createShaderModule(device, descriptor),
      await prepareTextureGeneratorPrograms(),
      await prepareDerivedTextureGeneratorPrograms(),
      {
        volumeRecipe: await prepareWaterVolumeRecipe(),
        observe: async (phase, submit) => {
          const capture = recorder.captureFrame({ snapshotTimeoutMs: 10_000 });
          (await recorder.frameBoundary()).unwrap();
          await submit();
          (await recorder.frameBoundary()).unwrap();
          const encoded = (await capture).unwrap();
          const evidenceDirectory = process.env.FORGEAX_GPU_TEXTURE_EVIDENCE_DIR;
          if (evidenceDirectory) {
            mkdirSync(evidenceDirectory, { recursive: true });
            writeFileSync(resolve(evidenceDirectory, `${phase}.rhitape`), encoded.bytes);
          }
          const tape = decodeTape(encoded.bytes).unwrap();
          const model = buildFrameModel(tape);
          const last = model.works.at(-1);
          assert(last);
          const replayProvider = await nativeAdapterFixture();
          const adapter = replayProvider.adapter;
          const replayDevice = (
            await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
          ).unwrap();
          const replayRaw = replayProvider.native;
          replayRaw.pushErrorScope('validation');
          const replay = (
            await openReplay(tape, {
              device: replayDevice,
              createShaderModule: gpu.createShaderModule,
            })
          ).unwrap();
          try {
            if (phase === 'generation') {
              const paint = model.works.find((work) =>
                work.pipeline.shaders.some((shader) => shader.entryPoint === 'paint'),
              );
              assert(paint);
              const output = paint.attachments?.colorViewHandleIds[0];
              assert(output);
              const descriptor = model.resources.find(
                (resource) => resource.resourceId === output,
              )?.descriptor;
              assert(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor));
              assert(
                'sourceHandleId' in descriptor && typeof descriptor.sourceHandleId === 'string',
              );
              const mip = (
                await replay.readResourceAtWork(descriptor.sourceHandleId, last.workIndex, {
                  mipLevel: 4,
                  arrayLayer: 0,
                })
              ).unwrap();
              for (const channel of mip.bytes.subarray(0, 3))
                expect(Math.abs(channel - 188)).toBeLessThanOrEqual(1);
            } else {
              expect(model.works).toHaveLength(1);
              const result = (await replay.inspectWork(last.workIndex, ['pixels'])).unwrap();
              assert(result.attachment);
              const binding = last.bindings.find(
                (binding) => binding.groupIndex === 0 && binding.binding === 0,
              );
              assert(binding?.resourceId);
              const view = model.resources.find(
                (resource) => resource.resourceId === binding.resourceId,
              )?.descriptor;
              assert(view && typeof view === 'object' && !Array.isArray(view));
              assert('sourceHandleId' in view && typeof view.sourceHandleId === 'string');
              const mip = (
                await replay.readResourceAtWork(view.sourceHandleId, last.workIndex, {
                  mipLevel: 4,
                  arrayLayer: 0,
                })
              ).unwrap();
              for (const channel of mip.bytes.subarray(0, 3))
                expect(Math.abs(channel - 188)).toBeLessThanOrEqual(1);
              expect(Array.from(result.attachment.bytes.subarray(0, 4))).toEqual(
                sampledSrgbPixel(mip.bytes.subarray(0, 4)),
              );
            }
            expect(await replayRaw.popErrorScope()).toBeNull();
          } finally {
            (await replay.dispose()).unwrap();
            replayRaw.destroy();
          }
        },
        async recreateDevice() {
          expect(await raw.popErrorScope()).toBeNull();
          recorder.deviceLost();
          raw.destroy();
          expect((await raw.lost).reason).toBe('destroyed');
          const { device: replacement, native: replacementNative } = await nativeDeviceFixture();
          raw = replacementNative;
          raw.pushErrorScope('validation');
          return {
            device: replacement,
            factory: (_device, descriptor) => gpu.createShaderModule(replacement, descriptor),
          };
        },
      },
    );
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}, 60_000);

it('generates all six Water surface assets and their mips without a pixel upload', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    await verifyWaterSurfaceTextures(
      device,
      (_device, descriptor) => gpu.createShaderModule(device, descriptor),
      await prepareWaterSurfaceTextures(),
    );
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    native.destroy();
  }
}, 60_000);

it('publishes authored impulse mips and built-in color reductions on Dawn', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    const factory = (_device: typeof device, descriptor: { code: string; label?: string }) =>
      gpu.createShaderModule(device, descriptor);
    await verifyBuiltinColorMipFilters(device, factory);
    await verifyWaterImpulseMipChain(device, factory, await prepareWaterImpulseNoise());
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    native.destroy();
  }
}, 60_000);
