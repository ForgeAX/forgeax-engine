import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipeline } from '@forgeax/engine-rhi';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureGraphBufferState } from '../features/render-graph-resources';
import type {
  PreparedGraphicsResolvedResource,
  PreparedGraphicsResolvedSnapshot,
} from '../prepare/prepared-graphics-resolver';

interface Ranges {
  readonly vertexOffset: number;
  readonly vertexLength: number;
  readonly indexOffset: number;
  readonly indexLength: number;
}

function bufferReferences() {
  return {
    vertex: { kind: 'vertex-data', generation: 1 } as const,
    index: { kind: 'index-data', generation: 1 } as const,
  };
}

async function fixture(initialRanges: Ranges) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const physicalUsage = 0x0020 | 0x0010 | 0x0008;
  const physical = device.createBuffer({ size: 2048, usage: physicalUsage }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const graph = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  const target = graph
    .createTexture('color', {
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: 0x0010,
    })
    .unwrap();
  const view = graph.view(target).unwrap();
  const pipeline = { kind: 'pipeline', generation: 1 } as const;
  const binding = { kind: 'bindings', generation: 1 } as const;
  const initialReferences = bufferReferences();
  const declaration = (
    references: ReturnType<typeof bufferReferences>,
    ranges?: Ranges,
    format: 'uint16' | 'uint32' = 'uint16',
  ): {
    readonly descriptor: RenderFeatureGraphicsPassDescriptor;
    readonly snapshot: PreparedGraphicsResolvedSnapshot;
  } => {
    const resolved = new Map<RenderFeaturePreparedRef, PreparedGraphicsResolvedResource>([
      [pipeline, { kind: 'pipeline', reference: pipeline, handle: {} as RenderPipeline }],
      [binding, { kind: 'bindings', reference: binding, handle: group }],
      [
        references.vertex,
        {
          kind: 'vertex-data',
          reference: references.vertex,
          handle: physical,
          size: 2048,
          physicalUsage,
          ...(ranges === undefined
            ? {}
            : { byteOffset: ranges.vertexOffset, byteLength: ranges.vertexLength }),
        },
      ],
      [
        references.index,
        {
          kind: 'index-data',
          reference: references.index,
          handle: physical,
          size: 2048,
          physicalUsage,
          ...(ranges === undefined
            ? {}
            : { byteOffset: ranges.indexOffset, byteLength: ranges.indexLength }),
        },
      ],
    ]);
    return {
      descriptor: {
        attachments: {
          colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'clear', storeOp: 'store' }],
        },
        draws: [
          {
            kind: 'draw-indexed',
            pipeline,
            bindings: [binding],
            vertexData: [{ slot: 3, resource: references.vertex }],
            indexData: { resource: references.index, format },
            command: { indexCount: 3, instanceCount: 1 },
          },
        ],
      },
      snapshot: { generation: 1, resolve: (reference) => resolved.get(reference) },
    };
  };
  const initial = declaration(initialReferences, initialRanges);
  const buffers = createRenderFeatureGraphBufferState();
  const projection = new RenderFeatureRasterGraphProjection(
    graph,
    () => ({ texture: target, view }),
    undefined,
    buffers,
  );
  projection
    .addPass(
      'draw',
      'raster-ranges',
      0,
      initial.descriptor,
      {
        capabilityAvailable: true,
        generation: 1,
        attachments: [{ resource: 'color', format: 'rgba8unorm' }],
        pipeline,
        pipelines: [pipeline],
        bindings: [binding],
        vertexData: [initialReferences.vertex],
        indexData: [initialReferences.index],
      },
      initial.snapshot,
    )
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  return {
    physical,
    buffers,
    declaration,
    execute(current?: ReturnType<typeof declaration>) {
      const encoder = device.createCommandEncoder().unwrap();
      compiled
        .execute({
          encoder,
          ...(current === undefined
            ? {}
            : {
                featureExecutions: [
                  {
                    featureIdentity: 'raster-ranges',
                    order: 0,
                    passes: [
                      {
                        featureIdentity: 'raster-ranges',
                        order: 0,
                        name: 'draw',
                        graphics: current.descriptor,
                        resolvedGraphics: current.snapshot,
                      },
                    ],
                  },
                ],
              }),
        })
        .unwrap();
      encoder.finish().unwrap();
    },
    async dispose() {
      await compiled.retire();
      device.destroyBuffer(physical).unwrap();
    },
  };
}

describe('RenderFeature raster buffer ranges', () => {
  it('encodes nonzero vertex slots and index ranges while importing one shared physical dependency', async () => {
    const f = await fixture({
      vertexOffset: 256,
      vertexLength: 96,
      indexOffset: 512,
      indexLength: 24,
    });
    const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
    const indices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
    try {
      f.execute();
      expect(f.buffers.handles.size).toBe(1);
      expect(f.buffers.handles.has(f.physical)).toBe(true);
      expect(vertices.mock.calls).toEqual([[3, f.physical, 256, 96]]);
      expect(indices.mock.calls).toEqual([[f.physical, 'uint16', 512, 24]]);
    } finally {
      vertices.mockRestore();
      indices.mockRestore();
      await f.dispose();
    }
  });

  it('uses current-frame references, ranges and index format when the compiled graph is retained', async () => {
    const f = await fixture({
      vertexOffset: 256,
      vertexLength: 96,
      indexOffset: 512,
      indexLength: 24,
    });
    const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
    const indices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
    try {
      f.execute();
      f.execute(
        f.declaration(
          bufferReferences(),
          {
            vertexOffset: 768,
            vertexLength: 128,
            indexOffset: 1024,
            indexLength: 48,
          },
          'uint32',
        ),
      );
      f.execute(f.declaration(bufferReferences()));

      expect(f.buffers.handles.size).toBe(1);
      expect(vertices.mock.calls).toEqual([
        [3, f.physical, 256, 96],
        [3, f.physical, 768, 128],
        [3, f.physical],
      ]);
      expect(indices.mock.calls).toEqual([
        [f.physical, 'uint16', 512, 24],
        [f.physical, 'uint32', 1024, 48],
        [f.physical, 'uint16'],
      ]);
    } finally {
      vertices.mockRestore();
      indices.mockRestore();
      await f.dispose();
    }
  });
});
