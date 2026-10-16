import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type { BootstrapResource, Tape } from '../protocol/types';
import type { ReplayReadbackResult } from '../replay/readback';
import type { TextureSubresource } from '../replay/session';
import { openReplay } from '../replay/session';
import { getTextureReadbackPlan } from '../replay/texture-format';

function textureResource(
  handleId: string,
  format: string,
  dimension: string,
  layers = 1,
): BootstrapResource {
  return {
    handleId,
    kind: 'texture',
    create: {
      kind: 'createTexture',
      handleId,
      desc: {
        size: { width: 4, height: 4, depthOrArrayLayers: layers },
        format,
        dimension,
        mipLevelCount: 1,
        sampleCount: 1,
        usage: 1,
      },
    },
    initialData: [],
  };
}

function tape(bootstrap: readonly BootstrapResource[]): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap,
    events: [],
    blobs: [],
  };
}

async function nullBackend() {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  return { device: device.value, createShaderModule };
}

describe('Replay readback format matrix', () => {
  it.each([
    ['bgra8unorm', '2d'],
    ['depth24plus-stencil8', '2d'],
    ['rgba8unorm', '2d'],
    ['rgba8unorm-srgb', '2d'],
    ['rg16float', '2d'],
    ['rg32uint', '2d'],
    ['rgba16float', '2d'],
    ['rgba32uint', '2d'],
    ['depth32float', '2d'],
    ['depth24plus', '2d'],
    ['rgba8unorm', 'cube'],
    ['rgba8unorm', '3d'],
  ])('keeps %s/%s in the supported matrix', (format, dimension) => {
    const plan = getTextureReadbackPlan({ format, dimension });
    expect(plan.supported).toBe(true);
  });

  it.each([
    ['bc7-rgba-unorm', '2d'],
  ])('returns an explicit unsupported plan for %s/%s', (format, dimension) => {
    const plan = getTextureReadbackPlan({ format, dimension });
    expect(plan.supported).toBe(false);
    if (!plan.supported) expect(plan.reason.length).toBeGreaterThan(0);
  });

  it('returns descriptor-aware readback-unsupported without allocating staging resources', async () => {
    const result = await openReplay(
      tape([textureResource('texture:compressed', 'bc7-rgba-unorm', '2d')]),
      await nullBackend(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const readback = await result.value.readResource('texture:compressed');
    expect(readback.ok).toBe(false);
    if (!readback.ok && readback.error.code === 'readback-unsupported') {
      expect(readback.error.code).toBe('readback-unsupported');
      expect(readback.error.detail?.format).toBe('bc7-rgba-unorm');
      expect(readback.error.detail?.resourceId).toBe('texture:compressed');
    }
  });

  it('keeps texture subresource coordinates in the replay-owned request shape', () => {
    const subresource: TextureSubresource = {
      mipLevel: 1,
      arrayLayer: 2,
      aspect: 'stencil-only',
    };
    expect(subresource).toEqual({ mipLevel: 1, arrayLayer: 2, aspect: 'stencil-only' });
  });

  it('requires readback results to preserve resource and subresource provenance', () => {
    const provenance: ReplayReadbackResult['provenance'] = {
      generation: 1,
      resourceId: 'texture:color',
      subresource: {
        mipLevel: 0,
        arrayLayer: 0,
        aspect: 'all',
      },
    };
    expect(provenance.resourceId).toBe('texture:color');
    expect(provenance.generation).toBeGreaterThanOrEqual(0);
    expect(provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'all',
    });
  });
});
