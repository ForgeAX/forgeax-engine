import { expect, it, vi } from 'vitest';
import { observeNativeDeviceRequests } from './native-device-work.fixture';

it('counts actual requests once and restores inherited methods without changing device promises', async () => {
  const descriptor = { label: 'native-request' };
  const device = Promise.resolve({ label: 'device' });
  class Adapter {
    requestDevice(value: unknown) {
      expect(this).toBe(adapter);
      expect(value).toBe(descriptor);
      return device;
    }
  }
  const adapter = new Adapter();
  class Gpu {
    requestAdapter(value: unknown) {
      expect(this).toBe(gpu);
      expect(value).toBe(descriptor);
      return Promise.resolve(adapter);
    }
  }
  const gpu = new Gpu();
  vi.stubGlobal('navigator', { gpu });
  const observed = observeNativeDeviceRequests();
  try {
    expect(() => observed.assertMaximum(1)).toThrow('real native device requests');
    expect(await gpu.requestAdapter(descriptor)).toBe(adapter);
    expect(await gpu.requestAdapter(descriptor)).toBe(adapter);
    expect(adapter.requestDevice(descriptor)).toBe(device);
    observed.assertMaximum(1);
    expect(() => observed.assertMaximum(0)).toThrow('real native device requests');
  } finally {
    observed.restore();
    vi.unstubAllGlobals();
  }
  expect(Object.hasOwn(gpu, 'requestAdapter')).toBe(false);
  expect(Object.hasOwn(adapter, 'requestDevice')).toBe(false);
  expect(gpu.requestAdapter).toBe(Gpu.prototype.requestAdapter);
  expect(adapter.requestDevice).toBe(Adapter.prototype.requestDevice);
});

it('preserves request failures and restores own method descriptors', async () => {
  const failure = new Error('native request failed');
  const adapter = {
    requestDevice: () => {
      throw failure;
    },
  };
  const gpu = { requestAdapter: () => Promise.resolve(adapter) };
  const gpuDescriptor = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter');
  const adapterDescriptor = Object.getOwnPropertyDescriptor(adapter, 'requestDevice');
  vi.stubGlobal('navigator', { gpu });
  const observed = observeNativeDeviceRequests();
  try {
    await gpu.requestAdapter();
    expect(() => adapter.requestDevice()).toThrow(failure);
    observed.assertMaximum(1);
  } finally {
    observed.restore();
    vi.unstubAllGlobals();
  }
  expect(Object.getOwnPropertyDescriptor(gpu, 'requestAdapter')).toEqual(gpuDescriptor);
  expect(Object.getOwnPropertyDescriptor(adapter, 'requestDevice')).toEqual(adapterDescriptor);
});
