import { err, ok, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuBuffer, GpuTexture } from '../gpu-resource';

it.each([
  'buffer',
  'texture',
] as const)('keeps %s ownership on failed destruction and releases it after successful retry', async (kind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'gpu-resource');
  const method = kind === 'buffer' ? 'destroyBuffer' : 'destroyTexture';
  const original = device[method].bind(device);
  const spy = vi
    .spyOn(device, method)
    .mockReturnValueOnce(
      err(
        new RhiError({ code: 'webgpu-runtime-error', expected: 'injected failure', hint: 'retry' }),
      ),
    );
  const resource =
    kind === 'buffer'
      ? new GpuBuffer(device, device.createBuffer({ size: 64, usage: 8 }).unwrap(), scope)
      : new GpuTexture(
          device,
          device
            .createTexture({
              size: [1, 1, 1],
              format: 'rgba8unorm',
              usage: 4,
              textureBindingViewDimension: '2d',
            })
            .unwrap(),
          scope,
        );
  expect(scope.resourceDelta()).toBe(1);
  expect(resource.destroy().ok).toBe(false);
  expect(resource.isDestroyed).toBe(false);
  expect(scope.resourceDelta()).toBe(1);
  spy.mockImplementation(original as RhiDevice[typeof method]);
  expect(resource.destroy().ok).toBe(true);
  expect(resource.isDestroyed).toBe(true);
  expect(scope.resourceDelta()).toBe(0);
  scope.retire();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(resource.destroy().ok).toBe(false);
  expect(scope.resourceDelta()).toBe(0);
});

it('cleans remaining resources in reverse order after an earlier resource was released', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'gpu-resource-order');
  const resources = Array.from(
    { length: 3 },
    () => new GpuBuffer(device, device.createBuffer({ size: 64, usage: 8 }).unwrap(), scope),
  );
  const handles: unknown[] = [];
  vi.spyOn(device, 'destroyBuffer').mockImplementation((handle) => {
    handles.push(handle);
    return ok(undefined);
  });
  const [first, second, third] = resources;
  if (first === undefined || second === undefined || third === undefined)
    throw new Error('missing fixture resource');
  second.destroy().unwrap();
  scope.retire();
  scope.dispose();
  expect(handles).toEqual([second.handle, third.handle, first.handle]);
  expect(scope.resourceDelta()).toBe(0);
});
