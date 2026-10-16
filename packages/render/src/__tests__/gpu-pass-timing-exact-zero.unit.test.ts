import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  ComputePassDescriptor,
  RenderPassDescriptor,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';

interface Frame {
  readonly encoder: RhiCommandEncoder;
}

function device(ledger: string[]) {
  let nextId = 0;
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
    queue: {
      onSubmittedWorkDone: vi.fn(async () => {
        ledger.push('queue-completion');
      }),
    },
    createQuerySet: vi.fn(() => {
      ledger.push('create-query-set');
      return { ok: true, value: {} };
    }),
    createBuffer: vi.fn(() => {
      ledger.push('create-buffer');
      return { ok: true, value: {} };
    }),
    createTexture: () => ({ ok: true, value: { id: nextId++ } as unknown as Texture }),
    createTextureView: () => ({ ok: true, value: { id: nextId++ } as unknown as TextureView }),
    destroyTexture: () => ({ ok: true, value: undefined }),
    destroyBuffer: () => ({ ok: true, value: undefined }),
  } as unknown as RhiDevice;
}

function encoder(ledger: string[]): RhiCommandEncoder {
  return {
    beginRenderPass: (descriptor: RenderPassDescriptor) => {
      ledger.push(
        descriptor.timestampWrites === undefined ? 'raster-no-timestamp' : 'raster-timestamp',
      );
      return { end: () => undefined } as unknown as RhiRenderPassEncoder;
    },
    beginComputePass: (descriptor: ComputePassDescriptor = {}) => {
      ledger.push(
        descriptor.timestampWrites === undefined ? 'compute-no-timestamp' : 'compute-timestamp',
      );
      return { end: () => undefined } as unknown as RhiComputePassEncoder;
    },
    encodeEmptyComputePass: (descriptor: ComputePassDescriptor) => {
      ledger.push(
        descriptor.timestampWrites === undefined ? 'compute-marker-no-timestamp' : 'compute-marker',
      );
    },
    resolveQuerySet: vi.fn(() => {
      ledger.push('resolve-query-set');
      return { ok: true, value: undefined };
    }),
    copyBufferToBuffer: vi.fn(() => ledger.push('copy-timing-buffer')),
  } as unknown as RhiCommandEncoder;
}

describe('GPU pass timing exact-zero off path', () => {
  it('keeps feature resources, commands, queue waits, maps, facts, and profiler GPU records at zero', () => {
    const ledger: string[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    const color = graph.createTexture('color', { format: 'rgba8unorm', size: 'surface' });
    expect(color.ok).toBe(true);
    if (!color.ok) return;
    const view = graph.view(color.value);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    graph.addRasterPass('scene', {
      accesses: [{ resource: view.value, usage: 'color-attachment' }],
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    graph.addComputePass('producer', { accesses: [], encode: () => undefined });
    graph.addCopyPass('copy', { accesses: [], encode: () => undefined });
    graph.addComputePass('skipped', {
      accesses: [],
      executeIf: () => false,
      encode: () => undefined,
    });
    const compiled = graph.compile({
      device: device(ledger),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const result = compiled.value.execute({ encoder: encoder(ledger) });

    expect(result.ok).toBe(true);
    expect(ledger).toEqual(['raster-no-timestamp', 'compute-no-timestamp']);
    expect(ledger).not.toContain('create-query-set');
    expect(ledger).not.toContain('create-buffer');
    expect(ledger).not.toContain('resolve-query-set');
    expect(ledger).not.toContain('copy-timing-buffer');
    expect(ledger).not.toContain('queue-completion');
    expect(ledger).not.toContain('map-readback');
  });
});
