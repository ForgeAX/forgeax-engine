import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { SamplerAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

it('reuses the accepted sampler but replaces the same-handle publication payload', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createSampler');
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const firstWorld = new World();
  const otherWorld = new World();
  const nearest: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const linear: SamplerAsset = { kind: 'sampler', minFilter: 'linear', magFilter: 'linear' };
  const handle = firstWorld.allocSharedRef('SamplerAsset', nearest);
  const original = store.ensureSamplerResident(handle, nearest, firstWorld).unwrap();
  const isolated = store.ensureSamplerResident(handle, nearest, otherWorld).unwrap();
  expect(store.ensureSamplerResident(handle, nearest, firstWorld).unwrap()).toBe(original);
  expect(create).toHaveBeenCalledTimes(2);
  const warm = store.ensureSamplerResident(handle, nearest, firstWorld);
  expect(store.ensureSamplerResident(handle, nearest, firstWorld)).toBe(warm);
  expect(Object.isFrozen(warm)).toBe(true);
  expect(() => Object.assign(warm, { value: isolated })).toThrow(TypeError);
  expect(store.ensureSamplerResident(handle, nearest, firstWorld).unwrap()).toBe(original);
  const replaced = store.ensureSamplerResident(handle, linear, firstWorld).unwrap();
  expect(replaced).not.toBe(original);
  expect(create).toHaveBeenLastCalledWith({ minFilter: 'linear', magFilter: 'linear' });
  expect(store.ensureSamplerResident(handle, linear, firstWorld).unwrap()).toBe(replaced);
  expect(store.ensureSamplerResident(handle, nearest, otherWorld).unwrap()).toBe(isolated);
  expect(create).toHaveBeenCalledTimes(3);
  store.destroyAll();
});
