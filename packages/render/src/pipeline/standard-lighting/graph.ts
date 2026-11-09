import type {
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { RenderGraphError as RenderGraphFailure } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../../gpu-usage';
import { getOrCreateHdrpBuffers, type HdrpBuffers } from '../../hdrp-buffers';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { addTypedSsaoClusterPackPass } from '../../typed-render-graph-primitives';
import type { StandardClusterTextureExtent } from './texture';
import { standardClusterTextureLayout } from './texture';
import type { StandardTopologyInputValue } from './topology';

/** Graph resources projected from one Standard lighting topology input. */
interface StandardClusterStorageGraphBuffers {
  readonly kind: 'storage';
  readonly lightData: GraphBuffer;
  readonly clusterGrid: GraphBuffer;
  readonly lightIndexList: GraphBuffer;
  readonly clusterUniform: GraphBuffer;
  readonly lightBounds: GraphBuffer;
}

export type StandardClusterGraphBuffers =
  | StandardClusterStorageGraphBuffers
  | {
      readonly kind: 'texture';
      readonly texture: GraphTextureView;
      readonly clusterUniform: GraphBuffer;
      readonly textureLayout: ReturnType<typeof standardClusterTextureLayout>;
    };

/** Stable graph-time projection; never retain a frame's typed-array payload. */
interface StandardClusterGraphDescriptor {
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly aoExtent?: StandardClusterTextureExtent | undefined;
}

function projectDescriptor(
  input: StandardTopologyInputValue,
  aoExtent?: StandardClusterTextureExtent,
): StandardClusterGraphDescriptor {
  const { x, y, z } = input.prepared.layout.grid;
  return { grid: { x, y, z }, ...(aoExtent === undefined ? {} : { aoExtent }) };
}

function resolveBuffers(
  frame: RenderPipelineFrame,
  descriptor: StandardClusterGraphDescriptor,
): HdrpBuffers {
  const internal = frame as _InternalRenderPipelineContext;
  const buffers = getOrCreateHdrpBuffers(internal.runtime, descriptor.grid, descriptor.aoExtent);
  if (buffers === null) throw new Error('Standard persistent buffer allocation failed');
  return buffers;
}

/** Resolve membership execution from the frame's current prepared payload. */
export function shouldExecuteStandardClusterMembershipPass(frame: RenderPipelineFrame): boolean {
  const standardLighting = (frame as _InternalRenderPipelineContext).standardLighting;
  return (
    standardLighting?.kind === 'clustered' &&
    standardLighting.transport.kind === 'compute-storage' &&
    standardLighting.prepared.local.length > 0
  );
}

/** Import the shared Standard Cluster buffers with sizes derived from layout. */
export function importStandardClusterBuffers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTopologyInputValue,
  aoExtent?: StandardClusterTextureExtent,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  if (input.kind !== 'clustered') return ok(null);
  const layout = input.prepared.layout;
  const descriptor = projectDescriptor(input, aoExtent);
  if (input.transport.kind === 'cpu-texture') {
    const textureLayout = standardClusterTextureLayout(
      layout,
      input.transport.lightDataSlotBytes,
      aoExtent,
    );
    const texture = graph.importTexture(
      'standard-cluster-tables',
      {
        size: {
          width: textureLayout.width,
          height: textureLayout.height,
          depthOrArrayLayers: 1,
        },
        format: 'rgba32uint',
        usage: 0x02 | 0x04 | (aoExtent === undefined ? 0 : 0x10 | GPU_TEXTURE_USAGE_COPY_SRC),
      },
      (frame) => {
        const buffers = resolveBuffers(frame, descriptor);
        if (buffers.kind !== 'texture') throw new Error('Standard texture transport changed');
        return buffers.texture;
      },
    );
    if (!texture.ok) return texture;
    const view = graph.importView(texture.value, { dimension: '2d' }, (frame) => {
      const buffers = resolveBuffers(frame, descriptor);
      if (buffers.kind !== 'texture') throw new Error('Standard texture transport changed');
      return buffers.view;
    });
    if (!view.ok) return view;
    const uniform = graph.importBuffer(
      'hdrp-cluster-uniform',
      {
        size: input.transport.clusterUniformBytes,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      },
      (frame) => resolveBuffers(frame, descriptor).clusterUniformBuffer,
    );
    if (!uniform.ok) return uniform;
    return ok({
      kind: 'texture',
      texture: view.value,
      clusterUniform: uniform.value,
      textureLayout,
    });
  }
  const storage = (frame: RenderPipelineFrame) => {
    const buffers = resolveBuffers(frame, descriptor);
    if (buffers.kind !== 'storage') throw new Error('Standard storage transport changed');
    return buffers;
  };
  const usage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;
  const lightData = graph.importBuffer(
    'hdrp-light-data',
    { size: layout.lightDataSlotCount * input.transport.lightDataSlotBytes, usage },
    (frame) => storage(frame).lightDataBuffer,
  );
  if (!lightData.ok) return lightData;
  const clusterGrid = graph.importBuffer(
    'hdrp-cluster-grid',
    { size: layout.clusterGridU32Length * 4, usage },
    (frame) => storage(frame).clusterGridBuffer,
  );
  if (!clusterGrid.ok) return clusterGrid;
  const lightIndexList = graph.importBuffer(
    'hdrp-light-index-list',
    { size: layout.lightIndexListCapacity * 4, usage },
    (frame) => storage(frame).lightIndexListBuffer,
  );
  if (!lightIndexList.ok) return lightIndexList;
  const clusterUniform = graph.importBuffer(
    'hdrp-cluster-uniform',
    {
      size: input.transport.clusterUniformBytes,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    },
    (frame) => resolveBuffers(frame, descriptor).clusterUniformBuffer,
  );
  if (!clusterUniform.ok) return clusterUniform;
  const lightBounds = graph.importBuffer(
    'hdrp-light-bounds',
    { size: layout.lightBoundsInt32Length * 4, usage },
    (frame) => storage(frame).lightBoundsBuffer,
  );
  if (!lightBounds.ok) return lightBounds;
  return ok({
    kind: 'storage',
    lightData: lightData.value,
    clusterGrid: clusterGrid.value,
    lightIndexList: lightIndexList.value,
    clusterUniform: clusterUniform.value,
    lightBounds: lightBounds.value,
  });
}

/** Accesses used by raster consumers of the shared Cluster payload. */
export function standardClusterReadAccesses(
  buffers: StandardClusterGraphBuffers,
): readonly GraphAccess[] {
  if (buffers.kind === 'texture')
    return [
      { resource: buffers.texture, usage: 'sampled-read' },
      { resource: buffers.clusterUniform, usage: 'uniform-read' },
    ];
  return [
    { resource: buffers.lightData, usage: 'storage-read' },
    { resource: buffers.clusterGrid, usage: 'storage-read' },
    { resource: buffers.lightIndexList, usage: 'storage-read' },
    { resource: buffers.clusterUniform, usage: 'uniform-read' },
  ];
}

/** Add the AO producer to the spare region of the no-storage Cluster texture. */
export function addStandardClusterAoPackPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  buffers: StandardClusterGraphBuffers,
  source: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  if (buffers.kind !== 'texture') return ok(undefined);
  const region = buffers.textureLayout.ao;
  if (region === undefined) {
    return err(
      new RenderGraphFailure({
        code: 'resource-descriptor-invalid',
        expected: 'the no-storage Cluster texture reserves an initialized AO region',
        hint: 'rebuild the Cluster texture generation with the current AO extent',
        detail: {
          resourceLabel: 'standard-cluster-tables',
          field: 'ao-region',
          expected: 'disjoint initialized AO region',
          actual: 'missing',
        },
      }),
    );
  }
  return addTypedSsaoClusterPackPass(graph, { source, output: buffers.texture, region });
}

/**
 * Add the sole GPU membership producer. CPU membership is already materialized
 * in PreparedStandardLighting and therefore contributes no second pass.
 */
export function addStandardClusterMembershipPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTopologyInputValue,
  buffers: StandardClusterGraphBuffers,
): Result<void, RenderGraphError> {
  if (input.kind !== 'clustered') return ok(undefined);
  if (input.transport.kind !== 'compute-storage') return ok(undefined);
  if (buffers.kind !== 'storage') throw new Error('GPU membership requires storage transport');
  const descriptor = projectDescriptor(input);
  return graph.addComputePass('cluster-membership-producer', {
    accesses: [
      { resource: buffers.clusterGrid, usage: 'storage-read-write' },
      { resource: buffers.clusterUniform, usage: 'uniform-read' },
      { resource: buffers.lightBounds, usage: 'storage-read' },
      { resource: buffers.lightIndexList, usage: 'storage-write' },
    ],
    // Keep the clustered graph/ABI stable for a directional-only frame, but
    // do not require a producer bind group when there is no local corpus to
    // bin.  The zero-length prepared payload is already the complete result;
    // executing this pass would only turn an otherwise valid frame into a
    // null-backend encode failure.
    executeIf: shouldExecuteStandardClusterMembershipPass,
    encodeDirect: (pass, frame, _graphresources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const pipeline = internal.pipelineState.hdrpClusterMembershipPipeline;
      const bindings = internal.hdrpClusterMembershipBindGroup;
      if (pipeline === null || bindings === null) {
        throw new Error(
          'standard-cluster-transport-unavailable: selected compute Cluster producer is not ready',
        );
      }
      const { x, y, z } = descriptor.grid;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil((x * y * z) / 64));
    },
  });
}
