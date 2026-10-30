import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AssetRegistry,
  blitMipmapsSync,
  getOrCreateMipmapPipeline,
} from '@forgeax/engine-assets-runtime';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { numMipLevels } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { GpuResidencyCache } from '../device/gpu-residency';

const width = 8;
const height = 4;
const layers = 4;

function layerPixels(layer: number, extent = { width, height }): Uint8Array {
  const bytes = new Uint8Array(extent.width * extent.height * 4);
  for (let y = 0; y < extent.height; y++)
    for (let x = 0; x < extent.width; x++) {
      const offset = (y * extent.width + x) * 4;
      bytes[offset] = 16 + layer * 40 + (x % 2) * 24;
      bytes[offset + 1] = 32 + y * 32;
      bytes[offset + 2] = 224 - layer * 40;
      bytes[offset + 3] = 255;
    }
  return bytes;
}

async function readMip(
  device: RhiDevice,
  texture: Texture,
  layer: number,
  mipLevel: number,
  extent = { width, height },
) {
  const mipWidth = Math.max(1, extent.width >> mipLevel);
  const mipHeight = Math.max(1, extent.height >> mipLevel);
  const readback = device.createBuffer({ size: 256 * mipHeight, usage: 9 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture, mipLevel, origin: { x: 0, y: 0, z: layer } },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: mipHeight },
      { width: mipWidth, height: mipHeight, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const source = new Uint8Array(mapped.getMappedRange().unwrap());
    const bytes = new Uint8Array(mipWidth * mipHeight * 4);
    for (let y = 0; y < mipHeight; y++)
      bytes.set(source.subarray(y * 256, y * 256 + mipWidth * 4), y * mipWidth * 4);
    mapped.unmap();
    return bytes;
  } finally {
    device.destroyBuffer(readback).unwrap();
  }
}

for (const mode of ['eager', 'resident', 'recovery'] as const)
  for (const format of ['rgba8unorm', 'rgba8unorm-srgb'] as const)
    it(`${mode} generates every ${format} array layer and mip like independent 2D textures`, async () => {
      const recorder = attachRecorder(gpu).unwrap();
      const device = (
        await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      const raw = gpu._internal_getRawDevice(
        recorder.backend.unwrapDeviceForSurface(device).unwrap(),
      );
      assert(raw);
      raw.pushErrorScope('validation');
      const errors: string[] = [];
      raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const store = new GpuResidencyCache();
      store.configureGpuDevice(
        device,
        (_device, descriptor) => recorder.backend.createShaderModule(device, descriptor),
        device.caps,
      );
      if (mode !== 'eager') (await store.prewarmMipmapPipeline(device, [format])).unwrap();
      const assets = new AssetRegistry();
      const colorSpace = format.endsWith('-srgb') ? 'srgb' : 'linear';
      const upload = async (pod: TextureAsset) => {
        const handle = assets.create(pod).unwrap();
        if (mode === 'eager') (await store.uploadTexture(handle, pod)).unwrap();
        else if (mode === 'resident') store.ensureResident(handle, pod).unwrap();
        else {
          const submit = vi.spyOn(device.queue, 'submit');
          const prepared = store.prepareResidentForRecovery(handle, pod).unwrap();
          expect(submit).not.toHaveBeenCalled();
          submit.mockRestore();
          assert(prepared.mipmapWork);
          const command = prepared.mipmapWork.finish().unwrap();
          assert(command);
          device.queue.submit([command]).unwrap();
          prepared.mipmapWork.discard();
        }
        const mipWork = store.prepareTextureMips().unwrap();
        if (mipWork !== undefined) {
          assert(mipWork.buffer);
          device.queue.submit([mipWork.buffer]).unwrap();
          mipWork.complete(true);
        }
        const texture = store._getTextureGpuTexture(handle);
        assert(texture);
        return texture.handle;
      };
      const captured = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      try {
        const sourceLayers = Array.from({ length: layers }, (_, layer) => layerPixels(layer));
        const bytes = new Uint8Array(width * height * layers * 4);
        sourceLayers.forEach((source, layer) => {
          bytes.set(source, layer * source.byteLength);
        });
        const common = { kind: 'texture', format, colorSpace, mips: { kind: 'generate' } } as const;
        const array = await upload({
          ...common,
          shape: { viewDimension: '2d-array', extent: { width, height, layers } },
          data: bytes,
        });
        const comparisons: {
          layer: number;
          mip: number;
          actual: number[];
          expected: number[];
        }[] = [];
        for (const [layer, data] of sourceLayers.entries()) {
          const reference = await upload({
            ...common,
            shape: { viewDimension: '2d', extent: { width, height } },
            data,
          });
          for (let mip = 0; mip < numMipLevels({ width, height }); mip++)
            comparisons.push({
              layer,
              mip,
              actual: [...(await readMip(device, array, layer, mip))],
              expected: [...(await readMip(device, reference, 0, mip))],
            });
        }
        (await recorder.frameBoundary()).unwrap();
        const tape = (await captured).unwrap().bytes;
        const model = buildFrameModel(decodeTape(tape).unwrap());
        const directory = process.env.FORGEAX_RAY_EVIDENCE;
        if (directory) {
          await mkdir(directory, { recursive: true });
          const name = `${mode}-${format}`;
          await writeFile(join(directory, `${name}.rhitape`), tape);
          await writeFile(
            join(directory, `${name}.json`),
            JSON.stringify({ comparisons }, null, 2),
          );
        }
        for (const comparison of comparisons) {
          expect(comparison.expected.some((value) => value !== 0)).toBe(true);
          expect(comparison.actual, `layer ${comparison.layer}, mip ${comparison.mip}`).toEqual(
            comparison.expected,
          );
        }
        expect(model.works.filter((work) => work.kind === 'draw')).toHaveLength(
          layers * (numMipLevels({ width, height }) - 1) * 2,
        );
        expect(await raw.popErrorScope()).toBeNull();
        expect(errors).toEqual([]);
      } finally {
        store.destroyAll();
        assets.dispose();
        (await recorder.dispose()).unwrap();
        raw.destroy();
      }
    }, 60_000);

for (const format of ['rgba8unorm', 'rgba8unorm-srgb'] as const)
  it(`generates all six ${format} cube faces without mixing their mip chains`, async () => {
    const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const raw = gpu._internal_getRawDevice(device);
    assert(raw);
    raw.pushErrorScope('validation');
    const extent = { width: 8, height: 8 };
    const levels = numMipLevels(extent);
    const textures: Texture[] = [];
    const upload = async (images: readonly Uint8Array[]) => {
      const texture = device
        .createTexture({
          size: { ...extent, depthOrArrayLayers: images.length },
          format,
          mipLevelCount: levels,
          usage: 23,
        })
        .unwrap();
      textures.push(texture);
      const data = new Uint8Array(extent.width * extent.height * images.length * 4);
      images.forEach((image, layer) => {
        data.set(image, layer * image.byteLength);
      });
      device.queue
        .writeTexture(
          { texture },
          data,
          { bytesPerRow: extent.width * 4, rowsPerImage: extent.height },
          { ...extent, depthOrArrayLayers: images.length },
        )
        .unwrap();
      (
        await getOrCreateMipmapPipeline(device, format, (_device, descriptor) =>
          gpu.createShaderModule(device, descriptor),
        )
      ).unwrap();
      blitMipmapsSync(device, texture, {
        ...extent,
        format,
        levels,
        arrayLayerCount: images.length,
      }).unwrap();
      return texture;
    };
    try {
      const images = Array.from({ length: 6 }, (_, layer) => layerPixels(layer, extent));
      const cube = await upload(images);
      device.createTextureView(cube, { dimension: 'cube', arrayLayerCount: 6 }).unwrap();
      for (const [layer, image] of images.entries()) {
        const reference = await upload([image]);
        for (let mip = 0; mip < levels; mip++) {
          const expected = await readMip(device, reference, 0, mip, extent);
          expect(expected.some((value) => value !== 0)).toBe(true);
          expect(
            equalBytes(await readMip(device, cube, layer, mip, extent), expected),
            `face ${layer}, mip ${mip}`,
          ).toBe(true);
        }
      }
      expect(await raw.popErrorScope()).toBeNull();
    } finally {
      for (const texture of textures) device.destroyTexture(texture).unwrap();
      raw.destroy();
    }
  }, 60_000);
