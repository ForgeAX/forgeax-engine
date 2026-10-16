import { type GraphBufferAccess, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeaturePlanExecutionPass } from '../features/host';
import type {
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuProgramRef,
} from '../features/prepared-gpu-work';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
  projectRenderFeatureShadows,
} from '../features/render-graph-contribution';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureTarget } from '../features/targets';

it.each([
  'sampledTargets',
  'storageTargets',
] as const)('coalesces early compute without crossing a %s hoist boundary', (targetRole) => {
  const builder = new RenderGraphBuilder();
  const added = vi.spyOn(builder, 'addComputePass');
  const prepareDraws = vi
    .spyOn(RenderFeatureRasterGraphProjection.prototype, 'prepareShadowDraws')
    .mockReturnValue(ok({ accesses: [], encode() {} }));
  try {
    const target = createRenderFeatureTarget({
      kind: 'scene-depth',
      format: 'depth24plus-stencil8',
      sampleCount: 1,
    });
    const shared = {} as Buffer;
    const independentBuffer = {} as Buffer;
    const program = {} as RenderFeatureGpuProgramRef;
    const bindings = {} as RenderFeatureGpuBindingsRef;
    const compute = (
      name: string,
      buffer: Buffer,
      sampled = false,
    ): RenderFeaturePlanExecutionPass => ({
      featureIdentity: 'ordered',
      order: 0,
      name,
      gpuCompute: { program, bindings, dispatches: [] },
      resolvedGpuCompute: {
        buffers: [{ name, buffer, size: 16, physicalUsage: 128, access: 'storage-read-write' }],
        dispatches: [],
        ...(sampled ? { [targetRole]: [target] } : {}),
      },
    });
    const early = compute('early', shared);
    const adjacent = compute('adjacent', shared);
    const late = compute('late-depth', shared, true);
    const dependent = compute('late-projection', shared);
    const independent = compute('independent-emitter', independentBuffer);
    const shadow: RenderFeaturePlanExecutionPass = {
      featureIdentity: 'ordered',
      order: 0,
      name: 'shadow',
      shadowCaster: true,
      graphics: { attachments: { colors: [] }, draws: [] },
      graphicsState: {} as never,
      resolvedGraphics: {} as never,
    };
    const executions = [
      {
        featureIdentity: 'ordered',
        order: 0,
        passes: [early, adjacent, late, dependent, independent, shadow],
      },
    ];
    const state = createRenderFeatureProjectionState();
    expect(projectRenderFeatureShadows(builder, executions, state).ok).toBe(true);
    expect(added.mock.calls.map(([name]) => name)).toEqual(['early', 'independent-emitter']);
    expect([...state.projected]).toEqual([early, adjacent, independent, shadow]);
    const texture = builder
      .createTexture('depth', {
        format: 'depth24plus-stencil8',
        size: { width: 16, height: 16 },
        usage: 20,
      })
      .unwrap();
    const view = builder.view(texture).unwrap();
    expect(
      projectRenderFeaturePlans(builder, executions, {
        state,
        resolveTarget: () => ({ texture, view }),
      }).ok,
    ).toBe(true);
    expect(added.mock.calls.map(([name]) => name)).toEqual([
      'early',
      'independent-emitter',
      'late-depth',
      'late-projection',
    ]);
    expect(prepareDraws).toHaveBeenCalledOnce();
  } finally {
    prepareDraws.mockRestore();
    added.mockRestore();
  }
});

it.each([
  ['storage-write', 'storage-read', false],
  ['storage-read', 'storage-write', false],
  ['storage-write', 'storage-write', false],
  ['storage-read', 'storage-read', true],
] as const)('preserves cross-feature %s -> %s hazards', (first, second, early) => {
  const builder = new RenderGraphBuilder();
  const buffer = {} as Buffer;
  const added = vi.spyOn(builder, 'addComputePass');
  const prepare = vi
    .spyOn(RenderFeatureRasterGraphProjection.prototype, 'prepareShadowDraws')
    .mockReturnValue(ok({ accesses: [], encode() {} }));
  const target = createRenderFeatureTarget({
    kind: 'scene-depth',
    format: 'depth24plus-stencil8',
    sampleCount: 1,
  });
  const compute = (
    name: string,
    access: GraphBufferAccess,
    sampled: boolean,
  ): RenderFeaturePlanExecutionPass => ({
    featureIdentity: name,
    order: 0,
    name,
    resolvedGpuCompute: {
      buffers: [{ name, buffer, size: 16, physicalUsage: 128, access }],
      dispatches: [],
      sampledTargets: sampled ? [target] : [],
    },
  });
  const shadow: RenderFeaturePlanExecutionPass = {
    featureIdentity: 'second',
    order: 0,
    name: 'shadow',
    shadowCaster: true,
    graphics: { attachments: { colors: [] }, draws: [] },
    graphicsState: {} as never,
    resolvedGraphics: {} as never,
  };
  try {
    const result = projectRenderFeatureShadows(
      builder,
      [
        { featureIdentity: 'first', order: 0, passes: [compute('first', first, true)] },
        { featureIdentity: 'second', order: 1, passes: [compute('second', second, false), shadow] },
      ],
      createRenderFeatureProjectionState(),
    );
    expect(result.ok).toBe(true);
    expect(added.mock.calls.map(([name]) => name)).toEqual(early ? ['second'] : []);
  } finally {
    prepare.mockRestore();
    added.mockRestore();
  }
});

it('does not move writes ahead of prior raster vertex, index or indirect reads', () => {
  const builder = new RenderGraphBuilder();
  const added = vi.spyOn(builder, 'addComputePass');
  const prepare = vi
    .spyOn(RenderFeatureRasterGraphProjection.prototype, 'prepareShadowDraws')
    .mockReturnValue(ok({ accesses: [], encode() {} }));
  const vertex = { kind: 'vertex-data' as const, generation: 1 };
  const index = { kind: 'index-data' as const, generation: 1 };
  const indirect = {} as RenderFeatureGpuBufferRef;
  const buffers = [{} as Buffer, {} as Buffer, {} as Buffer];
  const raster: RenderFeaturePlanExecutionPass = {
    featureIdentity: 'raster',
    order: 0,
    name: 'raster',
    graphics: {
      attachments: { colors: [] },
      draws: [
        {
          kind: 'draw-indexed-indirect',
          pipeline: { kind: 'pipeline', generation: 1 },
          bindings: [],
          vertexData: [{ slot: 0, resource: vertex }],
          indexData: { resource: index, format: 'uint32' },
          command: { buffer: indirect },
        },
      ],
    },
    resolvedGraphics: {
      generation: 1,
      resolve: (reference) =>
        reference === vertex || reference === index
          ? {
              kind: reference.kind as 'vertex-data' | 'index-data',
              reference,
              handle: buffers[reference === vertex ? 0 : 1] as Buffer,
              size: 16,
              physicalUsage: 368,
            }
          : undefined,
      resolveGpuBuffer: () => ({ buffer: buffers[2] as Buffer, size: 16, physicalUsage: 368 }),
    },
  };
  const writes = [...buffers, {} as Buffer].map(
    (buffer, i): RenderFeaturePlanExecutionPass => ({
      featureIdentity: 'compute',
      order: 1,
      name: `write-${i}`,
      resolvedGpuCompute: {
        buffers: [
          { name: `alias-${i}`, buffer, size: 16, physicalUsage: 368, access: 'storage-write' },
        ],
        dispatches: [],
      },
    }),
  );
  const shadow: RenderFeaturePlanExecutionPass = {
    featureIdentity: 'shadow',
    order: 2,
    name: 'shadow',
    shadowCaster: true,
    graphics: { attachments: { colors: [] }, draws: [] },
    graphicsState: {} as never,
    resolvedGraphics: {} as never,
  };
  try {
    expect(
      projectRenderFeatureShadows(
        builder,
        [{ featureIdentity: 'mixed', order: 0, passes: [raster, ...writes, shadow] }],
        createRenderFeatureProjectionState(),
      ).ok,
    ).toBe(true);
    expect(added.mock.calls.map(([name]) => name)).toEqual(['write-3']);
  } finally {
    prepare.mockRestore();
    added.mockRestore();
  }
});
