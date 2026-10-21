import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { SamplerAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

it('reuses the accepted sampler but replaces the same-handle publication payload', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createSampler');
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  create.mockClear();
  const firstAssets = new AssetRegistry(),
    otherAssets = new AssetRegistry();
  firstAssets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  otherAssets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const firstWorld = new World({ assets: firstAssets });
  const otherWorld = new World({ assets: otherAssets });
  const nearest: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const linear: SamplerAsset = { kind: 'sampler', minFilter: 'linear', magFilter: 'linear' };
  const handle = firstAssets.create(nearest).unwrap();
  const otherHandle = otherAssets.create(nearest).unwrap();
  const original = store
    .ensureSamplerResident(handle, nearest, worldRenderResources(firstWorld))
    .unwrap();
  const isolated = store
    .ensureSamplerResident(otherHandle, nearest, worldRenderResources(otherWorld))
    .unwrap();
  expect(
    store.ensureSamplerResident(handle, nearest, worldRenderResources(firstWorld)).unwrap(),
  ).toBe(original);
  expect(create).toHaveBeenCalledTimes(2);
  const warm = store.ensureSamplerResident(handle, nearest, worldRenderResources(firstWorld));
  expect(store.ensureSamplerResident(handle, nearest, worldRenderResources(firstWorld))).toBe(warm);
  expect(Object.isFrozen(warm)).toBe(true);
  expect(() => Object.assign(warm, { value: isolated })).toThrow(TypeError);
  expect(
    store.ensureSamplerResident(handle, nearest, worldRenderResources(firstWorld)).unwrap(),
  ).toBe(original);
  const replaced = store
    .ensureSamplerResident(handle, linear, worldRenderResources(firstWorld))
    .unwrap();
  expect(replaced).not.toBe(original);
  expect(create).toHaveBeenLastCalledWith({ minFilter: 'linear', magFilter: 'linear' });
  expect(
    store.ensureSamplerResident(handle, linear, worldRenderResources(firstWorld)).unwrap(),
  ).toBe(replaced);
  expect(
    store.ensureSamplerResident(otherHandle, nearest, worldRenderResources(otherWorld)).unwrap(),
  ).toBe(isolated);
  expect(create).toHaveBeenCalledTimes(3);
  store.destroyAll();
});
