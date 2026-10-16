import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeBinding } from '../binding';
import { NativeGPU } from '../gpu';

const ADDON_ENV = 'FORGEAX_RHI_WGPU_NATIVE_ADDON';

describe('rhi-wgpu-native without a built addon', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reports adapter-unavailable from every entry, never a throw', async () => {
    vi.stubEnv(ADDON_ENV, '/nonexistent/forgeax-rhi-wgpu-native.node');
    vi.resetModules();
    const native = await import('../index');

    const gpu = native.createGpu();
    expect(gpu.ok).toBe(false);
    if (!gpu.ok) expect(gpu.error.code).toBe('adapter-unavailable');

    const window = native.createNativeWindow({ width: 320, height: 180 });
    expect(window.ok).toBe(false);
    if (!window.ok) expect(window.error.code).toBe('adapter-unavailable');

    const installed = native.installNavigatorGpu();
    expect(installed.ok).toBe(false);
    if (!installed.ok) expect(installed.error.code).toBe('adapter-unavailable');

    const adapter = await native.rhi.requestAdapter();
    expect(adapter.ok).toBe(false);
    if (!adapter.ok) expect(adapter.error.code).toBe('adapter-unavailable');

    expect(native.nativeWgpuVersion()).toBeNull();
  });
});

describe('NativeGPU hidden features', () => {
  const adapterFeatures = ['timestamp-query', RAY_QUERY_FEATURE];
  const binding = {
    wgpuVersion: () => '30.0.1',
    requestAdapter: () => ({
      features: () => adapterFeatures,
      limits: () => '{}',
      info: () => JSON.stringify({ vendor: 'test', architecture: '', device: '', description: '' }),
      requestDevice: () => {
        throw new Error('not exercised');
      },
    }),
  } as unknown as NativeBinding;

  it('withholds a hidden feature from the adapter feature set', async () => {
    const open = await new NativeGPU(binding).requestAdapter();
    expect(open?.features.has(RAY_QUERY_FEATURE)).toBe(true);

    const hidden = await new NativeGPU(binding, new Set([RAY_QUERY_FEATURE])).requestAdapter();
    expect(hidden?.features.has(RAY_QUERY_FEATURE)).toBe(false);
    expect(hidden?.features.has('timestamp-query')).toBe(true);
  });
});

describe('NativeGPU objects in descriptor snapshots', () => {
  it('expose no enumerable device graph, like W3C GPU objects', async () => {
    let nextId = 1;
    const nativeDevice = new Proxy(
      { features: () => [], limits: () => '{}', drainErrors: () => '[]', lostInfo: () => null },
      {
        get: (target, name) =>
          name in target ? target[name as keyof typeof target] : () => nextId++,
      },
    );
    const binding = {
      wgpuVersion: () => '30.0.1',
      requestAdapter: () => ({
        features: () => [],
        limits: () => '{}',
        info: () => JSON.stringify({ vendor: '', architecture: '', device: '', description: '' }),
        requestDevice: () => nativeDevice,
      }),
    } as unknown as NativeBinding;
    const adapter = await new NativeGPU(binding).requestAdapter();
    const device = await adapter?.requestDevice();
    if (device === undefined) throw new Error('mock adapter yields a device');
    const module = device.createShaderModule({ code: '' });
    const snapshot = JSON.stringify({ compute: { module, entryPoint: 'main' }, device });
    expect(JSON.parse(snapshot)).toEqual({
      compute: { module: {}, entryPoint: 'main' },
      device: {},
    });

    // RHI Debug collects handle ids with an Object.values walk over recorded events.
    const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x10 });
    const event = { desc: { colorAttachments: [{ view: texture.createView() }] }, device };
    const visited = new Set<object>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(visited.has(value)).toBe(false);
      visited.add(value);
      for (const entry of Object.values(value)) walk(entry);
    };
    walk(event);
  });
});
