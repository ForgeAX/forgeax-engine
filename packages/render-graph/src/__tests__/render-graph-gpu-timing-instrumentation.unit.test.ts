import type {
  Buffer,
  ComputePassDescriptor,
  RenderPassDescriptor,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { RenderGraphFrame, RenderGraphPassInstrumentation } from '../types.js';

interface Frame extends RenderGraphFrame {
  readonly source: Buffer;
}

function mockDevice(): RhiDevice {
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
    queue: { onSubmittedWorkDone: async () => undefined } as never,
    createTexture: () => ({ ok: true, value: { id: nextId++ } as unknown as Texture }),
    createTextureView: () => ({ ok: true, value: { id: nextId++ } as unknown as TextureView }),
    createBuffer: () => ({ ok: true, value: { id: nextId++ } as unknown as Buffer }),
    destroyTexture: () => ({ ok: true, value: undefined }),
    destroyBuffer: () => ({ ok: true, value: undefined }),
  } as unknown as RhiDevice;
}

function buildGraph() {
  const graph = new RenderGraphBuilder<Frame>();
  const color = graph.createTexture('color', { format: 'rgba8unorm', size: 'surface' });
  if (!color.ok) throw color.error;
  const view = graph.view(color.value);
  if (!view.ok) throw view.error;
  graph.addRasterPass('raster', {
    accesses: [{ resource: view.value, usage: 'color-attachment' }],
    colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
    encode: () => undefined,
  });
  graph.addComputePass('compute', { accesses: [], encode: () => undefined });
  graph.addCopyPass('copy', { accesses: [], encode: () => undefined });
  graph.addComputePass('skipped', {
    accesses: [],
    executeIf: () => false,
    encode: () => undefined,
  });
  return graph;
}

function mockEncoder(events: string[]): RhiCommandEncoder {
  return {
    beginRenderPass: (descriptor: RenderPassDescriptor) => {
      events.push(`begin-raster:${descriptor.timestampWrites === undefined ? 'none' : 'timed'}`);
      return { end: () => events.push('end-raster') } as unknown as RhiRenderPassEncoder;
    },
    beginComputePass: (descriptor: ComputePassDescriptor = {}) => {
      events.push(`begin-compute:${descriptor.timestampWrites === undefined ? 'none' : 'timed'}`);
      return { end: () => events.push('end-compute') } as unknown as RhiComputePassEncoder;
    },
    clearBuffer: () => events.push('clear-buffer'),
  } as unknown as RhiCommandEncoder;
}

function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error('expected ok result');
  return result.value;
}

describe('RenderGraph actual-pass timing instrumentation', () => {
  it('reports only actual passes with compiled provenance and injects at pass boundaries', () => {
    const graph = buildGraph();
    const compiled = graph.compile({
      device: mockDevice(),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const events: string[] = [];
    const actualPasses: string[] = [];
    const instrumentation: RenderGraphPassInstrumentation<Frame> = {
      begin(pass) {
        actualPasses.push(`${pass.executionIndex}:${pass.kind}:${pass.name}`);
        return {
          renderPassDescriptor: (descriptor) => ({
            ...descriptor,
            timestampWrites: {
              querySet: {} as never,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: 1,
            },
          }),
          computePassDescriptor: (descriptor) => ({
            ...descriptor,
            timestampWrites: {
              querySet: {} as never,
              beginningOfPassWriteIndex: 2,
              endOfPassWriteIndex: 3,
            },
          }),
          beforeCopy: () => events.push('before-copy'),
          afterCopy: () => events.push('after-copy'),
        };
      },
    };

    const result = value(compiled).execute(
      { encoder: mockEncoder(events), source: {} as Buffer },
      undefined,
      instrumentation,
    );
    expect(result.ok).toBe(true);
    expect(actualPasses).toEqual(['0:raster:raster', '1:compute:compute', '2:copy:copy']);
    expect(events).toEqual([
      'begin-raster:timed',
      'end-raster',
      'begin-compute:timed',
      'end-compute',
      'before-copy',
      'after-copy',
    ]);
  });

  it('keeps the no-hook graph and command ledger equivalent', () => {
    const graph = buildGraph();
    const compiled = graph.compile({
      device: mockDevice(),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const events: string[] = [];
    const result = value(compiled).execute({ encoder: mockEncoder(events), source: {} as Buffer });
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      'begin-raster:none',
      'end-raster',
      'begin-compute:none',
      'end-compute',
    ]);
    expect(
      value(compiled)
        .inspect()
        .passes.map(({ name, kind, executionIndex }) => ({
          name,
          kind,
          executionIndex,
        })),
    ).toEqual([
      { name: 'raster', kind: 'raster', executionIndex: 0 },
      { name: 'compute', kind: 'compute', executionIndex: 1 },
      { name: 'copy', kind: 'copy', executionIndex: 2 },
      { name: 'skipped', kind: 'compute', executionIndex: 3 },
    ]);
  });
});
