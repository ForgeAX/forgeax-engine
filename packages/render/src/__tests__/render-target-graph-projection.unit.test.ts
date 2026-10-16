import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder, Texture, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { projectRenderTargetGraph, type RenderTargetGraphInput } from '../targets/graph-projection';
import { createRenderTargetOwner } from '../targets/owner';

type Frame = { readonly encoder: RhiCommandEncoder };

const owner = createRenderTargetOwner({ rendererId: Symbol('renderer'), getGeneration: () => 3 });
const texture = {} as Texture;
const view = {} as TextureView;
const resolveView = {} as TextureView;

function targetInput(descriptor: RenderTargetDescriptor): RenderTargetGraphInput {
  const target = owner.create(descriptor);
  if (!target.ok) throw target.error;
  return {
    target: target.value,
    generation: 3,
    descriptor,
    texture,
    view,
    ...(descriptor.sampleCount === 4 ? { resolveView } : {}),
  };
}

describe('RenderTarget graph projection', () => {
  it('imports a 2D target with sampled/readback usage and an exact mip view', () => {
    const descriptor: RenderTargetDescriptor = {
      shape: '2d',
      width: 64,
      height: 32,
      format: 'rgba8unorm',
      mipLevels: 'full',
      sampleCount: 1,
      sampled: true,
      readback: true,
    };
    const graph = new RenderGraphBuilder<Frame>();
    const projected = projectRenderTargetGraph(graph, targetInput(descriptor), {
      mipLevel: 2,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.ownership).toBe('imported');
    expect(projected.value.generation).toBe(3);
    expect(projected.value.viewDescriptor).toMatchObject({
      dimension: '2d',
      baseMipLevel: 2,
      mipLevelCount: 1,
    });
    expect(projected.value.usage).toEqual(['sampled-read', 'copy-src']);
  });

  it('keeps cube subresources as cube views and resolves MSAA before sampling', () => {
    const descriptor: RenderTargetDescriptor = {
      shape: 'cube',
      width: 64,
      height: 64,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 4,
      sampled: true,
      readback: true,
    };
    const graph = new RenderGraphBuilder<Frame>();
    const projected = projectRenderTargetGraph(graph, targetInput(descriptor), {
      mipLevel: 0,
      layer: 4,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.viewDescriptor).toMatchObject({
      dimension: 'cube',
      baseMipLevel: 0,
      baseArrayLayer: 4,
      arrayLayerCount: 1,
    });
    expect(projected.value.resolveView).toBeDefined();
    expect(projected.value.sampleView).toBe(projected.value.resolveView);
    expect(projected.value.usage).toEqual(['sampled-read', 'copy-src']);
  });

  it('rejects a missing MSAA resolve view without changing graph ownership', () => {
    const descriptor: RenderTargetDescriptor = {
      shape: '2d',
      width: 32,
      height: 32,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 4,
      sampled: true,
      readback: false,
    };
    const graph = new RenderGraphBuilder<Frame>();
    const input = targetInput(descriptor);
    const projected = projectRenderTargetGraph(graph, { ...input, resolveView: undefined });
    expect(projected.ok).toBe(false);
    if (!projected.ok) expect(projected.error.code).toBe('render-target-operation-failed');
  });
});
