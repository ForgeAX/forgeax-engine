import { describe, expect, it } from 'vitest';
import {
  RenderTargetCapabilityMissingError,
  RenderTargetDescriptorInvalidError,
} from '../errors/render';
import {
  admitRenderTargetDescriptor,
  type RenderTargetAdmissionLimits,
  type RenderTargetDescriptor,
} from '../targets/contracts';

const limits: RenderTargetAdmissionLimits = {
  maxTextureDimension2D: 4096,
  maxTextureDimension3D: 256,
  maxTextureArrayLayers: 16,
  maxBytesPerTarget: 64 * 1024 * 1024,
  renderableFormats: ['rgba16float', 'rgba8unorm', 'rgba8unorm-srgb'],
  sampleCounts: [1, 4],
  depthFormats: ['depth24plus-stencil8', 'depth32float'],
};

const base: RenderTargetDescriptor = {
  shape: '2d',
  width: 512,
  height: 256,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: true,
};

describe('RenderTarget descriptor admission', () => {
  it('accepts the complete first-version descriptor vocabulary', () => {
    const result = admitRenderTargetDescriptor(base, limits);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
    ['non-square cube', { shape: 'cube' as const }],
  ])('rejects %s before allocation', (_name, patch) => {
    const descriptor = { ...base, ...patch };
    if ('shape' in patch && patch.shape === 'cube') descriptor.height = 256;
    const result = admitRenderTargetDescriptor(descriptor, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('render-target-descriptor-invalid');
  });

  it('rejects unsupported format, sample count, and byte budget', () => {
    const formatResult = admitRenderTargetDescriptor(
      { ...base, format: 'rgba16float' },
      { ...limits, renderableFormats: ['rgba8unorm'] },
    );
    expect(formatResult.ok).toBe(false);
    if (!formatResult.ok) expect(formatResult.error.code).toBe('render-target-capability-missing');

    const sampleResult = admitRenderTargetDescriptor(
      { ...base, sampleCount: 4 },
      { ...limits, sampleCounts: [1] },
    );
    expect(sampleResult.ok).toBe(false);
    if (!sampleResult.ok) expect(sampleResult.error.code).toBe('render-target-capability-missing');

    const bytesResult = admitRenderTargetDescriptor(
      { ...base, width: 2048, height: 2048, mipLevels: 'full' },
      { ...limits, maxBytesPerTarget: 1024 },
    );
    expect(bytesResult.ok).toBe(false);
    if (!bytesResult.ok) expect(bytesResult.error.code).toBe('render-target-descriptor-invalid');
  });

  it('does not reinterpret format or silently fall back on depth', () => {
    const result = admitRenderTargetDescriptor(
      { ...base, depth: 'depth32float' },
      { ...limits, depthFormats: ['depth24plus-stencil8'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error instanceof RenderTargetCapabilityMissingError) {
      expect(result.error.code).toBe('render-target-capability-missing');
      expect(result.error.detail.requested).toBe('depth32float');
    }
  });

  it('admits layered shapes against their own dimension and layer limits', () => {
    const volume: RenderTargetDescriptor = {
      ...base,
      shape: '3d',
      width: 64,
      height: 64,
      depthOrArrayLayers: 8,
    };
    const layers: RenderTargetDescriptor = { ...base, shape: '2d-array', depthOrArrayLayers: 16 };
    expect(admitRenderTargetDescriptor(volume, limits).ok).toBe(true);
    expect(admitRenderTargetDescriptor(layers, limits).ok).toBe(true);

    const wideVolume = admitRenderTargetDescriptor({ ...volume, width: 512 }, limits);
    expect(wideVolume.ok).toBe(false);
    if (!wideVolume.ok) expect(wideVolume.error.code).toBe('render-target-descriptor-invalid');

    const deepVolume = admitRenderTargetDescriptor({ ...volume, depthOrArrayLayers: 257 }, limits);
    expect(deepVolume.ok).toBe(false);
    if (!deepVolume.ok && deepVolume.error instanceof RenderTargetCapabilityMissingError) {
      expect(deepVolume.error.detail.capability).toBe('maxTextureDimension3D');
    } else throw new Error('expected a maxTextureDimension3D capability failure');

    const manyLayers = admitRenderTargetDescriptor({ ...layers, depthOrArrayLayers: 17 }, limits);
    expect(manyLayers.ok).toBe(false);
    if (!manyLayers.ok && manyLayers.error instanceof RenderTargetCapabilityMissingError) {
      expect(manyLayers.error.detail.capability).toBe('maxTextureArrayLayers');
    } else throw new Error('expected a maxTextureArrayLayers capability failure');
  });

  it.each([
    ['fractional layer count', { depthOrArrayLayers: 1.5 }, 'depthOrArrayLayers'],
    ['zero layer count', { depthOrArrayLayers: 0 }, 'depthOrArrayLayers'],
    ['multisampled volume', { sampleCount: 4 as const }, 'sampleCount'],
    ['mipmapped volume', { mipLevels: 'full' as const }, 'mipLevels'],
  ])('rejects a 3d target with %s', (_name, patch, field) => {
    const descriptor = {
      ...base,
      shape: '3d' as const,
      width: 32,
      height: 32,
      depthOrArrayLayers: 4,
      ...patch,
    };
    const result = admitRenderTargetDescriptor(descriptor, limits);
    expect(result.ok).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error instanceof RenderTargetDescriptorInvalidError) {
      expect(result.error.detail.field).toBe(field);
    } else throw new Error('expected a descriptor-invalid failure');
  });

  it('rejects an authored layer count on a shape that derives it', () => {
    const descriptor = { ...base, depthOrArrayLayers: 2 } as unknown as RenderTargetDescriptor;
    const result = admitRenderTargetDescriptor(descriptor, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('render-target-descriptor-invalid');
  });

  it('charges every layer of color but one shared depth attachment', () => {
    const layered: RenderTargetDescriptor = {
      ...base,
      shape: '2d-array',
      width: 64,
      height: 64,
      depth: 'depth32float',
      depthOrArrayLayers: 4,
    };
    const colorAndDepth = 64 * 64 * 4 * 4 + 64 * 64 * 4;
    expect(
      admitRenderTargetDescriptor(layered, { ...limits, maxBytesPerTarget: colorAndDepth }).ok,
    ).toBe(true);
    expect(
      admitRenderTargetDescriptor(layered, { ...limits, maxBytesPerTarget: colorAndDepth - 1 }).ok,
    ).toBe(false);
  });
});
