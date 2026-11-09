import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { TextureAsset } from '@forgeax/engine-types';
import { disposeDevice } from '../../../rhi-wgpu/src/device';
import * as wgpu from '../../../rhi-wgpu/src/index';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { readbackTexture } from './ktx2-gpu-readback.fixture';
import { compressedTextureSources } from './webgl-compressed-texture-data.fixture';

const COMPRESSION_FEATURES = [
  'texture-compression-astc',
  'texture-compression-etc2',
  'texture-compression-bc',
] as const;

/** Actual devices grant one advertised family at a time; caps are never replaced. */
export async function verifyWebGlCompressedTextures() {
  const rows: {
    feature: string;
    encoding: string;
    format: string;
    bytes: number;
    maxError: number;
    mips: number;
  }[] = [];
  const initial = document.createElement('canvas');
  const adapter = (await wgpu.requestAdapter(undefined, initial)).unwrap();
  const advertised = COMPRESSION_FEATURES.filter((feature) => adapter.features.has(feature));
  for (const feature of [...advertised, undefined]) {
    const canvas = document.createElement('canvas');
    const actual = (await wgpu.requestAdapter(undefined, canvas)).unwrap();
    const device = (
      await actual.requestDevice({ requiredFeatures: feature ? [feature] : [] })
    ).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    try {
      if (device.caps.backendKind !== 'wgpu-webgl2') throw new Error('Actual WebGL2 required');
      if (feature && !device.features.has(feature))
        throw new Error('Requested feature was not granted');
      const assets = new AssetRegistry();
      const world = new World({ assets });
      for (const source of compressedTextureSources) {
        const texture: TextureAsset = {
          kind: 'texture',
          encoding: source.encoding,
          data: source.data,
          shape: { viewDimension: '2d', extent: { width: 17, height: 9 } },
          format: 'rgba8unorm-srgb',
          colorSpace: 'srgb',
          mips: { kind: 'packed', levelCount: 5 },
        };
        const handle = assets.create(texture).unwrap();
        const scope = worldRenderResources(world);
        store.prepareTextureData(handle, texture, scope);
        await store.waitTextureData(handle, scope);
        const derived = store.prepareTextureData(handle, texture, scope).unwrap();
        const expectedPrefix =
          feature === 'texture-compression-astc'
            ? 'astc'
            : feature === 'texture-compression-etc2'
              ? 'etc2'
              : feature === 'texture-compression-bc'
                ? 'bc7'
                : 'rgba8';
        if (!derived.format.startsWith(expectedPrefix))
          throw new Error(`Unexpected physical selection: ${feature}: ${derived.format}`);
        store.ensureResident(handle, texture, scope).unwrap();
        const gpu = store._getTextureGpuTexture(handle, scope);
        if (!gpu) throw new Error('Missing physical GPU texture');
        let maxError = 0;
        for (let mip = 0; mip < 5; mip++) {
          const bytes = await readbackTexture(device, derived, gpu, wgpu.createShaderModule, mip);
          const expected = [180, 90, 45, 173];
          for (let i = 0; i < bytes.length; i++)
            maxError = Math.max(maxError, Math.abs((bytes[i] ?? 0) - (expected[i % 4] ?? 0)));
        }
        if (maxError > 8)
          throw new Error(
            `${feature ?? 'uncompressed'} ${source.encoding}: max pixel error ${maxError} > 8`,
          );
        rows.push({
          feature: feature ?? 'uncompressed-request',
          encoding: source.encoding,
          format: derived.format,
          bytes: derived.data.byteLength,
          maxError,
          mips: 5,
        });
      }
      await device.queue.onSubmittedWorkDone();
    } finally {
      store.destroyAll();
      disposeDevice(device);
      canvas.remove();
    }
  }
  return { backend: 'wgpu-webgl2', advertised, rows };
}
