import type { BindGroup, Buffer, RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import type {
  PreparedGraphicsResourceLease,
  RenderFeatureResolvedGpuBuffer,
} from '../features/prepared-gpu-work';
import type {
  RenderFeatureBindingsDescriptor,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import type {
  PreparedGraphicsItem,
  PreparedGraphicsKind,
  PreparedGraphicsNormalizedDescriptor,
} from '../features/prepared-graphics-store';
import { materialDepthStencil } from '../material-render-state';
import { type TranslucentFogComposition, translucentFogComposition } from '../record/view-ubo';

type PreparedBufferKind = Exclude<PreparedGraphicsKind, 'pipeline' | 'bindings'>;

type PreparedGraphicsMismatch =
  | {
      readonly reason: 'missing-prepared-state';
      readonly missingResource: string;
    }
  | {
      readonly reason: 'generation-mismatch';
      readonly expectedGeneration: number;
      readonly actualGeneration: number;
    };

export type PreparedGraphicsReference =
  | RenderFeaturePreparedRef<'pipeline'>
  | RenderFeaturePreparedRef<'bindings'>
  | RenderFeaturePreparedRef<'vertex-data'>
  | RenderFeaturePreparedRef<'index-data'>;

export type PreparedGraphicsResolvedResource =
  | {
      readonly kind: 'pipeline';
      readonly reference: RenderFeaturePreparedRef;
      readonly handle: RenderPipeline;
      /** Renderer-selected context; never authored by a RenderFeature. */
      readonly standardLighting?: boolean;
      /** Derived from the same material state used to construct the pipeline. */
      readonly writesDepth?: boolean;
      /** Derived from the pipeline blend; selects the translucent View copy. */
      readonly fogComposition?: TranslucentFogComposition;
    }
  | {
      readonly kind: 'bindings';
      readonly reference: RenderFeaturePreparedRef;
      readonly handle: BindGroup | undefined;
      readonly pipeline?: RenderPipeline;
      readonly descriptor?: RenderFeatureBindingsDescriptor;
      readonly dynamicOffsets?: readonly number[];
      /** The bound pipeline's translucent fog composition, when it blends. */
      readonly fogComposition?: TranslucentFogComposition;
    }
  | {
      readonly kind: PreparedBufferKind;
      readonly reference: RenderFeaturePreparedRef;
      readonly handle: Buffer;
      readonly size: number;
      readonly physicalUsage: number;
      readonly byteOffset?: number;
      readonly byteLength?: number;
    };

export interface PreparedGraphicsResolverInput {
  readonly device: RhiDevice;
  /** Owning feature identity survives lookup failures for feature-local diagnostics. */
  readonly featureIdentity?: string;
  readonly generation: number;
  readonly capabilityAvailable: boolean;
  readonly lookup: (reference: RenderFeaturePreparedRef) => PreparedGraphicsItem | undefined;
  readonly resolvePipeline: (
    descriptor: PreparedGraphicsNormalizedDescriptor & { readonly kind: 'pipeline' },
  ) => Result<
    RenderPipeline | { readonly handle: RenderPipeline; readonly standardLighting: boolean },
    unknown
  >;
  readonly resolveBindings: (
    descriptor: RenderFeatureBindingsDescriptor,
    pipeline: RenderPipeline,
  ) => Result<
    | undefined
    | BindGroup
    | {
        readonly handle: BindGroup;
        readonly dynamicOffsets?: readonly number[];
        readonly release: () => Result<void, unknown>;
      },
    unknown
  >;
  readonly resolveGpuBuffer?: (
    reference: import('../features/prepared-gpu-work').RenderFeatureGpuBufferRef,
  ) => RenderFeatureResolvedGpuBuffer | undefined;
  readonly featureOrder?: number;
}

export interface PreparedGraphicsResolver {
  resolve(
    reference: PreparedGraphicsReference,
  ): Result<PreparedGraphicsResolvedResource, RenderError>;
  readonly leases: readonly PreparedGraphicsResourceLease[];
  /** True when a leased physical buffer is imported by the compiled graph. */
  readonly requiresGraphRebuild: boolean;
  readonly resolveGpuBuffer?: PreparedGraphicsResolverInput['resolveGpuBuffer'];
  release(): Result<void, RenderError>;
}

export type { PreparedGraphicsResourceLease } from '../features/prepared-gpu-work';

export interface PreparedGraphicsResolvedSnapshot {
  readonly generation: number;
  readonly leases?: readonly PreparedGraphicsResourceLease[];
  readonly resolve: (
    reference: RenderFeaturePreparedRef,
  ) => PreparedGraphicsResolvedResource | undefined;
  readonly resolveGpuBuffer?: (
    reference: import('../features/prepared-gpu-work').RenderFeatureGpuBufferRef,
  ) => RenderFeatureResolvedGpuBuffer | undefined;
  /** Resolve a feature-owned prepared buffer by its declarative resource name. */
  readonly resolveGpuResource?: (name: string) => RenderFeatureResolvedGpuBuffer | undefined;
}

function preparationFailure(
  item: PreparedGraphicsItem | undefined,
  input: PreparedGraphicsResolverInput,
  kind: RenderFeaturePreparedRef['kind'],
  name: string,
  reason: string,
): RenderError {
  return new RenderFeaturePreparationFailedError(
    item?.featureIdentity ?? input.featureIdentity ?? 'unknown',
    input.featureOrder ?? -1,
    'resolve',
    kind,
    name,
    reason,
    'next-frame',
  );
}

function pipelineResolutionReason(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'rhi-not-available'
    ? 'pipeline-pending'
    : 'pipeline resolution failed';
}

function stateMismatch(
  input: PreparedGraphicsResolverInput,
  reference: RenderFeaturePreparedRef,
  detail: PreparedGraphicsMismatch,
): RenderError {
  if (detail.reason === 'missing-prepared-state') {
    return new RenderFeaturePreparedStateMismatchError({
      featureIdentity: input.featureIdentity ?? 'unknown',
      order: input.featureOrder ?? -1,
      stage: 'contribute',
      operation: 'resolve',
      resourceKind: reference.kind,
      reason: detail.reason,
      missingResource: detail.missingResource,
      recovery: 'next-frame',
    });
  }
  return new RenderFeaturePreparedStateMismatchError({
    featureIdentity: input.featureIdentity ?? 'unknown',
    order: input.featureOrder ?? -1,
    stage: 'contribute',
    operation: 'resolve',
    resourceKind: reference.kind,
    reason: detail.reason,
    expectedGeneration: detail.expectedGeneration,
    actualGeneration: detail.actualGeneration,
    recovery: 'next-frame',
  });
}

function bufferUsage(kind: PreparedBufferKind): number {
  const copyDst = 8;
  return kind === 'vertex-data' ? 32 | copyDst : 16 | copyDst;
}

function uploadBuffer(
  input: PreparedGraphicsResolverInput,
  item: PreparedGraphicsItem,
  kind: PreparedBufferKind,
): Result<Buffer, RenderError> {
  const bytes = item.uploadBytes;
  if (bytes === undefined || bytes.length === 0) {
    return err(preparationFailure(item, input, kind, item.name, 'upload bytes are missing'));
  }
  const size = Math.max(4, (bytes.length + 3) & ~3);
  const created = input.device.createBuffer({
    label: `${item.featureIdentity}::${item.name}`,
    size,
    usage: bufferUsage(kind),
  });
  if (!created.ok) {
    return err(preparationFailure(item, input, kind, item.name, 'device buffer creation failed'));
  }
  const payload = new Uint8Array(size);
  payload.set(bytes);
  const uploaded = input.device.queue.writeBuffer(created.value, 0, payload);
  if (!uploaded.ok) {
    input.device.destroyBuffer(created.value);
    return err(preparationFailure(item, input, kind, item.name, 'device buffer upload failed'));
  }
  return ok(created.value);
}

function descriptorFor(
  item: PreparedGraphicsItem,
  kind: 'pipeline',
): Extract<PreparedGraphicsNormalizedDescriptor, { readonly kind: 'pipeline' }> | undefined;
function descriptorFor(
  item: PreparedGraphicsItem,
  kind: 'bindings',
): Extract<PreparedGraphicsNormalizedDescriptor, { readonly kind: 'bindings' }> | undefined;
function descriptorFor(
  item: PreparedGraphicsItem,
  kind: PreparedBufferKind,
): Extract<PreparedGraphicsNormalizedDescriptor, { readonly kind: PreparedBufferKind }> | undefined;
function descriptorFor(
  item: PreparedGraphicsItem,
  kind: PreparedGraphicsNormalizedDescriptor['kind'],
): PreparedGraphicsNormalizedDescriptor | undefined {
  return item.descriptor?.kind === kind ? item.descriptor : undefined;
}

export function createPreparedGraphicsResolver(
  input: PreparedGraphicsResolverInput,
): PreparedGraphicsResolver {
  const resolved = new WeakMap<object, PreparedGraphicsResolvedResource>();
  const leases: PreparedGraphicsResourceLease[] = [];
  let requiresGraphRebuild = false;

  const resolve = (
    reference: PreparedGraphicsReference,
  ): Result<PreparedGraphicsResolvedResource, RenderError> => {
    if (!input.capabilityAvailable) {
      return err(
        preparationFailure(
          undefined,
          input,
          reference.kind,
          reference.kind,
          'required capability is unavailable',
        ),
      );
    }
    const item = input.lookup(reference);
    if (item === undefined || item.reference !== reference) {
      return err(
        stateMismatch(input, reference, {
          reason: 'missing-prepared-state',
          missingResource: reference.kind,
        }),
      );
    }
    if (item.generation !== input.generation || reference.generation !== input.generation) {
      return err(
        stateMismatch(input, reference, {
          reason: 'generation-mismatch',
          expectedGeneration: input.generation,
          actualGeneration: reference.generation,
        }),
      );
    }
    const cached = resolved.get(reference);
    if (cached !== undefined) return ok(cached);

    switch (reference.kind) {
      case 'pipeline':
        return resolvePipeline(item, reference);
      case 'bindings':
        return resolveBindings(item, reference);
      case 'vertex-data':
      case 'index-data':
        return resolveBuffer(item, reference);
    }
  };

  const resolvePipeline = (
    item: PreparedGraphicsItem,
    reference: RenderFeaturePreparedRef<'pipeline'>,
  ): Result<PreparedGraphicsResolvedResource, RenderError> => {
    const descriptor = descriptorFor(item, 'pipeline');
    if (descriptor === undefined) {
      return err(
        preparationFailure(
          item,
          input,
          reference.kind,
          item.name,
          'pipeline descriptor is missing',
        ),
      );
    }
    const created = input.resolvePipeline(descriptor);
    if (!created.ok || created.value === undefined) {
      return err(
        preparationFailure(
          item,
          input,
          reference.kind,
          item.name,
          created.ok ? 'pipeline resolution failed' : pipelineResolutionReason(created.error),
        ),
      );
    }
    const fogComposition = translucentFogComposition(descriptor.renderState?.blend);
    const resource: PreparedGraphicsResolvedResource = {
      kind: 'pipeline',
      reference,
      writesDepth:
        descriptor.depthFormat !== undefined &&
        materialDepthStencil(descriptor.depthFormat, descriptor.renderState).depthWriteEnabled ===
          true,
      ...('handle' in created.value
        ? { handle: created.value.handle, standardLighting: created.value.standardLighting }
        : { handle: created.value }),
      ...(fogComposition === undefined ? {} : { fogComposition }),
    };
    resolved.set(reference, resource);
    return ok(resource);
  };

  const resolveBindings = (
    item: PreparedGraphicsItem,
    reference: RenderFeaturePreparedRef<'bindings'>,
  ): Result<PreparedGraphicsResolvedResource, RenderError> => {
    const descriptor = descriptorFor(item, 'bindings');
    if (descriptor === undefined) {
      return err(
        preparationFailure(
          item,
          input,
          reference.kind,
          item.name,
          'bindings descriptor is missing',
        ),
      );
    }
    const pipeline = resolve(descriptor.pipeline);
    if (!pipeline.ok || pipeline.value.kind !== 'pipeline') return pipeline;
    const created = input.resolveBindings(descriptor, pipeline.value.handle);
    if (!created.ok) {
      return err(
        preparationFailure(
          item,
          input,
          reference.kind,
          item.name,
          `bindings resolution failed: ${created.error instanceof Error ? created.error.message : String(created.error)}`,
        ),
      );
    }
    const binding =
      created.value !== undefined &&
      typeof created.value === 'object' &&
      created.value !== null &&
      'handle' in created.value &&
      'release' in created.value
        ? created.value
        : undefined;
    const resource: PreparedGraphicsResolvedResource = {
      kind: 'bindings',
      reference,
      handle: binding?.handle ?? (created.value as BindGroup | undefined),
      pipeline: pipeline.value.handle,
      descriptor,
      ...(binding?.dynamicOffsets === undefined ? {} : { dynamicOffsets: binding.dynamicOffsets }),
      ...(pipeline.value.fogComposition === undefined
        ? {}
        : { fogComposition: pipeline.value.fogComposition }),
    };
    if (binding !== undefined) {
      let released = false;
      leases.push({
        release: () => {
          if (released) return ok(undefined);
          released = true;
          const result = binding.release();
          return result.ok
            ? ok(undefined)
            : err(
                new RenderFeatureStageFailedError(
                  item.featureIdentity,
                  input.featureOrder ?? -1,
                  'dispose',
                  'renderer-recover',
                ),
              );
        },
      });
    }
    resolved.set(reference, resource);
    return ok(resource);
  };

  const resolveBuffer = (
    item: PreparedGraphicsItem,
    reference: RenderFeaturePreparedRef<PreparedBufferKind>,
  ): Result<PreparedGraphicsResolvedResource, RenderError> => {
    const descriptor = descriptorFor(item, reference.kind);
    if (descriptor === undefined) {
      return err(
        preparationFailure(
          item,
          input,
          reference.kind,
          item.name,
          `${reference.kind} descriptor is missing`,
        ),
      );
    }
    if ('buffer' in descriptor && descriptor.buffer !== undefined) {
      const handle = input.resolveGpuBuffer?.(descriptor.buffer);
      if (handle === undefined) {
        return err(
          preparationFailure(item, input, reference.kind, item.name, 'GPU buffer is unavailable'),
        );
      }
      const offset = descriptor.offset ?? 0;
      const size = descriptor.size ?? handle.size - offset;
      const alignment = descriptor.kind === 'index-data' && descriptor.format === 'uint16' ? 2 : 4;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % alignment !== 0 ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size % alignment !== 0 ||
        size > handle.size - offset
      ) {
        return err(
          preparationFailure(item, input, reference.kind, item.name, 'GPU buffer range is invalid'),
        );
      }
      const resource: PreparedGraphicsResolvedResource = {
        kind: reference.kind,
        reference,
        handle: handle.buffer,
        // Graph imports retain the complete underlying allocation. Binding
        // ranges never hide aliases from dependency and lifetime analysis.
        size: handle.size,
        physicalUsage: handle.physicalUsage,
        ...(descriptor.offset === undefined && descriptor.size === undefined
          ? {}
          : {
              byteOffset: offset,
              byteLength: size,
            }),
      };
      resolved.set(reference, resource);
      return ok(resource);
    }
    const buffer = uploadBuffer(input, item, reference.kind);
    if (!buffer.ok) return buffer;
    requiresGraphRebuild = true;
    const resource: PreparedGraphicsResolvedResource = {
      kind: reference.kind,
      reference,
      handle: buffer.value,
      size: Math.max(4, ((item.uploadBytes?.length ?? 0) + 3) & ~3),
      physicalUsage: bufferUsage(reference.kind),
    };
    leases.push({
      release: (() => {
        let released = false;
        return () => {
          if (released) return ok(undefined);
          released = true;
          const destroyed = input.device.destroyBuffer(buffer.value);
          return destroyed.ok
            ? ok(undefined)
            : err(
                new RenderFeatureStageFailedError(
                  item.featureIdentity,
                  input.featureOrder ?? -1,
                  'dispose',
                  'renderer-recover',
                ),
              );
        };
      })(),
    });
    resolved.set(reference, resource);
    return ok(resource);
  };

  return {
    resolve,
    leases,
    get requiresGraphRebuild() {
      return requiresGraphRebuild;
    },
    ...(input.resolveGpuBuffer === undefined ? {} : { resolveGpuBuffer: input.resolveGpuBuffer }),
    release: () => {
      let firstError: RenderError | undefined;
      for (const lease of leases) {
        const released = lease.release();
        if (!released.ok && firstError === undefined) firstError = released.error;
      }
      return firstError === undefined ? ok(undefined) : err(firstError);
    },
  };
}
