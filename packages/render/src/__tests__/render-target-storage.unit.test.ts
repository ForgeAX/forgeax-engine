import type { TextureDescriptor } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { admitRenderTargetDescriptor, type RenderTargetDescriptor } from '../targets/contracts';
import { createRenderTargetPhysical, destroyRenderTargetPhysical } from '../targets/physical';

const cases: readonly [string, RenderTargetDescriptor, number][] = [
  [
    'thin full chain',
    {
      shape: '2d',
      width: 8,
      height: 1,
      format: 'rgba8unorm',
      mipLevels: 'full',
      sampleCount: 1,
      sampled: true,
      readback: true,
    },
    124,
  ],
  [
    'one texel with MSAA',
    {
      shape: '2d',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      mipLevels: 'full',
      sampleCount: 4,
      sampled: true,
      readback: true,
    },
    52,
  ],
  [
    'MSAA cube',
    {
      shape: 'cube',
      width: 4,
      height: 4,
      format: 'rgba16float',
      mipLevels: 'full',
      sampleCount: 4,
      sampled: true,
      readback: true,
    },
    4592,
  ],
  [
    'volume',
    {
      shape: '3d',
      width: 4,
      height: 2,
      depthOrArrayLayers: 3,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    },
    160,
  ],
  [
    'array with full chain',
    {
      shape: '2d-array',
      width: 4,
      height: 2,
      depthOrArrayLayers: 3,
      format: 'rgba8unorm-srgb',
      mipLevels: 'full',
      sampleCount: 1,
      sampled: true,
      readback: true,
    },
    196,
  ],
];

function allocatedBytes(descriptor: TextureDescriptor): number {
  const bytes =
    descriptor.format === 'rgba16float' || descriptor.format === 'depth32float-stencil8' ? 8 : 4;
  const size = descriptor.size as GPUExtent3DDict;
  let width = size.width;
  let height = size.height ?? 1;
  let depth = size.depthOrArrayLayers ?? 1;
  let result = 0;
  for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++) {
    result += width * height * depth * bytes * (descriptor.sampleCount ?? 1);
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    if (descriptor.dimension === '3d') depth = Math.max(1, Math.floor(depth / 2));
  }
  return result;
}

describe('RenderTarget admitted storage and physical allocation', () => {
  it.each(cases)('%s charges every allocated texel', async (_name, descriptor, expectedBytes) => {
    const limits = {
      maxTextureDimension2D: 4096,
      maxTextureDimension3D: 256,
      maxTextureArrayLayers: 16,
      maxBytesPerTarget: expectedBytes,
      renderableFormats: ['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float'] as const,
      sampleCounts: [1, 4] as const,
      depthFormats: ['depth32float-stencil8'] as const,
    };
    expect(admitRenderTargetDescriptor(descriptor, limits).ok).toBe(true);
    expect(
      admitRenderTargetDescriptor(descriptor, { ...limits, maxBytesPerTarget: expectedBytes - 1 })
        .ok,
    ).toBe(false);
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocations = vi.spyOn(device, 'createTexture');
    const physical = createRenderTargetPhysical(device, descriptor, 0);
    if (!physical.ok) throw physical.error;
    try {
      expect(allocations.mock.calls.reduce((sum, [desc]) => sum + allocatedBytes(desc), 0)).toBe(
        expectedBytes,
      );
      expect(physical.value.mipViews.length).toBe(
        descriptor.mipLevels === 1
          ? 1
          : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1,
      );
    } finally {
      destroyRenderTargetPhysical(physical.value);
      allocations.mockRestore();
    }
  });
});
