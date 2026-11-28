import type { AssetVersion, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { World } from '@forgeax/engine-ecs';

import { textureReadbackLayout } from '@forgeax/engine-rhi';

import { type Asset, err, ok, type Result, textureFormatBlock } from '@forgeax/engine-types';

import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';

import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';

import type { RenderFeatureHostInspection } from '../inspection-types';

import type {
  PreparedGraphicsReference,
  PreparedGraphicsResolvedSnapshot,
  PreparedGraphicsResolver,
} from '../prepare/prepared-graphics-resolver';

import type {
  FeatureTextureReadbackDeclaration,
  FramePresentationPendingReason,
} from '../render-contract';

import { featureScopeKey, type NativeFeatureWorkRouting } from './frame-plan';

import type { PreparedPlanResources } from './native-resource-admission';

import type {
  RenderFeaturePassDeclaration,
  RenderFeaturePlannedFrame,
  RenderFeaturePlanSignatureSnapshot,
} from './plan';

import type {
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuComputePassDescriptor,
} from './prepared-gpu-work';

import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from './prepared-graphics';

import type { PreparedGraphicsStore, PreparedGraphicsTransaction } from './prepared-graphics-store';

import type {
  RenderFeature,
  RenderFeatureErrorDescriptor,
  RenderFeatureHiddenEntityReport,
  RenderFeatureStatus,
  RenderFeatureTargetHandle,
} from './types';

export const planExecutionProjections = new WeakMap<
  RenderFeaturePlannedFrame,
  {
    readonly execution: RenderFeaturePlanExecution;
    readonly nativeSignature?: string;
    readonly standardCloud?: true;
    readonly standardWater?: true;
  }
>();

export interface RenderFeaturePlanExecutionPass {
  readonly temporal?: import('./temporal-stage').RenderFeatureTemporalStage | undefined;
  readonly enabled?: boolean | undefined;
  readonly shadowCaster?: true;
  readonly featureIdentity: string;
  readonly order: number;
  readonly name: string;
  readonly graphics?: RenderFeatureGraphicsPassDescriptor;
  readonly graphicsState?: RenderFeaturePreparedGraphicsState;
  readonly gpuCompute?: RenderFeatureGpuComputePassDescriptor;
  readonly resolvedGraphics?: PreparedGraphicsResolvedSnapshot;
  readonly resolvedGpuCompute?: import('./prepared-gpu-work').RenderFeatureResolvedGpuComputePass;
  readonly resolvedGpuCopies?: readonly {
    readonly enabled?: boolean | undefined;
    readonly source: import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer;
    readonly destination: import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer;
    readonly size: number;
    readonly sourceOffset: number;
    readonly destinationOffset: number;
  }[];
  readonly textureReadbacks?: readonly {
    readonly name: string;
    readonly target: RenderFeatureTargetHandle;
  }[];
}

/** Host-owned device projection of one frozen plan; graph access is derived later. */
export interface RenderFeaturePlanExecution {
  readonly submission?: 'atomic';
  /** Canonical host-owned work scope; omitted only by direct graph adapters. */
  readonly scope?: string;
  readonly featureIdentity: string;
  readonly order: number;
  readonly placement?: import('./types').RenderFeaturePlacement;
  readonly materialTextureTargets?: readonly RenderFeatureTargetHandle[];
  readonly passes: readonly RenderFeaturePlanExecutionPass[];
}

/** @internal Typed-graph adapter for the host-owned projection of a validated plan. */
export function getRenderFeaturePlanExecutionProjection(
  planned: RenderFeaturePlannedFrame,
): RenderFeaturePlanExecution | undefined {
  return planExecutionProjections.get(planned)?.execution;
}

export interface RenderFeatureStageEvent {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'extract' | 'plan';
}

export interface RenderFeatureFrameResult {
  /** Required source/GPU preparation has not produced every graph input yet. */
  readonly preparationPending?: boolean;
  readonly preparationPendingFeatureIdentity?: string;
  readonly preparationPendingReason?: FramePresentationPendingReason;
  readonly stageEvents: readonly RenderFeatureStageEvent[];
  readonly errors: readonly RenderError[];
  readonly plans: readonly RenderFeaturePlannedFrame[];
  /** Complete declared readback roster across this sealed source-frame batch. */
  readonly featureTextureReadbacks?: readonly FeatureTextureReadbackDeclaration[];
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  /** Public Standard post-effect identities; graph-local fullscreen resources are not included. */
  readonly postProcessIdentities: readonly string[];
  readonly preparedResourceBatches: readonly RenderFeaturePreparedResourceBatch[];
  /**
   * True only when the current graph imports a transient graphics buffer.
   * Retired GPU-work leases are kept alive until queue completion but are not
   * referenced by this candidate and therefore do not require a new graph.
   */
  readonly requiresPreparedResourceKey: boolean;
  readonly hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[];
}

export interface RenderFeaturePreparedResourceBatch {
  release(): Result<void, RenderError>;
}

export type SignatureInspection = {
  -readonly [Key in keyof RenderFeatureHostInspection['signatures'][number]]: RenderFeatureHostInspection['signatures'][number][Key];
};

/** Everything one installed Feature owns across frames; uninstall drops it whole. */
export interface FeatureSlot {
  readonly feature: RenderFeature<unknown>;
  releaseSystem: (() => void) | undefined;
  order: number;
  readonly preparedResourceBatches: Set<RenderFeaturePreparedResourceBatch>;
  /** Current extracted asset versions; frame leases remain independently scoped. */
  readonly assetVersionOwners: Map<World, Map<number, FeatureAssetVersionOwner>>;
  readonly preparedStore: PreparedGraphicsStore;
  status: RenderFeatureStatus;
  latestError: RenderFeatureErrorDescriptor | undefined;
  latestInspection?: unknown;
  /** Detached structural evidence of each work scope's last raw plan. */
  readonly planSignatures: Map<
    string,
    { readonly signature: string; readonly snapshot: RenderFeaturePlanSignatureSnapshot }
  >;
  /** Last native execution topology of each work scope. */
  readonly nativeSignatures: Map<
    string,
    { readonly execution: RenderFeaturePlanExecution; readonly signature: string }
  >;
  signatureInspection: SignatureInspection | undefined;
  readonly nativeRouting: NativeFeatureWorkRouting;
  /** Fixed event facts; replacement order never retargets an older frame. */
  readonly stageEvents: Partial<Record<RenderFeatureStageEvent['stage'], RenderFeatureStageEvent>>;
}

export type FeatureAssetVersionOwner = Readonly<{
  assetOwner: object;
  records: ReturnType<typeof runtimeAssets>;
  version: AssetVersion<Asset>;
  contentRevision?: number;
}>;

export function frameFeatureTextureReadbacks(
  results: readonly RenderFeatureFrameResult[],
): readonly FeatureTextureReadbackDeclaration[] {
  const byIdentity = new Map<string, FeatureTextureReadbackDeclaration>();
  for (const result of results) {
    for (const planned of result.plans) {
      const execution = getRenderFeaturePlanExecutionProjection(planned);
      if (execution === undefined) continue;
      for (const pass of execution.passes) {
        if (pass.enabled === false) continue;
        for (const readback of pass.textureReadbacks ?? []) {
          const target = readback.target;
          const descriptor = target.descriptor;
          if (
            target.name === undefined ||
            descriptor === undefined ||
            descriptor.size.depthOrArrayLayers !== 1
          )
            throw new RenderFeatureStageFailedError(
              execution.featureIdentity,
              execution.order,
              'plan',
              'next-frame',
              new Error('feature texture readbacks require one named 2D graph target'),
            );
          const { width, height } = descriptor.size;
          const layout = textureReadbackLayout(
            width,
            height,
            textureFormatBlock(descriptor.format),
          );
          const row: FeatureTextureReadbackDeclaration = Object.freeze({
            featureIdentity: execution.featureIdentity,
            viewIdentity: target.allocationScope ?? featureScopeKey(planned.scope),
            name: readback.name,
            targetName: target.name,
            format: descriptor.format,
            width,
            height,
            bytesPerRow: layout.bytesPerRow,
            byteLength: layout.byteLength,
          });
          const retainFeatureReadbackLayout = () => {
            const key = `${row.featureIdentity}\u0000${row.viewIdentity}\u0000${row.name}`;
            const previous = byIdentity.get(key);
            if (
              previous !== undefined &&
              (previous.targetName !== row.targetName ||
                previous.viewIdentity !== row.viewIdentity ||
                previous.format !== row.format ||
                previous.width !== row.width ||
                previous.height !== row.height ||
                previous.bytesPerRow !== row.bytesPerRow ||
                previous.byteLength !== row.byteLength)
            )
              throw new RenderFeatureStageFailedError(
                execution.featureIdentity,
                execution.order,
                'plan',
                'next-frame',
                new Error(`feature texture readback '${row.name}' has conflicting view layouts`),
              );
            byIdentity.set(key, previous ?? row);
          };
          retainFeatureReadbackLayout();
        }
      }
    }
  }
  return Object.freeze([...byIdentity.values()]);
}

export function resolveGraphicsSnapshot(
  resolver: PreparedGraphicsResolver,
  descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor,
  generation: number,
  resolveGpuResource?: (
    name: string,
  ) => import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer | undefined,
  captureGpuResources = false,
  onResolutionFailure?: (reference: PreparedGraphicsReference, error: RenderError) => void,
): Result<PreparedGraphicsResolvedSnapshot, RenderError> {
  const resources = new Map<
    object,
    import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource
  >();
  // Draw order: pipeline, bindings, vertex data, then index data.
  const resolveReference = (reference: PreparedGraphicsReference): RenderError | undefined => {
    if (resources.has(reference)) return undefined;
    const resolved = resolver.resolve(reference);
    if (!resolved.ok) {
      onResolutionFailure?.(reference, resolved.error);
      return resolved.error;
    }
    resources.set(reference, resolved.value);
    return undefined;
  };
  for (const draw of descriptor.draws) {
    let failed = resolveReference(draw.pipeline);
    for (let index = 0; failed === undefined && index < draw.bindings.length; index++)
      failed = resolveReference(draw.bindings[index] as PreparedGraphicsReference);
    for (let index = 0; failed === undefined && index < draw.vertexData.length; index++)
      failed = resolveReference(
        (draw.vertexData[index] as (typeof draw.vertexData)[number]).resource,
      );
    if (failed === undefined && draw.indexData !== undefined)
      failed = resolveReference(draw.indexData.resource);
    if (failed !== undefined) return err(failed);
  }
  // The native topology owner compares two completed private packets. Never
  // call a prior frame's live GPU session from that comparison: resolving can
  // touch/retain current transaction resources. Capture actual dependencies
  // once now and publish pure map lookups with the same packet lifetime.
  let readGpuBuffer = resolver.resolveGpuBuffer;
  let readGpuResource = resolveGpuResource;
  if (captureGpuResources) {
    const gpuBuffers = new Map<
      RenderFeatureGpuBufferRef,
      import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer
    >();
    const gpuResources = new Map<
      string,
      import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer
    >();
    const captureGraphicsGpuDependencies = () => {
      for (const draw of descriptor.draws) {
        if (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') {
          const ref = draw.command.buffer;
          if (!gpuBuffers.has(ref)) {
            const buffer = resolver.resolveGpuBuffer?.(ref);
            if (buffer !== undefined) gpuBuffers.set(ref, buffer);
          }
        }
      }
      for (const resource of resources.values()) {
        if (resource.kind !== 'bindings') continue;
        for (const binding of resource.descriptor?.values.bufferBindings ?? []) {
          const buffer = resolveGpuResource?.(binding.resource);
          if (buffer !== undefined) gpuResources.set(binding.resource, buffer);
        }
        for (const field of ['storageBuffers', 'uniformBuffers'] as const) {
          const names = resource.descriptor?.values[field];
          if (!Array.isArray(names)) continue;
          for (const name of names)
            if (typeof name === 'string' && !gpuResources.has(name)) {
              const buffer = resolveGpuResource?.(name);
              if (buffer !== undefined) gpuResources.set(name, buffer);
            }
        }
      }
    };
    captureGraphicsGpuDependencies();
    if (readGpuBuffer !== undefined) readGpuBuffer = (reference) => gpuBuffers.get(reference);
    if (readGpuResource !== undefined) readGpuResource = (name) => gpuResources.get(name);
  }

  return ok({
    generation,
    leases: resolver.leases,
    resolve: (reference) => resources.get(reference),
    ...(readGpuBuffer === undefined ? {} : { resolveGpuBuffer: readGpuBuffer }),
    ...(readGpuResource === undefined ? {} : { resolveGpuResource: readGpuResource }),
  });
}

export function graphicsValidator(
  identity: string,
  transaction: PreparedGraphicsTransaction,
  capabilityAvailable: boolean,
): (
  descriptor: RenderFeatureGraphicsPassDescriptor,
  resources: readonly { readonly name: string }[],
) => Result<RenderFeaturePreparedGraphicsState, RenderError> {
  return (descriptor, resources) => {
    const attachments = [
      ...descriptor.attachments.colors
        .filter(
          (attachment) =>
            typeof attachment.resource !== 'string' ||
            attachment.resource === 'swapchain' ||
            resources.some((resource) => resource.name === `${identity}::${attachment.resource}`),
        )
        .map((attachment) => ({ resource: attachment.resource, format: attachment.format })),
      ...(descriptor.attachments.depthStencil === undefined
        ? []
        : resources.some(
              (resource) =>
                resource.name === `${identity}::${descriptor.attachments.depthStencil?.resource}`,
            ) || typeof descriptor.attachments.depthStencil.resource !== 'string'
          ? [
              {
                resource: descriptor.attachments.depthStencil.resource,
                format: descriptor.attachments.depthStencil.format,
              },
            ]
          : []),
    ];
    return transaction.validateGraphicsPass(descriptor, capabilityAvailable, attachments);
  };
}

export function planFailure(slot: FeatureSlot): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(slot.feature.identity, slot.order, 'plan', 'next-frame');
}

function resolvePreparedDrawInputs(
  slot: FeatureSlot,
  draw: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' }>['draws'][number],
  prepared: PreparedPlanResources,
) {
  const pipeline = prepared.graphicsPrograms.get(draw.program);
  const bindings = draw.bindings.map((name) => prepared.graphicsBindings.get(name));
  const vertexData = draw.vertexData.map((entry) => ({
    slot: entry.slot,
    resource: prepared.vertexData.get(entry.resource),
  }));
  const indexData =
    draw.indexData === undefined
      ? undefined
      : {
          resource: prepared.indexData.get(draw.indexData.resource),
          format: draw.indexData.format,
        };
  if (
    pipeline === undefined ||
    bindings.some((binding) => binding === undefined) ||
    vertexData.some((vertex) => vertex.resource === undefined) ||
    (indexData !== undefined && indexData.resource === undefined)
  ) {
    return err(planFailure(slot));
  }
  return ok({ pipeline, bindings, vertexData, indexData });
}

export function projectDraw(
  slot: FeatureSlot,
  draw: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' }>['draws'][number],
  prepared: PreparedPlanResources,
): Result<import('./prepared-graphics').RenderFeatureDrawRecord, RenderError> {
  const inputs = resolvePreparedDrawInputs(slot, draw, prepared);
  if (!inputs.ok) return inputs;
  const { pipeline, bindings, vertexData, indexData } = inputs.value;
  const common = {
    enabled: draw.enabled,
    pipeline,
    bindings: bindings as readonly RenderFeaturePreparedRef<'bindings'>[],
    vertexData: vertexData as readonly {
      readonly slot: number;
      readonly resource: RenderFeaturePreparedRef<'vertex-data'>;
    }[],
    ...(draw.vertexLayout === undefined ? {} : { vertexLayout: draw.vertexLayout }),
  };
  switch (draw.draw.kind) {
    case 'draw':
      return ok({
        kind: 'draw',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command: {
          vertexCount: draw.draw.vertexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstVertex === undefined ? {} : { firstVertex: draw.draw.firstVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indexed':
      return ok({
        kind: 'draw-indexed',
        ...common,
        indexData:
          indexData === undefined
            ? undefined
            : {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
        command: {
          indexCount: draw.draw.indexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstIndex === undefined ? {} : { firstIndex: draw.draw.firstIndex }),
          ...(draw.draw.baseVertex === undefined ? {} : { baseVertex: draw.draw.baseVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indirect':
    case 'draw-indexed-indirect': {
      const buffer = prepared.buffers.get(draw.draw.resource);
      if (buffer === undefined) return err(planFailure(slot));
      const command = {
        buffer,
        ...(draw.draw.offset === undefined ? {} : { offset: draw.draw.offset }),
      };
      if (draw.draw.kind === 'draw-indexed-indirect') {
        return ok({
          kind: 'draw-indexed-indirect',
          ...common,
          indexData:
            indexData === undefined
              ? undefined
              : {
                  resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                  format: indexData.format,
                },
          command,
        });
      }
      return ok({
        kind: 'draw-indirect',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command,
      });
    }
  }
}
