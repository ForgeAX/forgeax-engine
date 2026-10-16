import { ok, type RhiDevice, type Texture, type TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { RenderGraphFrame } from '../types.js';

interface Frame extends RenderGraphFrame {}

function device(overrides: Partial<RhiDevice> = {}): RhiDevice {
  return {
    caps: {
      backendKind: 'null',
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: true,
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
    },
    limits: {} as never,
    features: new Set() as never,
    queue: { onSubmittedWorkDone: async () => undefined } as never,
    createTexture: () => ok({} as Texture),
    createTextureView: () => ok({} as TextureView),
    destroyTexture: () => ok(undefined),
    destroyBuffer: () => ok(undefined),
    ...overrides,
  } as unknown as RhiDevice;
}

describe('RenderGraph texture dimension contract', () => {
  it('keeps 2d-array and 3d allocation dimensions through graph-owned resources', () => {
    const created: unknown[] = [];
    const views: unknown[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    const arrayTexture = graph.createTexture('layers', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2, depthOrArrayLayers: 3 },
      dimension: '2d',
    });
    const volumeTexture = graph.createTexture('volume', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2, depthOrArrayLayers: 3 },
      dimension: '3d',
    });
    expect(arrayTexture.ok && volumeTexture.ok).toBe(true);
    if (!arrayTexture.ok || !volumeTexture.ok) return;
    const arrayView = graph.view(arrayTexture.value, { dimension: '2d-array' });
    const volumeView = graph.view(volumeTexture.value, { dimension: '3d' });
    expect(arrayView.ok && volumeView.ok).toBe(true);
    if (!arrayView.ok || !volumeView.ok) return;
    graph.addCopyPass('seed-array', {
      accesses: [{ resource: arrayView.value, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addCopyPass('seed-volume', {
      accesses: [{ resource: volumeView.value, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    const compiled = graph.compile({
      device: device({
        createTexture: (descriptor: unknown) => {
          created.push(descriptor);
          return ok({} as Texture);
        },
        createTextureView: (_texture: Texture, descriptor: unknown) => {
          views.push(descriptor);
          return ok({} as TextureView);
        },
      }),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(compiled.ok).toBe(true);
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: '2d',
          size: { width: 2, height: 2, depthOrArrayLayers: 3 },
        }),
        expect.objectContaining({
          dimension: '3d',
          size: { width: 2, height: 2, depthOrArrayLayers: 3 },
        }),
      ]),
    );
    expect(views).toEqual(expect.arrayContaining([{ dimension: '2d-array' }, { dimension: '3d' }]));
  });
});
