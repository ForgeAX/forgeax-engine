import type {
  Buffer,
  ComputePassDescriptor,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPassDescriptor,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Texture,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { mipDimension } from '@forgeax/engine-types';
import { subtractTextureRange, textureRangeCovered } from './content-ranges.js';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import type {
  CompiledPass,
  CompiledResource,
  CompiledView,
  GraphTextureAllocation,
  ResourceHandleData,
  TextureViewRecord,
} from './kernel-internal.js';
import { handleData, physicalAllocationKey, releaseGraphTexture } from './kernel-internal.js';
import type { RasterBatch } from './raster-batching.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  GraphAccelerationStructure,
  GraphAccessUsage,
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureContentRange,
  GraphTextureDescriptor,
  GraphTextureView,
  RasterColorAttachment,
  RasterDepthStencilAttachment,
  RenderGraphFrame,
  RenderGraphPassExecution,
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
  RenderGraphPassRunner,
  RenderGraphResourceAllocationInspection,
} from './types.js';

function rasterBatchBoundary<FrameCtx extends RenderGraphFrame>(
  passes: readonly CompiledPass<FrameCtx>[],
  passIndex: number,
  batchLast: number,
  runPass: RenderGraphPassRunner | undefined,
): number {
  let last = batchLast;
  if (runPass?.requiresPassBoundary !== undefined) {
    for (let i = passIndex; i <= batchLast; i++) {
      if (!runPass.requiresPassBoundary(passes[i]?.name ?? '')) continue;
      last = i === passIndex ? i : i - 1;
      break;
    }
  }
  return last;
}

function passExecutionRecord<FrameCtx extends RenderGraphFrame>(
  pass: CompiledPass<FrameCtx>,
  executionIndex: number,
  resolver: GraphResourceResolver,
  observed: boolean,
): RenderGraphPassExecution | undefined {
  return !observed
    ? undefined
    : {
        name: pass.name,
        kind: pass.pass.kind,
        executionIndex,
        ...(pass.pass.kind === 'raster' && pass.pass.descriptor.depthStencilAttachment !== undefined
          ? {
              resolvedDepthStencilAttachmentView: resolver
                .textureView(pass.pass.descriptor.depthStencilAttachment.view)
                .unwrap(),
            }
          : {}),
      };
}

const compiledGraphs = new WeakSet<object>();
const executingGraphs = new WeakSet<object>();
type StagedTextureWrite = { readonly range: GraphTextureContentRange; readonly stored: boolean };

type Writable<T> = { -readonly [K in keyof T]: T[K] };

// Results are immutable values: a resolver hit returns the one success Result
// of that handle, so per-pass resource reads allocate nothing.
const okResults = new WeakMap<object, Result<unknown, never>>();
function okOf<T extends object>(value: T): Result<T, never> {
  let result = okResults.get(value) as Result<T, never> | undefined;
  if (result === undefined) {
    result = ok(value);
    okResults.set(value, result);
  }
  return result;
}

/** Resolve one pass's color attachments into its retained native descriptor. */
function resolveRasterColors<FrameCtx>(
  attachments: readonly RasterColorAttachment<FrameCtx>[],
  frame: FrameCtx,
  resolver: GraphResourceResolver,
  retained: RenderPassDescriptor['colorAttachments'] | undefined,
): Result<Writable<RenderPassColorAttachment>[], RenderGraphError> {
  const colorAttachments = (retained ?? []) as Writable<RenderPassColorAttachment>[];
  let colorIndex = 0;
  for (const attachment of attachments) {
    const view = resolver.textureView(attachment.view);
    if (!view.ok) {
      return view;
    }
    const resolveTarget =
      attachment.resolveTarget === undefined
        ? undefined
        : resolver.textureView(attachment.resolveTarget);
    if (resolveTarget !== undefined && !resolveTarget.ok) {
      return resolveTarget;
    }
    const clearValue =
      typeof attachment.clearValue === 'function'
        ? attachment.clearValue(frame)
        : attachment.clearValue;
    const loadOp =
      typeof attachment.loadOp === 'function' ? attachment.loadOp(frame) : attachment.loadOp;
    const storeOp = attachment.storeOp === 'discard' ? 'discard' : 'store';
    // Optional members are assigned, not spread: spreads allocate a
    // temporary object per member on every executed pass.
    const color: Writable<RenderPassColorAttachment> = colorAttachments[colorIndex] ?? {
      view: view.value,
      loadOp,
      storeOp,
    };
    color.view = view.value;
    color.loadOp = loadOp;
    color.storeOp = storeOp;
    if (resolveTarget !== undefined) color.resolveTarget = resolveTarget.value;
    else delete color.resolveTarget;
    if (clearValue === undefined) delete color.clearValue;
    else color.clearValue = clearValue;
    if (attachment.depthSlice !== undefined) color.depthSlice = attachment.depthSlice;
    colorAttachments[colorIndex++] = color;
  }
  colorAttachments.length = colorIndex;
  return okOf(colorAttachments);
}

/** Resolve the current depth view and attachment aspects without copying native storage. */
function resolveRasterDepth(
  attachment: RasterDepthStencilAttachment | undefined,
  resolver: GraphResourceResolver,
  retained: RenderPassDepthStencilAttachment | undefined,
): Result<RenderPassDepthStencilAttachment | undefined, RenderGraphError> {
  if (attachment === undefined) return ok(undefined);
  const view = resolver.textureView(attachment.view);
  if (!view.ok) return view;
  const depth: Writable<RenderPassDepthStencilAttachment> = retained ?? { view: view.value };
  depth.view = view.value;
  if (attachment.depthClearValue !== undefined) depth.depthClearValue = attachment.depthClearValue;
  if (attachment.depthLoadOp !== undefined) depth.depthLoadOp = attachment.depthLoadOp;
  if (attachment.depthStoreOp !== undefined) depth.depthStoreOp = attachment.depthStoreOp;
  else delete depth.depthStoreOp;
  if (attachment.depthReadOnly !== undefined) depth.depthReadOnly = attachment.depthReadOnly;
  if (attachment.stencilClearValue !== undefined)
    depth.stencilClearValue = attachment.stencilClearValue;
  if (attachment.stencilLoadOp !== undefined) depth.stencilLoadOp = attachment.stencilLoadOp;
  if (attachment.stencilStoreOp !== undefined) depth.stencilStoreOp = attachment.stencilStoreOp;
  else delete depth.stencilStoreOp;
  if (attachment.stencilReadOnly !== undefined) depth.stencilReadOnly = attachment.stencilReadOnly;
  return okOf(depth);
}

/** Acceleration structures derive no RHI usage bits; a declared access keeps them live. */
function isResolved<FrameCtx>(compiled: CompiledResource<FrameCtx>): boolean {
  return compiled.record.kind === 'acceleration-structure'
    ? compiled.firstUse !== null
    : compiled.usage !== 0;
}

interface FrameResources {
  readonly buffers: ReadonlyMap<number, Buffer>;
  readonly textures: ReadonlyMap<number, Texture>;
  readonly views: ReadonlyMap<number, TextureView>;
  readonly accelerationStructures: ReadonlyMap<number, Tlas>;
}

interface AllocationEntry {
  readonly handle: unknown;
  readonly bytes: number | undefined;
  readonly newlyAllocated: boolean;
}

/**
 * Compiled-graph owner ledger. It counts only graph-created physical handles;
 * imported handles are references owned by the caller and remain byte-unknown.
 */
class RenderGraphAllocationLedger {
  private readonly allocations = new Map<
    unknown,
    { bytes: number | undefined; state: 'live' | 'pending-retirement' }
  >();
  private inspection: RenderGraphResourceAllocationInspection | undefined;
  private liveBytes = 0;
  private pendingBytes = 0;
  private peakBytes = 0;
  private successfulAllocationCount = 0;
  private successfulAllocationBytes = 0;
  private retiredBytes = 0;
  private unknownByteSizeCount = 0;
  private readonly importedResourceCount: number;

  constructor(entries: readonly AllocationEntry[], importedResourceCount: number) {
    this.importedResourceCount = importedResourceCount;
    for (const entry of entries) this.allocate(entry.handle, entry.bytes, entry.newlyAllocated);
  }

  inspect(): RenderGraphResourceAllocationInspection {
    if (this.inspection !== undefined) return this.inspection;
    this.inspection = Object.freeze({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: this.liveBytes,
      pendingRetirementBytes: this.pendingBytes,
      peakBytes: this.peakBytes,
      successfulAllocationCount: this.successfulAllocationCount,
      successfulAllocationBytes: this.successfulAllocationBytes,
      pendingRetirementCount: [...this.allocations.values()].filter(
        (entry) => entry.state === 'pending-retirement',
      ).length,
      retiredBytes: this.retiredBytes,
      failedAllocationRollbacks: 0,
      failedAllocationRollbackBytes: 0,
      unknownByteSizeCount: this.unknownByteSizeCount,
      importedResourceCount: this.importedResourceCount,
    });
    return this.inspection;
  }

  state(handle: unknown): 'live' | 'pending-retirement' | 'released' {
    return this.allocations.get(handle)?.state ?? 'released';
  }

  retireAll(): void {
    for (const entry of this.allocations.values()) {
      if (entry.state !== 'live') continue;
      this.inspection = undefined;
      entry.state = 'pending-retirement';
      if (entry.bytes !== undefined) {
        this.liveBytes -= entry.bytes;
        this.pendingBytes += entry.bytes;
      }
    }
  }

  release(handle: unknown): void {
    const entry = this.allocations.get(handle);
    if (entry === undefined) return;
    this.inspection = undefined;
    this.allocations.delete(handle);
    if (entry.bytes === undefined) this.unknownByteSizeCount -= 1;
    else {
      if (entry.state === 'live') this.liveBytes -= entry.bytes;
      else this.pendingBytes -= entry.bytes;
      this.retiredBytes += entry.bytes;
    }
  }

  private allocate(handle: unknown, bytes: number | undefined, newlyAllocated: boolean): void {
    if (this.allocations.has(handle)) return;
    this.inspection = undefined;
    this.allocations.set(handle, { bytes, state: 'live' });
    if (newlyAllocated) this.successfulAllocationCount += 1;
    if (bytes === undefined) this.unknownByteSizeCount += 1;
    else {
      this.liveBytes += bytes;
      if (newlyAllocated) this.successfulAllocationBytes += bytes;
    }
    this.updatePeak();
  }

  private updatePeak(): void {
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes + this.pendingBytes);
  }
}

function resolutionError(label: string, cause?: unknown): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: `resource '${label}' resolves to a live RHI handle for this frame`,
    hint: `repair the imported owner for '${label}' before executing the graph`,
    detail: { resourceLabel: label, ...(cause === undefined ? {} : { accesses: [String(cause)] }) },
  });
}

function coversUsage(port: GraphAccessUsage, child: GraphAccessUsage): boolean {
  return (
    port === child ||
    (port === 'storage-read-write' && (child === 'storage-read' || child === 'storage-write')) ||
    (port === 'depth-stencil-write' && child === 'depth-stencil-read') ||
    (port === 'sampled-storage-read-write' &&
      [
        'sampled-read',
        'storage-read',
        'storage-write',
        'storage-read-write',
        'sampled-storage-write',
      ].includes(child))
  );
}

function safePassScope<FrameCtx extends RenderGraphFrame>(
  instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
  execution: RenderGraphPassExecution | undefined,
  frame: FrameCtx,
): RenderGraphPassInstrumentationScope | undefined {
  if (instrumentation === undefined || execution === undefined) return undefined;
  try {
    return instrumentation.begin(execution, frame);
  } catch {
    // Instrumentation is diagnostic and cannot change graph execution.
    return undefined;
  }
}

function safeEndPass(scope: RenderGraphPassInstrumentationScope | undefined): void {
  try {
    scope?.endPass?.();
  } catch {
    // Instrumentation is diagnostic and cannot replace a graph pass result.
  }
}

function decorateDescriptor<T>(
  scope: RenderGraphPassInstrumentationScope | undefined,
  decorate: ((descriptor: T) => T) | undefined,
  descriptor: T,
): T {
  try {
    return decorate?.call(scope, descriptor) ?? descriptor;
  } catch {
    // Instrumentation is diagnostic and cannot alter the pass descriptor.
    return descriptor;
  }
}

function bufferSize<FrameCtx>(
  resource: CompiledResource<FrameCtx> | undefined,
): number | undefined {
  return resource?.record.kind === 'buffer' ? resource.record.descriptor.size : undefined;
}

function sameTexture<FrameCtx>(
  left: CompiledResource<FrameCtx> | undefined,
  right: CompiledResource<FrameCtx> | undefined,
): boolean {
  const a = left?.textureDescriptor,
    b = right?.textureDescriptor;
  return (
    a !== undefined &&
    b !== undefined &&
    a.format === b.format &&
    a.dimension === b.dimension &&
    a.mipLevelCount === b.mipLevelCount &&
    a.sampleCount === b.sampleCount &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    a.size.depthOrArrayLayers === b.size.depthOrArrayLayers &&
    JSON.stringify(a.viewFormats ?? []) === JSON.stringify(b.viewFormats ?? [])
  );
}

function sameView<FrameCtx extends RenderGraphFrame>(
  left: CompiledView<FrameCtx> | undefined,
  right: CompiledView<FrameCtx> | undefined,
  texture: CompiledResource<FrameCtx> | undefined,
): boolean {
  const allocation = texture?.textureDescriptor;
  if (left === undefined || right === undefined || allocation === undefined) return false;
  const normalized = (view: CompiledView<FrameCtx>) => {
    const d = view.record.descriptor;
    const mip = d.baseMipLevel ?? 0,
      layer = d.baseArrayLayer ?? 0;
    return [
      d.format ?? allocation.format,
      d.dimension ??
        (allocation.dimension === '3d'
          ? '3d'
          : allocation.size.depthOrArrayLayers > 1
            ? '2d-array'
            : '2d'),
      d.aspect ?? 'all',
      mip,
      d.mipLevelCount ?? (allocation.mipLevelCount ?? 1) - mip,
      layer,
      d.arrayLayerCount ?? allocation.size.depthOrArrayLayers - layer,
    ];
  };
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export class CompiledRenderGraphImpl<FrameCtx extends RenderGraphFrame>
  implements CompiledRenderGraph<FrameCtx>
{
  private retired = false;
  private resolving = false;
  private retireResult: Promise<Result<void, RenderGraphError>> | undefined;
  private readonly allocationLedger: RenderGraphAllocationLedger;
  private inspection: CompiledRenderGraphInfo | undefined;
  private importsResolved = false;
  // Frame-resource tables and per-pass resolvers are retained across frames:
  // every execution refills the same tables, so steady frames allocate neither.
  private readonly frameResources = {
    buffers: new Map<number, Buffer>(),
    textures: new Map<number, Texture>(),
    views: new Map<number, TextureView>(),
    accelerationStructures: new Map<number, Tlas>(),
  };
  private readonly resolvers = new Map<
    CompiledPass<FrameCtx>,
    {
      readonly resolver: GraphResourceResolver;
      raster?: Writable<RenderPassDescriptor>;
      compute?: ComputePassDescriptor;
    }
  >();
  private readonly importedViews = new Map<number, { texture: Texture; view: TextureView }>();
  /** The compiler owns fixed membership; mutable resolution values stay with their records. */
  private readonly resourceOrder: readonly CompiledResource<FrameCtx>[];
  private readonly pendingTextureWrites = new Map<string, StagedTextureWrite[]>();

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly resources: ReadonlyMap<number, CompiledResource<FrameCtx>>,
    private readonly views: ReadonlyMap<number, CompiledView<FrameCtx>>,
    private readonly passes: readonly CompiledPass<FrameCtx>[],
    private readonly info: CompiledRenderGraphInfo,
    private readonly colorTargetDescriptors: ReadonlyMap<string, ResolvedColorTargetDescriptor>,
    private readonly requiredTextureReads: readonly {
      readonly resourceId: number;
      readonly range: GraphTextureContentRange;
      readonly passName: string;
      readonly usage: GraphAccessUsage;
    }[],
    private readonly rasterBatches: ReadonlyMap<number, RasterBatch<FrameCtx>>,
  ) {
    compiledGraphs.add(this);
    this.resourceOrder = [...resources.values()];
    const infoByLabel = new Map(info.resources.map((resource) => [resource.label, resource]));
    const entries: AllocationEntry[] = [];
    let importedResourceCount = 0;
    for (const compiled of resources.values()) {
      if (!isResolved(compiled)) continue;
      const handle = compiled.texture ?? compiled.buffer;
      if (compiled.record.origin === 'imported') {
        importedResourceCount += 1;
        continue;
      }
      if (handle === undefined) continue;
      entries.push({
        handle,
        bytes: infoByLabel.get(compiled.record.label)?.byteSize,
        newlyAllocated:
          compiled.textureAllocation === undefined || compiled.textureAllocation.references === 1,
      });
    }
    this.allocationLedger = new RenderGraphAllocationLedger(entries, importedResourceCount);
  }

  inspect(): CompiledRenderGraphInfo {
    const allocation = this.allocationLedger.inspect();
    if (this.inspection?.resourceAllocation === allocation) return this.inspection;
    const states = new Map<string, 'live' | 'pending-retirement' | 'released'>();
    const imports = new Map<string, string>();
    for (const resource of this.resources.values()) {
      states.set(
        resource.record.label,
        this.allocationLedger.state(resource.texture ?? resource.buffer),
      );
      if (this.importsResolved && resource.record.origin === 'imported') {
        const handle =
          this.frameResources.textures.get(resource.record.id) ??
          this.frameResources.buffers.get(resource.record.id);
        if (handle !== undefined) imports.set(resource.record.label, physicalAllocationKey(handle));
      }
    }
    const resources = this.info.resources.map((resource) => {
      const imported = imports.get(resource.label);
      if (imported !== undefined)
        return Object.freeze({ ...resource, physicalAllocationKey: imported });
      if (resource.origin !== 'created' || resource.physicalAllocationKey === undefined)
        return resource;
      return Object.freeze({ ...resource, allocationState: states.get(resource.label) });
    });
    this.inspection = Object.freeze({
      ...this.info,
      resources: Object.freeze(resources),
      resourceAllocation: allocation,
    });
    return this.inspection;
  }

  /** The immutable declaration facts captured at compile time, without allocation inspection. */
  passDeclarations(): CompiledRenderGraphInfo['passes'] {
    return this.info.passes;
  }

  /** The immutable compiled generation, without materializing allocation inspection. */
  compiledGeneration(): number {
    return this.generation;
  }

  retainTexture(
    device: RhiDevice,
    label: string,
    signature: string,
  ): GraphTextureAllocation | undefined {
    if (this.retired || this.device !== device) return undefined;
    for (const resource of this.resources.values()) {
      const allocation = resource.textureAllocation;
      if (
        resource.record.label !== label ||
        resource.record.kind !== 'texture' ||
        resource.record.origin !== 'created' ||
        allocation?.signature !== signature
      )
        continue;
      allocation.references += 1;
      return allocation;
    }
    return undefined;
  }

  /** @internal Compiler-only snapshot of the shared allocation proof. */
  _getCommittedTextureRanges(
    device: RhiDevice,
    label: string,
    signature: string,
  ): readonly GraphTextureContentRange[] | undefined {
    if (this.retired || this.device !== device) return undefined;
    for (const resource of this.resources.values()) {
      const allocation = resource.textureAllocation;
      if (
        resource.record.label === label &&
        resource.record.kind === 'texture' &&
        resource.record.origin === 'created' &&
        resource.record.descriptor.lifetime === 'persistent' &&
        allocation?.signature === signature
      )
        return allocation.committedContentRanges;
    }
    return undefined;
  }

  commitExecution(): void {
    if (this.retired) {
      this.pendingTextureWrites.clear();
      return;
    }
    for (const [key, writes] of this.pendingTextureWrites) {
      const allocation = [...this.resources.values()].find(
        (resource) =>
          resource.textureAllocation !== undefined &&
          physicalAllocationKey(resource.textureAllocation.texture) === key,
      )?.textureAllocation;
      if (allocation === undefined) continue;
      const committed = allocation.committedContentRanges;
      for (const write of writes) {
        const remaining = committed.flatMap((range) => subtractTextureRange(range, write.range));
        committed.splice(0, committed.length, ...remaining);
        if (write.stored) committed.push(write.range);
      }
    }
    this.pendingTextureWrites.clear();
  }

  discardExecution(): void {
    this.pendingTextureWrites.clear();
  }

  reuseTextureView(
    device: RhiDevice,
    texture: Texture,
    record: TextureViewRecord<FrameCtx>,
  ): TextureView | undefined {
    if (this.retired || this.device !== device) return undefined;
    const descriptor = record.descriptor;
    const matches = (compiled: CompiledView<FrameCtx> | undefined): boolean => {
      if (
        compiled?.view === undefined ||
        this.resources.get(compiled.record.textureId)?.texture !== texture
      )
        return false;
      const previous = compiled.record.descriptor;
      return (
        previous.format === descriptor.format &&
        previous.dimension === descriptor.dimension &&
        previous.aspect === descriptor.aspect &&
        previous.baseMipLevel === descriptor.baseMipLevel &&
        previous.mipLevelCount === descriptor.mipLevelCount &&
        previous.baseArrayLayer === descriptor.baseArrayLayer &&
        previous.arrayLayerCount === descriptor.arrayLayerCount
      );
    };
    // Ordinals are only a probe; physical texture and complete view fields
    // remain authoritative when feature declarations change their order.
    const previous = this.views.get(record.id);
    if (matches(previous)) return previous?.view;
    for (const compiled of this.views.values()) {
      if (compiled !== previous && matches(compiled)) return compiled.view;
    }
    return undefined;
  }

  getColorTargetView(name: string): TextureView | undefined {
    for (const view of this.views.values()) {
      const resource = this.resources.get(view.record.textureId);
      if (resource?.record.label === name) {
        return view.view ?? this.frameResources.views.get(view.record.id);
      }
    }
    return undefined;
  }

  getColorTargetTexture(name: string): Texture | undefined {
    for (const resource of this.resources.values()) {
      if (resource.record.label === name) {
        return resource.texture ?? this.frameResources.textures.get(resource.record.id);
      }
    }
    return undefined;
  }

  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined {
    const known = this.colorTargetDescriptors.get(name);
    if (known !== undefined) return known;
    for (const resource of this.resources.values()) {
      if (resource.record.label !== name || resource.record.kind !== 'texture') continue;
      const texture = resource.texture ?? this.frameResources.textures.get(resource.record.id);
      const descriptor = resource.textureDescriptor;
      if (texture === undefined || descriptor === undefined) return undefined;
      const declared = resource.record.descriptor as GraphTextureDescriptor;
      return {
        texture,
        format: declared.format,
        size: {
          width: descriptor.size.width,
          height: descriptor.size.height,
          depthOrArrayLayers: descriptor.size.depthOrArrayLayers ?? 1,
        },
        usage: descriptor.usage ?? resource.usage,
        sample: descriptor.sampleCount ?? 1,
      };
    }
    return undefined;
  }

  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
  ): Result<void, RenderGraphError> {
    if (this.retired) {
      return err(
        new RenderGraphError({
          code: 'compiled-graph-retired',
          expected: 'a compiled graph executes only before retire()',
          hint: 'publish and execute the replacement compiled graph',
          detail: { generation: this.generation },
        }),
      );
    }

    for (const read of this.requiredTextureReads) {
      const resource = this.resources.get(read.resourceId);
      const committed = resource?.textureAllocation?.committedContentRanges ?? [];
      if (textureRangeCovered(read.range, committed)) continue;
      return err(
        new RenderGraphError({
          code: 'uninitialized-read',
          expected: `borrowed persistent texture content remains initialized before pass '${read.passName}' executes`,
          hint: 'recompile the candidate after the allocation content changes',
          detail: {
            passName: read.passName,
            ...(resource === undefined ? {} : { resourceLabel: resource.record.label }),
            usage: read.usage,
          },
        }),
      );
    }

    const resolved = this.resolveFrameResources(frame);
    if (!resolved.ok) return resolved;
    const writes = new Map<string, StagedTextureWrite[]>();
    const executed = this.#executeResolved(
      frame,
      resolved.value,
      runPass,
      instrumentation,
      { next: 0 },
      writes,
    );
    if (executed.ok) {
      for (const [key, ranges] of writes) {
        const pending = this.pendingTextureWrites.get(key) ?? [];
        pending.push(...ranges);
        this.pendingTextureWrites.set(key, pending);
      }
    }
    return executed;
  }

  #stagePassTextureWrites(
    pass: CompiledPass<FrameCtx>,
    resolved: FrameResources,
    writes: Map<string, StagedTextureWrite[]>,
  ): void {
    for (const write of pass.pass.kind === 'subgraph' ? [] : pass.textureWrites) {
      const texture = resolved.textures.get(write.resourceId);
      if (texture === undefined) continue;
      const key = physicalAllocationKey(texture);
      const ranges = writes.get(key) ?? [];
      ranges.push({ range: write.range, stored: write.stored });
      writes.set(key, ranges);
    }
  }

  #executeResolved(
    frame: FrameCtx,
    resolved: FrameResources,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    indices = { next: 0 },
    writes = new Map<string, StagedTextureWrite[]>(),
  ): Result<void, RenderGraphError> {
    if (this.retired || executingGraphs.has(this))
      return this.subgraphError('execution', 'a live, non-recursive compiled graph');
    executingGraphs.add(this);
    try {
      for (let passIndex = 0; passIndex < this.passes.length; passIndex++) {
        const batch = this.rasterBatches.get(passIndex);
        if (batch !== undefined) {
          try {
            const last = rasterBatchBoundary(this.passes, passIndex, batch.last, runPass);
            if (last > passIndex) {
              const result = this.#encodeRasterBatch(
                batch,
                passIndex,
                last,
                frame,
                resolved,
                runPass,
                instrumentation,
                indices,
                writes,
              );
              if (!result.ok) return result;
              passIndex = last;
              continue;
            }
          } catch (cause) {
            return err(
              new RenderGraphError({
                code: 'pass-encode-failed',
                expected: `raster batch '${batch.name}' observes a valid execution boundary`,
                hint: 'repair the observation callback and retry the graph',
                detail: {
                  passName: this.passes[passIndex]?.name ?? batch.name,
                  passKind: 'raster',
                  cause,
                },
              }),
            );
          }
        }
        const pass = this.passes[passIndex] as CompiledPass<FrameCtx>;
        const executionIndex = pass.pass.kind === 'subgraph' ? indices.next : indices.next++;
        const resolver = this.passResolver(pass, resolved);
        try {
          if (pass.pass.descriptor.executeIf?.(frame) === false) continue;
          // The execution record and encode closure exist only for an observer.
          const execution = passExecutionRecord(
            pass,
            executionIndex,
            resolver,
            runPass !== undefined || instrumentation !== undefined,
          );
          let didEncode = execution === undefined;
          // No closure in this loop body: a captured binding would allocate a
          // context per pass even when no runner observes the pass.
          const observe = runPass !== undefined && execution !== undefined;
          if (!observe) didEncode = true;
          const encodeResult = !observe
            ? this.#encodePass(
                pass,
                frame,
                resolved,
                resolver,
                execution,
                runPass,
                instrumentation,
                indices,
                writes,
              )
            : this.#observePass(
                pass,
                frame,
                resolved,
                resolver,
                execution,
                runPass,
                instrumentation,
                indices,
                writes,
                () => {
                  didEncode = true;
                },
              );
          if (!encodeResult.ok) return encodeResult;
          if (didEncode) {
            this.#stagePassTextureWrites(pass, resolved, writes);
          }
        } catch (cause) {
          return err(
            new RenderGraphError({
              code: 'pass-encode-failed',
              expected: `pass '${pass.name}' encodes without throwing`,
              hint: 'inspect detail.cause and repair the pass-owned RHI command',
              detail: { passName: pass.name, passKind: pass.pass.kind, cause },
            }),
          );
        }
      }
      return ok(undefined);
    } finally {
      executingGraphs.delete(this);
    }
  }

  #encodeRasterBatch(
    batch: RasterBatch<FrameCtx>,
    first: number,
    last: number,
    frame: FrameCtx,
    resolved: FrameResources,
    runPass: RenderGraphPassRunner | undefined,
    instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
    indices: { next: number },
    writes: Map<string, StagedTextureWrite[]>,
  ): Result<void, RenderGraphError> {
    let encoder: RhiRenderPassEncoder | undefined;
    let scope: RenderGraphPassInstrumentationScope | undefined;
    let active = this.passes[first] as CompiledPass<FrameCtx>;
    const executionIndex = indices.next;
    const complete = first === batch.first && last === batch.last;
    const names = complete ? batch.names : this.passes.slice(first, last + 1).map((p) => p.name);
    const name = complete ? batch.name : names.join(' + ');
    const final = this.passes[last];
    if (final?.pass.kind !== 'raster') throw new Error('compiled raster batch has no final stage');
    const finalDescriptor = final.pass.descriptor;
    const finalResolver = this.passResolver(final, resolved);
    let outcome: Result<void, RenderGraphError> = ok(undefined);
    try {
      for (let i = first; i <= last; i++) {
        active = this.passes[i] as CompiledPass<FrameCtx>;
        if (active.pass.kind !== 'raster')
          throw new Error('compiled raster batch contains non-raster work');
        const descriptor = active.pass.descriptor;
        const resolver = this.passResolver(active, resolved);
        const logicalIndex = indices.next++;
        const encode = () => {
          if (encoder === undefined) {
            const physical = {
              name,
              kind: 'raster' as const,
              executionIndex,
              logicalPassNames: names,
            };
            scope = safePassScope(instrumentation, physical, frame);
            const context = this.resolvers.get(active);
            const retained = scope === undefined ? context?.raster : undefined;
            // A diagnostic runner may omit a prefix. Start with the first
            // actually encoded member's load/clear semantics.
            const attachments =
              i === batch.first && complete
                ? batch.colorAttachments
                : descriptor.colorAttachments.map((attachment, index) => ({
                    ...attachment,
                    storeOp: finalDescriptor.colorAttachments[index]?.storeOp ?? attachment.storeOp,
                    resolveTarget: finalDescriptor.colorAttachments[index]?.resolveTarget,
                  }));
            const colors = resolveRasterColors(
              attachments,
              frame,
              finalResolver,
              retained?.colorAttachments,
            );
            if (!colors.ok) throw colors.error;
            const depthAttachment =
              i === batch.first && complete
                ? batch.depthStencilAttachment
                : descriptor.depthStencilAttachment === undefined
                  ? undefined
                  : {
                      ...descriptor.depthStencilAttachment,
                      depthStoreOp: finalDescriptor.depthStencilAttachment?.depthStoreOp,
                      stencilStoreOp: finalDescriptor.depthStencilAttachment?.stencilStoreOp,
                    };
            const depth = resolveRasterDepth(
              depthAttachment,
              resolver,
              retained?.depthStencilAttachment,
            );
            if (!depth.ok) throw depth.error;
            const native: Writable<RenderPassDescriptor> = retained ?? {
              label: name,
              colorAttachments: colors.value,
            };
            native.label = name;
            if (depth.value === undefined) delete native.depthStencilAttachment;
            else native.depthStencilAttachment = depth.value;
            if (scope === undefined && context !== undefined) context.raster = native;
            encoder = frame.encoder.beginRenderPass(
              decorateDescriptor(scope, scope?.renderPassDescriptor, native),
            );
          }
          // Independent native passes start with these defaults. Preserve them
          // between logical stages, including after a partial/scissored writer.
          const attachment =
            descriptor.colorAttachments[0]?.view ?? descriptor.depthStencilAttachment?.view;
          if (attachment !== undefined) {
            const extent = resolver.textureViewExtent(attachment);
            if (!extent.ok) throw extent.error;
            encoder.setViewport(0, 0, extent.value.width, extent.value.height, 0, 1);
            encoder.setScissorRect(0, 0, extent.value.width, extent.value.height);
          }
          encoder.setBlendConstant([0, 0, 0, 0]);
          encoder.setStencilReference(0);
          encoder.pushDebugGroup(active.name);
          try {
            if (descriptor.encodeDirect !== undefined)
              descriptor.encodeDirect(encoder, frame, resolver);
            else descriptor.encode({ pass: encoder, frame, resources: resolver });
          } finally {
            encoder.popDebugGroup();
          }
        };
        if (runPass === undefined) encode();
        else
          runPass(
            {
              name: active.name,
              kind: 'raster',
              executionIndex: logicalIndex,
              ...(descriptor.depthStencilAttachment === undefined
                ? {}
                : {
                    resolvedDepthStencilAttachmentView: resolver
                      .textureView(descriptor.depthStencilAttachment.view)
                      .unwrap(),
                  }),
            },
            encode,
          );
      }
      // The native attachment lifetime ends once, with the final descriptor's
      // store/resolve semantics, even when a diagnostic omits a logical body.
      if (encoder !== undefined) {
        for (const write of final.textureWrites) {
          const texture = resolved.textures.get(write.resourceId);
          if (texture === undefined) continue;
          const key = physicalAllocationKey(texture);
          const ranges = writes.get(key) ?? [];
          ranges.push({ range: write.range, stored: write.stored });
          writes.set(key, ranges);
        }
      }
    } catch (cause) {
      outcome = err(
        new RenderGraphError({
          code: 'pass-encode-failed',
          expected: `pass '${active.name}' encodes without throwing`,
          hint: 'inspect detail.cause and repair the pass-owned RHI command',
          detail: { passName: active.name, passKind: 'raster', cause },
        }),
      );
    } finally {
      try {
        encoder?.end();
      } catch (cause) {
        outcome = err(
          new RenderGraphError({
            code: 'pass-encode-failed',
            expected: `raster batch '${name}' closes without throwing`,
            hint: 'inspect detail.cause and repair the pass-owned RHI command',
            detail: { passName: active.name, passKind: 'raster', cause },
          }),
        );
      } finally {
        safeEndPass(scope);
      }
    }
    return outcome;
  }

  #observePass(
    pass: CompiledPass<FrameCtx>,
    frame: FrameCtx,
    resolved: FrameResources,
    resolver: GraphResourceResolver,
    execution: RenderGraphPassExecution,
    runPass: RenderGraphPassRunner,
    instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
    indices: { next: number },
    writes: Map<string, StagedTextureWrite[]>,
    didEncode: () => void,
  ): Result<void, RenderGraphError> {
    let encodeResult: Result<void, RenderGraphError> = ok(undefined);
    runPass(execution, () => {
      didEncode();
      encodeResult = this.#encodePass(
        pass,
        frame,
        resolved,
        resolver,
        execution,
        runPass,
        instrumentation,
        indices,
        writes,
      );
    });
    return encodeResult;
  }

  #encodePass(
    pass: CompiledPass<FrameCtx>,
    frame: FrameCtx,
    resolved: FrameResources,
    resolver: GraphResourceResolver,
    execution: RenderGraphPassExecution | undefined,
    runPass: RenderGraphPassRunner | undefined,
    instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
    indices: { next: number },
    writes: Map<string, StagedTextureWrite[]>,
  ): Result<void, RenderGraphError> {
    // Resolve instrumentation only when the runner actually enters the
    // pass. A runner may inspect or skip a pass without calling encode;
    // such a pass must not reserve timestamp queries that it never
    // writes.
    const scope =
      pass.pass.kind === 'subgraph' || execution === undefined
        ? undefined
        : safePassScope(instrumentation, execution, frame);
    try {
      switch (pass.pass.kind) {
        case 'raster': {
          const resolveRasterPassDescriptor = (
            descriptor: Extract<CompiledPass<FrameCtx>['pass'], { kind: 'raster' }>['descriptor'],
          ) => {
            // Native beginRenderPass consumes its descriptor synchronously. Reuse
            // this graph's private recording storage; instrumented calls retain
            // their independent descriptors for observer ownership.
            const context = this.resolvers.get(pass);
            const retained = scope === undefined ? context?.raster : undefined;
            const colors = resolveRasterColors(
              descriptor.colorAttachments,
              frame,
              resolver,
              retained?.colorAttachments,
            );
            if (!colors.ok) return colors;
            const colorAttachments = colors.value;
            const depth = resolveRasterDepth(
              descriptor.depthStencilAttachment,
              resolver,
              retained?.depthStencilAttachment,
            );
            if (!depth.ok) return depth;
            const depthStencilAttachment = depth.value;
            const querySet =
              typeof descriptor.occlusionQuerySet === 'function'
                ? descriptor.occlusionQuerySet(frame)
                : descriptor.occlusionQuerySet;
            const baseDescriptor: Writable<RenderPassDescriptor> = retained ?? {
              label: pass.name,
              colorAttachments,
            };
            baseDescriptor.label = pass.name;
            if (depthStencilAttachment === undefined) delete baseDescriptor.depthStencilAttachment;
            else baseDescriptor.depthStencilAttachment = depthStencilAttachment;
            if (querySet === undefined) delete baseDescriptor.occlusionQuerySet;
            else baseDescriptor.occlusionQuerySet = querySet;
            if (scope === undefined && context !== undefined) context.raster = baseDescriptor;
            return ok(baseDescriptor);
          };
          const descriptor = pass.pass.descriptor;
          const rasterDescriptor = resolveRasterPassDescriptor(descriptor);
          if (!rasterDescriptor.ok) return rasterDescriptor;
          const baseDescriptor = rasterDescriptor.value;
          const instrumentedDescriptor = decorateDescriptor(
            scope,
            scope?.renderPassDescriptor,
            baseDescriptor,
          );
          const encoder = frame.encoder.beginRenderPass(instrumentedDescriptor);
          try {
            if (descriptor.encodeDirect !== undefined)
              descriptor.encodeDirect(encoder, frame, resolver);
            else descriptor.encode({ pass: encoder, frame, resources: resolver });
          } finally {
            encoder.end();
          }
          break;
        }
        case 'compute': {
          const begin = pass.pass.descriptor.begin?.(frame);
          const instrumentedBegin =
            scope?.computePassDescriptor === undefined
              ? begin
              : decorateDescriptor(scope, scope.computePassDescriptor, begin ?? {});
          let encoder: RhiComputePassEncoder;
          try {
            encoder = frame.encoder.beginComputePass(
              this.computePassDescriptor(pass, instrumentedBegin, scope !== undefined),
            );
          } catch (cause) {
            pass.pass.descriptor.onBeginError?.(frame, cause);
            throw cause;
          }
          try {
            if (pass.pass.descriptor.encodeDirect !== undefined)
              pass.pass.descriptor.encodeDirect(encoder, frame, resolver);
            else pass.pass.descriptor.encode({ pass: encoder, frame, resources: resolver });
          } finally {
            encoder.end();
          }
          pass.pass.descriptor.after?.(frame);
          break;
        }
        case 'copy':
          try {
            scope?.beforeCopy?.(frame.encoder);
          } catch {
            // Instrumentation is diagnostic and cannot prevent the copy body.
          }
          try {
            if (pass.pass.descriptor.encodeDirect !== undefined)
              pass.pass.descriptor.encodeDirect(frame.encoder, frame, resolver);
            else
              pass.pass.descriptor.encode({ encoder: frame.encoder, frame, resources: resolver });
          } finally {
            try {
              scope?.afterCopy?.(frame.encoder);
            } catch {
              // Instrumentation is diagnostic and cannot replace a copy error.
            }
          }
          break;
        case 'subgraph':
          return this.executeSubgraph(
            pass,
            frame,
            resolved,
            resolver,
            runPass,
            instrumentation,
            indices,
            writes,
          );
      }
    } finally {
      safeEndPass(scope);
    }
    return ok(undefined);
  }

  private computePassDescriptor(
    pass: CompiledPass<FrameCtx>,
    begin: ComputePassDescriptor | undefined,
    observed: boolean,
  ): ComputePassDescriptor {
    if (observed || begin !== undefined) return { ...begin, label: pass.name };
    const context = this.resolvers.get(pass);
    if (context === undefined) return { label: pass.name };
    context.compute ??= Object.freeze({ label: pass.name });
    return context.compute;
  }

  private subgraphError(field: string, expected: string): Result<never, RenderGraphError> {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected,
        hint: 'repair the subgraph ports or use the ordinary graph projection',
        detail: { resourceLabel: 'subgraph', field, expected },
      }),
    );
  }

  private executeSubgraph(
    pass: CompiledPass<FrameCtx>,
    frame: FrameCtx,
    parent: FrameResources,
    resolver: GraphResourceResolver,
    runPass: RenderGraphPassRunner | undefined,
    instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
    indices: { next: number },
    writes: Map<string, StagedTextureWrite[]>,
  ): Result<void, RenderGraphError> {
    if (pass.pass.kind !== 'subgraph') return this.subgraphError('kind', 'a subgraph pass');
    const descriptor = pass.pass.descriptor;
    if (descriptor.commands !== undefined) {
      let active = true;
      let encoding = false;
      try {
        descriptor.commands({
          frame,
          resources: resolver,
          execute: (work) => {
            if (!active || encoding || this.retired) {
              const failure = this.subgraphError(
                'execution',
                'synchronous, non-recursive native commands on a live graph',
              );
              if (!failure.ok) throw failure.error;
            }
            encoding = true;
            try {
              const execution = {
                name: work.name,
                kind: work.kind,
                executionIndex: indices.next++,
              };
              const encode = () => {
                const scope = safePassScope(instrumentation, execution, frame);
                try {
                  switch (work.kind) {
                    case 'compute': {
                      const descriptor = decorateDescriptor(
                        scope,
                        scope?.computePassDescriptor,
                        work.descriptor ?? {},
                      );
                      const encoder = frame.encoder.beginComputePass({
                        ...descriptor,
                        label: work.name,
                      });
                      try {
                        work.encode(encoder);
                      } finally {
                        encoder.end();
                      }
                      break;
                    }
                    case 'raster': {
                      const descriptor = decorateDescriptor(
                        scope,
                        scope?.renderPassDescriptor,
                        work.descriptor,
                      );
                      const encoder = frame.encoder.beginRenderPass(descriptor);
                      try {
                        work.encode(encoder);
                      } finally {
                        encoder.end();
                      }
                      break;
                    }
                    case 'copy':
                      try {
                        scope?.beforeCopy?.(frame.encoder);
                      } catch {
                        // Instrumentation is diagnostic and cannot prevent the copy body.
                      }
                      try {
                        work.encode(frame.encoder);
                      } finally {
                        try {
                          scope?.afterCopy?.(frame.encoder);
                        } catch {
                          // Instrumentation is diagnostic and cannot replace a copy error.
                        }
                      }
                      break;
                  }
                } finally {
                  safeEndPass(scope);
                }
              };
              if (runPass === undefined) encode();
              else runPass(execution, encode);
            } finally {
              encoding = false;
            }
          },
        });
      } finally {
        active = false;
      }
      return ok(undefined);
    }
    const selected = descriptor.child(frame, resolver);
    if (!compiledGraphs.has(selected))
      return this.subgraphError('child', 'a graph compiled by RenderGraphBuilder');
    const child = selected as CompiledRenderGraphImpl<FrameCtx>;
    if (child.device !== this.device)
      return this.subgraphError('device', 'the same RHI device for parent and child');
    if (child.retired || executingGraphs.has(child))
      return this.subgraphError('child', 'a live, non-recursive child graph');
    if (
      [...child.resources.values()].some(
        (resource) =>
          resource.record.origin !== 'imported' ||
          resource.record.kind === 'acceleration-structure' ||
          (resource.record.kind === 'texture' && !isResolved(resource)),
      ) ||
      child.passes.some((entry) => entry.pass.kind === 'subgraph')
    )
      return this.subgraphError('resources', 'an import-only child without nested subgraphs');
    const snapshot = child.resolveFrameResources(frame);
    if (!snapshot.ok) return snapshot;
    const childResources = snapshot.value;
    const ports = pass.pass.descriptor.accesses;
    const parentBuffers = new Set(parent.buffers.values());
    for (const childPass of child.passes) {
      for (const access of childPass.pass.descriptor.accesses) {
        const data = handleData(access.resource);
        if (data === undefined) return this.subgraphError('access', 'a compiled child access');
        if (data.kind === 'buffer') {
          const buffer = childResources.buffers.get(data.id);
          if (buffer === undefined || !parentBuffers.has(buffer)) continue;
          if (
            !ports.some((port) => {
              const source = handleData(port.resource);
              return (
                source?.kind === 'buffer' &&
                parent.buffers.get(source.id) === buffer &&
                coversUsage(port.usage, access.usage) &&
                bufferSize(this.resources.get(source.id)) ===
                  bufferSize(child.resources.get(data.id))
              );
            })
          )
            return this.subgraphError(
              'buffer-port',
              'every shared child buffer access is declared by the parent',
            );
          continue;
        }
        if (data.kind !== 'texture-view')
          return this.subgraphError('access', 'only buffer and texture-view child accesses');
        if (
          !ports.some((port) => {
            const source = handleData(port.resource);
            if (source?.kind !== 'texture-view' || !coversUsage(port.usage, access.usage))
              return false;
            return (
              parent.textures.get(source.textureId) ===
                childResources.textures.get(data.textureId) &&
              parent.views.get(source.id) === childResources.views.get(data.id) &&
              sameTexture(
                this.resources.get(source.textureId),
                child.resources.get(data.textureId),
              ) &&
              sameView(
                this.views.get(source.id),
                child.views.get(data.id),
                this.resources.get(source.textureId),
              )
            );
          })
        )
          return this.subgraphError(
            'texture-port',
            'every child texture access uses the exact parent texture, view, extent and usage',
          );
      }
    }
    // Import callbacks can retire a graph; validation and encoding use this one snapshot.
    if (this.retired || child.retired)
      return this.subgraphError('child', 'parent and child remain live after import resolution');
    return child.#executeResolved(frame, childResources, runPass, instrumentation, indices, writes);
  }

  retire(): Promise<Result<void, RenderGraphError>> {
    if (this.retireResult !== undefined) return this.retireResult;
    this.retired = true;
    this.retireResult = this.finishRetire();
    return this.retireResult;
  }

  private async finishRetire(): Promise<Result<void, RenderGraphError>> {
    this.allocationLedger.retireAll();
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch (cause) {
      return err(
        new RenderGraphError({
          code: 'resource-retire-failed',
          expected: 'the GPU submission fence resolves before graph resources retire',
          hint: 'recover the device before retiring the replacement generation',
          detail: { generation: this.generation, cause },
        }),
      );
    }

    let firstFailure: RenderGraphError | undefined;
    for (const compiled of this.resources.values()) {
      if (compiled.record.origin === 'imported') continue;
      if (compiled.texture === undefined && compiled.buffer === undefined) continue;
      let destroyedSuccessfully = false;
      try {
        const destroyed =
          compiled.textureAllocation !== undefined
            ? releaseGraphTexture(this.device, compiled.textureAllocation)
            : compiled.record.kind === 'texture'
              ? this.device.destroyTexture(compiled.texture as Texture)
              : this.device.destroyBuffer(compiled.buffer as Buffer);
        destroyedSuccessfully = destroyed.ok;
        if (!destroyed.ok && firstFailure === undefined) {
          firstFailure = new RenderGraphError({
            code: 'resource-retire-failed',
            expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
            hint: 'inspect detail.cause for the RHI destroy refusal',
            detail: {
              generation: this.generation,
              resourceLabel: compiled.record.label,
              cause: destroyed.error,
            },
          });
        }
      } catch (cause) {
        firstFailure ??= new RenderGraphError({
          code: 'resource-retire-failed',
          expected: `graph-created resource '${compiled.record.label}' retires exactly once`,
          hint: 'inspect detail.cause for the RHI destroy failure',
          detail: { generation: this.generation, resourceLabel: compiled.record.label, cause },
        });
      } finally {
        // A failed or throwing destroy leaves the handle owned by this
        // graph. Keep its token pending so inspection reflects the
        // retirement failure instead of claiming bytes were released.
        if (destroyedSuccessfully)
          this.allocationLedger.release(compiled.texture ?? compiled.buffer);
      }
    }
    return firstFailure === undefined ? ok(undefined) : err(firstFailure);
  }

  private resolveFrameResources(frame: FrameCtx): Result<FrameResources, RenderGraphError> {
    if (this.retired || this.resolving || executingGraphs.has(this))
      return this.subgraphError('execution', 'a live, non-recursive compiled graph');
    this.resolving = true;
    try {
      return this.resolveFrameResourceValues(frame);
    } finally {
      this.resolving = false;
    }
  }

  private resolveFrameResourceValues(frame: FrameCtx): Result<FrameResources, RenderGraphError> {
    const frameResources = this.frameResources;
    // Keys are the compiled graph's static resolved-resource ids, so each
    // frame overwrites the same entries; clearing would shrink and regrow the
    // hash tables every frame.
    const { buffers, textures, views, accelerationStructures } = frameResources;
    let resolved = false;
    try {
      for (let index = 0; index < this.resourceOrder.length; index++) {
        const compiled = this.resourceOrder[index] as CompiledResource<FrameCtx>;
        if (!isResolved(compiled)) continue;
        try {
          if (compiled.record.kind === 'texture') {
            const texture =
              compiled.record.origin === 'created'
                ? compiled.texture
                : compiled.record.resolve(frame);
            if (texture === undefined) return err(resolutionError(compiled.record.label));
            if (
              compiled.record.origin === 'imported' &&
              textures.get(compiled.record.id) !== texture
            )
              this.inspection = undefined;
            textures.set(compiled.record.id, texture);
          } else if (compiled.record.kind === 'acceleration-structure') {
            accelerationStructures.set(compiled.record.id, compiled.record.resolve(frame));
          } else {
            const buffer =
              compiled.record.origin === 'created'
                ? compiled.buffer
                : compiled.record.resolve(frame);
            if (buffer === undefined) return err(resolutionError(compiled.record.label));
            if (compiled.record.origin === 'imported' && buffers.get(compiled.record.id) !== buffer)
              this.inspection = undefined;
            buffers.set(compiled.record.id, buffer);
          }
        } catch (cause) {
          return err(resolutionError(compiled.record.label, cause));
        }
      }

      const resolveImportedViews = () => {
        for (const compiledView of this.views.values()) {
          if (this.resources.get(compiledView.record.textureId)?.usage === 0) continue;
          if (compiledView.record.resolve !== undefined) {
            try {
              views.set(compiledView.record.id, compiledView.record.resolve(frame));
            } catch (cause) {
              return err(resolutionError(compiledView.record.label, cause));
            }
            continue;
          }
          if (compiledView.view !== undefined) {
            views.set(compiledView.record.id, compiledView.view);
            continue;
          }
          const texture = textures.get(compiledView.record.textureId);
          if (texture === undefined) return err(resolutionError(compiledView.record.label));
          // A view of an imported texture depends only on that texture and the
          // compiled descriptor: re-create it only when the import changes.
          const previous = this.importedViews.get(compiledView.record.id);
          if (previous?.texture === texture) {
            views.set(compiledView.record.id, previous.view);
            continue;
          }
          const created = this.device.createTextureView(texture, compiledView.record.descriptor);
          if (!created.ok) return err(resolutionError(compiledView.record.label, created.error));
          this.importedViews.set(compiledView.record.id, { texture, view: created.value });
          views.set(compiledView.record.id, created.value);
        }
        return undefined;
      };
      const viewFailure = resolveImportedViews();
      if (viewFailure !== undefined) return viewFailure;
      resolved = true;
      return ok(frameResources);
    } finally {
      if (this.importsResolved !== resolved) this.inspection = undefined;
      this.importsResolved = resolved;
    }
  }

  private passResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    let context = this.resolvers.get(pass);
    if (context === undefined) {
      context = { resolver: this.createPassResolver(pass, frameResources) };
      this.resolvers.set(pass, context);
    }
    return context.resolver;
  }

  private createPassResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    const lookup = (
      resource: GraphBuffer | GraphTexture | GraphTextureView | GraphAccelerationStructure,
      expectedKind: ResourceHandleData['kind'],
    ): Result<ResourceHandleData, RenderGraphError> => {
      const data = handleData(resource);
      const resourceId = data?.kind === 'texture-view' ? data.textureId : data?.id;
      if (data === undefined || data.owner !== this.owner || data.kind !== expectedKind) {
        return err(
          new RenderGraphError({
            code: 'foreign-resource-handle',
            expected: `pass '${pass.name}' resolves a handle owned by this compiled graph`,
            hint: 'use only handles created by the builder that declared this pass',
            detail: { passName: pass.name },
          }),
        );
      }
      if (resourceId === undefined || !pass.resourceIds.has(resourceId)) {
        const label = this.resources.get(resourceId ?? -1)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only resources present in its accesses`,
            hint: 'add the resource access to this pass before resolving it',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      if (data.kind === 'texture-view' && !pass.viewIds.has(data.id)) {
        const label = this.views.get(data.id)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only texture views present in its accesses`,
            hint: 'add this exact texture view to the pass accesses',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      return okOf(data);
    };

    return {
      buffer: (resource) => {
        const data = lookup(resource, 'buffer');
        if (!data.ok) return data;
        const buffer = frameResources.buffers.get(data.value.id);
        return buffer === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'buffer'))
          : okOf(buffer);
      },
      bufferSource: (resource) => {
        const data = lookup(resource, 'buffer');
        if (!data.ok) return data;
        const compiled = this.resources.get(data.value.id);
        const buffer = frameResources.buffers.get(data.value.id);
        if (compiled?.record.kind !== 'buffer' || buffer === undefined)
          return err(resolutionError('buffer source'));
        return ok(
          Object.freeze({
            buffer,
            descriptor: Object.freeze({
              ...compiled.record.descriptor,
              usage:
                compiled.record.origin === 'imported'
                  ? compiled.record.descriptor.usage
                  : compiled.usage,
            }),
          }),
        );
      },
      texture: (resource) => {
        const data = lookup(resource, 'texture');
        if (!data.ok) return data;
        const texture = frameResources.textures.get(data.value.id);
        return texture === undefined
          ? err(resolutionError(this.resources.get(data.value.id)?.record.label ?? 'texture'))
          : okOf(texture);
      },
      textureViewSource: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        if (data.value.kind !== 'texture-view') return err(resolutionError('texture view source'));
        const compiledTexture = this.resources.get(data.value.textureId);
        if (compiledTexture?.record.kind !== 'texture')
          return err(resolutionError('texture view source'));
        const descriptor = compiledTexture.textureDescriptor;
        const viewDescriptor = this.views.get(data.value.id)?.record.descriptor;
        const texture = frameResources.textures.get(data.value.textureId);
        const view = frameResources.views.get(data.value.id);
        if (
          descriptor === undefined ||
          viewDescriptor === undefined ||
          texture === undefined ||
          view === undefined
        )
          return err(resolutionError('texture view source'));
        return ok(
          Object.freeze({
            texture,
            view,
            descriptor: Object.freeze({
              ...descriptor,
              format: compiledTexture.record.descriptor.format,
              usage: descriptor.usage ?? compiledTexture.usage,
              size: Object.freeze({
                width: descriptor.size.width,
                height: descriptor.size.height,
                depthOrArrayLayers: descriptor.size.depthOrArrayLayers,
              }),
              ...(descriptor.viewFormats === undefined
                ? {}
                : {
                    viewFormats: Object.freeze([...descriptor.viewFormats]),
                  }),
            }),
            viewDescriptor: Object.freeze({ ...viewDescriptor }),
          }),
        );
      },
      textureView: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        const view = frameResources.views.get(data.value.id);
        return view === undefined
          ? err(resolutionError(this.views.get(data.value.id)?.record.label ?? 'texture view'))
          : okOf(view);
      },
      textureViewExtent: (resource) => {
        const data = lookup(resource, 'texture-view');
        if (!data.ok) return data;
        const view = this.views.get(data.value.id)?.record;
        const texture = this.resources.get(view?.textureId ?? -1);
        const extent = texture?.textureDescriptor?.size;
        if (view === undefined || extent === undefined) {
          return err(resolutionError(texture?.record.label ?? 'texture view'));
        }
        const level = view.descriptor.baseMipLevel ?? 0;
        return ok({
          width: mipDimension(extent.width, level),
          height: mipDimension(extent.height, level),
        });
      },
      accelerationStructure: (resource) => {
        const data = lookup(resource, 'acceleration-structure');
        if (!data.ok) return data;
        const tlas = frameResources.accelerationStructures.get(data.value.id);
        return tlas === undefined
          ? err(
              resolutionError(
                this.resources.get(data.value.id)?.record.label ?? 'acceleration structure',
              ),
            )
          : okOf(tlas);
      },
    };
  }
}

/** Read frozen compile-time pass facts without materializing resource allocation inspection. */
export function compiledRenderGraphPassDeclarations(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>,
): CompiledRenderGraphInfo['passes'] {
  return graph instanceof CompiledRenderGraphImpl
    ? graph.passDeclarations()
    : graph.inspect().passes;
}

/** Read the immutable compiled generation without materializing allocation inspection. */
export function compiledRenderGraphGeneration(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>,
): number {
  return graph instanceof CompiledRenderGraphImpl
    ? graph.compiledGeneration()
    : graph.inspect().generation;
}
