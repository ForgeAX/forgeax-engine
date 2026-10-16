import type {
  BindGroup,
  BindGroupLayout,
  Blas,
  Buffer,
  CommandBuffer,
  ComputePipeline,
  PipelineLayout,
  QuerySet,
  RenderPipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';

export type ReplayResource = {
  readonly role?: string;
} & (
  | { readonly kind: 'buffer'; readonly value: Buffer }
  | { readonly kind: 'texture'; readonly value: Texture }
  | { readonly kind: 'query-set'; readonly value: QuerySet }
  | { readonly kind: 'acceleration-structure'; readonly role: 'blas'; readonly value: Blas }
  | { readonly kind: 'acceleration-structure'; readonly role: 'tlas'; readonly value: Tlas }
  | { readonly kind: 'texture-view'; readonly value: TextureView }
  | { readonly kind: 'sampler'; readonly value: Sampler }
  | { readonly kind: 'shader-module'; readonly value: ShaderModule }
  | {
      readonly kind: 'pipeline';
      readonly role: 'render' | 'compute';
      readonly value: RenderPipeline | ComputePipeline;
    }
  | {
      readonly kind: 'binding';
      readonly role: 'bind-group' | 'bind-group-layout' | 'pipeline-layout';
      readonly value: BindGroup | BindGroupLayout | PipelineLayout;
    }
  | {
      readonly kind: 'encoder';
      readonly role: 'command' | 'command-buffer' | 'render-pass' | 'compute-pass';
      readonly value:
        | RhiCommandEncoder
        | RhiRenderPassEncoder
        | RhiComputePassEncoder
        | CommandBuffer;
    }
);

/** Destroys the GPU object a resource owns; `undefined` for kinds the device never destroys. */
export function destroyReplayResource(
  device: RhiDevice,
  resource: ReplayResource,
): Result<void, RhiError> | undefined {
  switch (resource.kind) {
    case 'buffer':
      return device.destroyBuffer(resource.value);
    case 'texture':
      return device.destroyTexture(resource.value);
    case 'query-set':
      return device.destroyQuerySet(resource.value);
    case 'acceleration-structure':
      return resource.role === 'blas'
        ? device.destroyBlas(resource.value)
        : device.destroyTlas(resource.value);
    case 'texture-view':
    case 'sampler':
    case 'shader-module':
    case 'pipeline':
    case 'binding':
    case 'encoder':
      return undefined;
  }
}

export interface ResourceTableEntry {
  readonly resourceId: string;
  readonly generation: number;
  readonly resource: ReplayResource;
  readonly descriptor: Record<string, unknown> | undefined;
}

export class ResourceTable {
  private readonly entries = new Map<string, ResourceTableEntry>();
  private disposed = false;
  private currentGeneration: number;

  constructor(
    private readonly device: RhiDevice,
    generation = 0,
  ) {
    this.currentGeneration = generation;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get(resourceId: string): ResourceTableEntry | undefined {
    return this.entries.get(resourceId);
  }

  set(
    resourceId: string,
    resource: ReplayResource,
    descriptor?: Record<string, unknown> | undefined,
  ): Result<void, RhiDebugError> {
    if (this.disposed) {
      return err(
        createRhiDebugError('replay-position-invalid', {
          requested: this.generation,
          available: -1,
        }),
      );
    }
    this.entries.set(resourceId, {
      resourceId,
      generation: this.generation,
      resource,
      descriptor,
    });
    return ok(undefined);
  }

  delete(resourceId: string): void {
    this.entries.delete(resourceId);
  }

  values(): IterableIterator<ResourceTableEntry> {
    return this.entries.values();
  }

  /** Start a new generation; `retained` entries are immutable and keep their GPU objects. */
  reset(retained: ReadonlySet<string> = new Set()): Result<void, RhiDebugError> {
    const result = this.release((entry) => !retained.has(entry.resourceId));
    if (!result.ok) return result;
    for (const resourceId of [...this.entries.keys()]) {
      if (!retained.has(resourceId)) this.entries.delete(resourceId);
    }
    this.currentGeneration += 1;
    return ok(undefined);
  }

  dispose(): Result<void, RhiDebugError> {
    if (this.disposed) return ok(undefined);
    const result = this.release(() => true);
    this.entries.clear();
    this.disposed = true;
    return result;
  }

  private release(selected: (entry: ResourceTableEntry) => boolean): Result<void, RhiDebugError> {
    let firstFailure: Result<never, RhiDebugError> | undefined;
    for (const entry of this.entries.values()) {
      if (!selected(entry)) continue;
      const result = destroyReplayResource(this.device, entry.resource);
      if (result !== undefined && !result.ok && firstFailure === undefined)
        firstFailure = resourceDisposeFailure(entry.resourceId, result.error.code);
    }
    return firstFailure ?? ok(undefined);
  }
}

function resourceDisposeFailure(resourceId: string, cause: string): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-event-failed', {
      eventIndex: -1,
      kind: `dispose:${resourceId}`,
      stage: 'create',
      cause,
    }),
  );
}
