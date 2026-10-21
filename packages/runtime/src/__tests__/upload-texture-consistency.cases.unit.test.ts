import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

it.each([
  ['rgba8unorm-srgb', 'linear', 'srgb'],
  ['rgba8unorm', 'srgb', 'linear'],
] as const)('rejects a conflicting %s / %s source before GPU allocation', async (format, colorSpace, expected) => {
  const assets = new AssetRegistry();
  const source: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format,
    colorSpace: expected,
    data: new Uint8Array([188, 188, 188, 255]),
    mips: { kind: 'none' },
  };
  const handle = assets.create(source).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const create = vi.spyOn(device, 'createTexture');
  expect(await store.uploadTexture(handle, { ...source, colorSpace })).toMatchObject({
    ok: false,
    error: {
      code: 'invalid-source-format',
    },
  });
  expect(create).not.toHaveBeenCalled();
  store.destroyAll();
  assets.dispose();
});
