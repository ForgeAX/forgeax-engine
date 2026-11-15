import type { RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { RAY_QUERY_BACKEND_UNSUPPORTED } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { RenderGraphFrame } from '../types.js';

interface Frame extends RenderGraphFrame {}

function caps(storageTexture: boolean): RhiDevice['caps'] {
  return {
    backendKind: 'null',
    compute: true,
    storageBuffer: true,
    storageTexture,
    depthTextureLoad: true,
    timestampQuery: false,
    timestampPeriodNanoseconds: null,
    indirectDrawing: false,
    textureCompressionBc: false,
    textureCompressionEtc2: false,
    textureCompressionAstc: false,
    multiDrawIndirect: false,
    pushConstants: false,
    textureBindingArray: false,
    samplerAliasing: true,
    firstInstanceIndirect: false,
    rgba16floatRenderable: true,
    rg11b10ufloatRenderable: true,
    float32Filterable: true,
    textureImport: false,
    externalTexture: false,
    maxColorAttachments: 8,
    rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
  };
}

function mockDevice(storageTexture: boolean): RhiDevice {
  return {
    caps: caps(storageTexture),
    limits: {} as never,
    features: new Set() as never,
    queue: { onSubmittedWorkDone: async () => undefined } as never,
    createTexture: () => ({ ok: true, value: {} as never }),
    createTextureView: () => ({ ok: true, value: {} as TextureView }),
    destroyTexture: () => ({ ok: true, value: undefined }),
    destroyBuffer: () => ({ ok: true, value: undefined }),
  } as unknown as RhiDevice;
}

describe('RenderGraph texture dimension lifecycle', () => {
  it.each([
    [1919, 1079, 480, 270],
    [5, 3, 2, 1],
    [1, 1, 1, 1],
  ])('ceil-divides quarter surface %ix%i including odd edges', (width, height, expectedWidth, expectedHeight) => {
    const graph = new RenderGraphBuilder<Frame>();
    const sizes: unknown[] = [];
    const device = mockDevice(true);
    const original = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      sizes.push(descriptor.size);
      return original(descriptor);
    };
    const texture = graph.createTexture('quarter', {
      format: 'rgba16float',
      size: 'quarter-surface',
    });
    expect(texture.ok).toBe(true);
    if (!texture.ok) return;
    const view = graph.view(texture.value);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    graph.addCopyPass('write', {
      accesses: [{ resource: view.value, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    const compiled = graph.compile({ device, surfaceSize: { width, height } });
    expect(compiled.ok).toBe(true);
    expect(sizes).toContainEqual({
      width: expectedWidth,
      height: expectedHeight,
      depthOrArrayLayers: 1,
    });
  });
  it('returns a structured capability result for unsupported storage texture access', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph.createTexture('volume-storage', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      dimension: '3d',
    });
    expect(texture.ok).toBe(true);
    if (!texture.ok) return;
    const view = graph.view(texture.value, { dimension: '3d' });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    graph.addCopyPass('seed', {
      accesses: [{ resource: view.value, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addComputePass('write-volume', {
      accesses: [{ resource: view.value, usage: 'storage-write' }],
      encode: () => undefined,
    });

    const result = graph.compile({
      device: mockDevice(false),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('capability-missing');
    expect(result.error.detail).toMatchObject({ capability: 'storage-texture' });
  });

  it('rejects a non-positive volume extent with structured descriptor detail', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph.createTexture('invalid-volume', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2, depthOrArrayLayers: 0 },
      dimension: '3d',
    });
    expect(texture.ok).toBe(true);
    if (!texture.ok) return;
    const result = graph.compile({
      device: mockDevice(true),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('resource-descriptor-invalid');
    expect(result.error.detail).toMatchObject({ resourceLabel: 'invalid-volume', field: 'size' });
  });
});
