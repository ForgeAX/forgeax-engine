import { describe, expect, it, vi } from 'vitest';
import { makeRhiAdapter } from '../adapter';
import { makeRhiDevice } from '../device';

function nativeDevice(descriptors: GPUTextureDescriptor[], rejectFormat?: GPUTextureFormat) {
  const scopes: boolean[] = [];
  return {
    features: new Set<string>(),
    limits: {},
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      descriptors.push(descriptor);
      if (descriptor.format === rejectFormat && scopes.length > 0) scopes[scopes.length - 1] = true;
      return { destroy: vi.fn() };
    }),
    pushErrorScope: vi.fn(() => {
      scopes.push(false);
    }),
    popErrorScope: vi.fn(async () => {
      const hadError = scopes.pop() ?? false;
      const validationError: GPUValidationError = {
        message: 'mock validation error',
        __brand: 'GPUValidationError',
      };
      return hadError ? validationError : null;
    }),
  };
}

describe('rhi-wgpu adapter float texture capability validation', () => {
  it('fails closed when direct construction receives a device with scopes but no receipt', () => {
    const descriptors: GPUTextureDescriptor[] = [];
    const rawDevice = nativeDevice(descriptors);

    const { device } = makeRhiDevice(rawDevice as never);

    expect(device.caps).toMatchObject({
      rgba16floatRenderable: false,
      rgba32floatRenderable: false,
      rgba16floatStorage: false,
      rgba32floatStorage: false,
    });
    expect(descriptors).toHaveLength(0);
    expect(rawDevice.pushErrorScope).not.toHaveBeenCalled();
  });

  it('fails closed when direct construction receives only pushErrorScope', () => {
    const descriptors: GPUTextureDescriptor[] = [];
    const rawDevice = nativeDevice(descriptors) as unknown as Record<string, unknown>;
    delete rawDevice.popErrorScope;

    const { device } = makeRhiDevice(rawDevice as never);

    expect(device.caps).toMatchObject({
      rgba16floatRenderable: false,
      rgba32floatRenderable: false,
      rgba16floatStorage: false,
      rgba32floatStorage: false,
    });
    expect(descriptors).toHaveLength(0);
  });

  it('fails closed when direct construction receives only popErrorScope', () => {
    const descriptors: GPUTextureDescriptor[] = [];
    const rawDevice = nativeDevice(descriptors) as unknown as Record<string, unknown>;
    delete rawDevice.pushErrorScope;

    const { device } = makeRhiDevice(rawDevice as never);

    expect(device.caps).toMatchObject({
      rgba16floatRenderable: false,
      rgba32floatRenderable: false,
      rgba16floatStorage: false,
      rgba32floatStorage: false,
    });
    expect(descriptors).toHaveLength(0);
  });

  it('uses validation scopes for native raw devices and records sampled render usage', async () => {
    const descriptors: GPUTextureDescriptor[] = [];
    const rawDevice = nativeDevice(descriptors, 'rgba16float');
    const adapter = makeRhiAdapter({
      requestDevice: vi.fn(async () => rawDevice),
    } as never);

    const result = await adapter.requestDevice();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.caps.rgba16floatRenderable).toBe(false);
    expect(result.value.caps.rgba32floatRenderable).toBe(true);
    expect(rawDevice.pushErrorScope).toHaveBeenCalledTimes(8);
    expect(rawDevice.popErrorScope).toHaveBeenCalledTimes(8);
    expect(descriptors.map(({ usage }) => usage)).toEqual([20, 20, 12, 12, 20, 20, 20, 20]);
    expect(descriptors.slice(4, 6).map(({ size }) => size)).toEqual([
      [1, 1, 2],
      [1, 1, 2],
    ]);
    expect(result.value.caps).toMatchObject({
      rgba16floatArrayRenderable: false,
      rgba32floatArrayRenderable: true,
      depth32floatSampled: true,
      rg16floatRenderable: true,
    });
  });

  it('retains synchronous probing for raw devices without validation scopes', async () => {
    const descriptors: GPUTextureDescriptor[] = [];
    const rawDevice = {
      features: new Set<string>(),
      limits: {},
      createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
        descriptors.push(descriptor);
        return { destroy: vi.fn() };
      }),
    };
    const adapter = makeRhiAdapter({
      requestDevice: vi.fn(async () => rawDevice),
    } as never);

    const result = await adapter.requestDevice();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.caps.rgba16floatRenderable).toBe(true);
    expect(descriptors[0]?.usage).toBe(20);
  });
});
