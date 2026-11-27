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
import { RhiError } from '@forgeax/engine-rhi';
import { mipDimension } from '@forgeax/engine-types';
import type { AttachmentBindings } from './attachment-bindings.js';
import { allocationBytes, inspectPasses, inspectResource } from './compiled-inspection.js';
import { applyTextureContentWrite, textureRangeCovered } from './content-ranges.js';
import { err, ok, RenderGraphError, type Result, type ResultErr, type ResultOk } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import type {
  CompiledPass,
  CompiledResource,
  CompiledView,
  GraphTextureAllocation,
  PhysicalGraphSlots,
  ResourceHandleData,
  ResourceRecord,
} from './kernel-internal.js';
import {
  handleData,
  LINEAR_PASS_ACCESS_LIMIT,
  physicalAllocationKey,
  releaseGraphTexture,
} from './kernel-internal.js';
import {
  decorateDescriptor,
  NativeCommandRecorder,
  safeEndPass,
  safePassScope,
} from './native-pass.js';
import type { RasterBatch } from './raster-batching.js';
import { coversUsage, SubgraphBindings } from './subgraph-bindings.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  GraphAccelerationStructure,
  GraphAccess,
  GraphAccessUsage,
  GraphBuffer,
  GraphPreparationStep,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureContentRange,
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
  resolved: FrameResources,
  addresses: Uint32Array,
): RenderGraphPassExecution {
  if (pass.pass.kind === 'raster' && pass.pass.descriptor.depthStencilAttachment !== undefined) {
    const view = resolved.views.values[addresses[pass.accessEnd] as number];
    if (view === undefined) throw resolutionError('raster depth attachment');
    return {
      name: pass.name,
      kind: pass.pass.kind,
      executionIndex,
      resolvedDepthStencilAttachmentView: view,
    };
  }
  return { name: pass.name, kind: pass.pass.kind, executionIndex };
}

const DEFAULT_BLEND_CONSTANT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

const compiledGraphs = new WeakSet<object>();
const executingGraphs = new WeakSet<object>();
interface ExecutionCursor {
  next: number;
  readonly pendingPasses?: Set<string> | undefined;
}

type StagedTextureWrite = { readonly range: GraphTextureContentRange; readonly stored: boolean };

/** A physical texture may enter a child graph through an imported alias. Keep
 * actual handles and immutable pass writes in issue order until submission. */
class TextureWriteJournal {
  constructor(private readonly allocations: ReadonlyMap<Texture, GraphTextureAllocation>) {}

  readonly textures: Texture[] = [];
  readonly writes: StagedTextureWrite[] = [];

  add(texture: Texture, write: StagedTextureWrite): void {
    if (!this.allocations.has(texture)) return;
    this.textures.push(texture);
    this.writes.push(write);
  }

  clear(): void {
    this.textures.length = 0;
    this.writes.length = 0;
  }
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** Resolve one pass's color attachments into its retained native descriptor. */
function resolveRasterColors<FrameCtx>(
  attachments: readonly RasterColorAttachment<FrameCtx>[],
  frame: FrameCtx,
  resolved: FrameResources,
  addresses: Uint32Array,
  firstColor: number,
  retained: RenderPassDescriptor['colorAttachments'] | undefined,
): Writable<RenderPassColorAttachment>[] | RenderGraphError {
  const colorAttachments = (retained ?? []) as Writable<RenderPassColorAttachment>[];
  let colorIndex = 0;
  for (const attachment of attachments) {
    const view = resolved.views.values[addresses[firstColor++] as number];
    const targetId = addresses[firstColor++] as number;
    const resolveTarget = targetId === 0 ? undefined : resolved.views.values[targetId];
    if (view === undefined || (targetId !== 0 && resolveTarget === undefined))
      return resolutionError('raster color attachment');
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
      view,
      loadOp,
      storeOp,
    };
    color.view = view;
    color.loadOp = loadOp;
    color.storeOp = storeOp;
    if (resolveTarget !== undefined) color.resolveTarget = resolveTarget;
    else delete color.resolveTarget;
    if (clearValue === undefined) delete color.clearValue;
    else color.clearValue = clearValue;
    if (attachment.depthSlice !== undefined) color.depthSlice = attachment.depthSlice;
    colorAttachments[colorIndex++] = color;
  }
  colorAttachments.length = colorIndex;
  return colorAttachments;
}

/** Resolve the current depth view and attachment aspects without copying native storage. */
function resolveRasterDepth<Frame>(
  attachment: RasterDepthStencilAttachment<Frame> | undefined,
  frame: Frame,
  view: TextureView | undefined,
  retained: RenderPassDepthStencilAttachment | undefined,
): RenderPassDepthStencilAttachment | undefined | RenderGraphError {
  if (attachment === undefined) return undefined;
  if (view === undefined) return resolutionError('raster depth attachment');
  const depth: Writable<RenderPassDepthStencilAttachment> = retained ?? { view };
  depth.view = view;
  if (attachment.depthClearValue !== undefined) depth.depthClearValue = attachment.depthClearValue;
  const depthLoad = attachment.depthLoadOp;
  if (depthLoad !== undefined)
    depth.depthLoadOp = typeof depthLoad === 'function' ? depthLoad(frame) : depthLoad;
  if (attachment.depthStoreOp !== undefined) depth.depthStoreOp = attachment.depthStoreOp;
  else delete depth.depthStoreOp;
  if (attachment.depthReadOnly !== undefined) depth.depthReadOnly = attachment.depthReadOnly;
  if (attachment.stencilClearValue !== undefined)
    depth.stencilClearValue = attachment.stencilClearValue;
  const stencilLoad = attachment.stencilLoadOp;
  if (stencilLoad !== undefined)
    depth.stencilLoadOp =
      typeof stencilLoad !== 'function'
        ? stencilLoad
        : stencilLoad === depthLoad
          ? depth.depthLoadOp
          : stencilLoad(frame);
  if (attachment.stencilStoreOp !== undefined) depth.stencilStoreOp = attachment.stencilStoreOp;
  else delete depth.stencilStoreOp;
  if (attachment.stencilReadOnly !== undefined) depth.stencilReadOnly = attachment.stencilReadOnly;
  return depth;
}

/** Acceleration structures derive no RHI usage bits; a declared access keeps them live. */
function isResolved<FrameCtx>(compiled: CompiledResource<FrameCtx>): boolean {
  return compiled.record.kind === 'acceleration-structure'
    ? compiled.firstUse !== null
    : compiled.usage !== 0;
}

/** Execution reads current physical handles directly. A slot that publishes a public
 * Result owns that one immutable receipt until the handle is replaced. */
class FrameBindings<T extends object> {
  readonly values: (T | undefined)[] = [];
  private readonly receipts: (ResultOk<T> | undefined)[] = [];

  bind(id: number, value: T | undefined, receipt?: ResultOk<T>): boolean {
    if (this.values[id] === value) return false;
    this.values[id] = value;
    if (receipt !== undefined || this.receipts[id] !== undefined) this.receipts[id] = receipt;
    return true;
  }

  result(id: number): ResultOk<T> | undefined {
    const value = this.values[id];
    if (value === undefined) return undefined;
    this.receipts[id] ??= ok(value);
    return this.receipts[id];
  }
}

interface FrameResources {
  readonly buffers: FrameBindings<Buffer>;
  readonly textures: FrameBindings<Texture>;
  readonly views: FrameBindings<TextureView>;
  readonly accelerationStructures: FrameBindings<Tlas>;
}

type AllocationState = 'live' | 'pending-retirement';
type AllocationVisitor = (key: string | undefined, bytes: number, state: AllocationState) => void;

/**
 * Compiled-graph owner ledger. It counts only graph-created physical handles;
 * imported handles are references owned by the caller and remain byte-unknown.
 */
class RenderGraphAllocationLedger {
  private readonly allocations = new Map<object, number | null>();
  private phase: AllocationState = 'live';
  private inspection: RenderGraphResourceAllocationInspection | undefined;
  private heldBytes = 0;
  private peakBytes = 0;
  private successfulAllocationCount = 0;
  private successfulAllocationBytes = 0;
  private retiredBytes = 0;
  private unknownByteSizeCount = 0;
  importedResourceCount = 0;

  inspect(): RenderGraphResourceAllocationInspection {
    if (this.inspection !== undefined) return this.inspection;
    this.inspection = Object.freeze({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: this.phase === 'live' ? this.heldBytes : 0,
      pendingRetirementBytes: this.phase === 'pending-retirement' ? this.heldBytes : 0,
      peakBytes: this.peakBytes,
      successfulAllocationCount: this.successfulAllocationCount,
      successfulAllocationBytes: this.successfulAllocationBytes,
      pendingRetirementCount: this.phase === 'pending-retirement' ? this.allocations.size : 0,
      retiredBytes: this.retiredBytes,
      failedAllocationRollbacks: 0,
      failedAllocationRollbackBytes: 0,
      unknownByteSizeCount: this.unknownByteSizeCount,
      importedResourceCount: this.importedResourceCount,
    });
    return this.inspection;
  }

  state(handle: object | undefined): AllocationState | 'released' {
    return handle !== undefined && this.allocations.has(handle) ? this.phase : 'released';
  }

  visit(consume: AllocationVisitor): void {
    for (const [handle, bytes] of this.allocations) {
      if (bytes !== null) consume(physicalAllocationKey(handle), bytes, this.phase);
    }
  }

  retireAll(): void {
    if (this.phase === 'pending-retirement') return;
    this.phase = 'pending-retirement';
    this.inspection = undefined;
  }

  release(handle: object | undefined): void {
    if (handle === undefined) return;
    const bytes = this.allocations.get(handle);
    if (bytes === undefined) return;
    this.inspection = undefined;
    this.allocations.delete(handle);
    if (bytes === null) this.unknownByteSizeCount -= 1;
    else {
      this.heldBytes -= bytes;
      this.retiredBytes += bytes;
    }
  }

  allocate(handle: object, bytes: number | undefined, newlyAllocated: boolean): void {
    if (this.allocations.has(handle)) return;
    this.allocations.set(handle, bytes ?? null);
    if (newlyAllocated) this.successfulAllocationCount += 1;
    if (bytes === undefined) this.unknownByteSizeCount += 1;
    else {
      this.heldBytes += bytes;
      if (newlyAllocated) this.successfulAllocationBytes += bytes;
    }
    this.peakBytes = this.heldBytes;
  }
}

function resolutionError(label: string, cause?: unknown): RenderGraphError {
  return new RenderGraphError(
    {
      code: 'resource-resolution-failed',
      expected: `resource '${label}' resolves to a live RHI handle for this frame`,
      hint: `repair the imported owner for '${label}' before executing the graph`,
      detail: {
        resourceLabel: label,
        ...(cause === undefined ? {} : { accesses: [String(cause)] }),
      },
    },
    cause === undefined ? undefined : { cause },
  );
}

function validPhysicalDimension(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0;
}

function bufferSize<FrameCtx>(
  resource: CompiledResource<FrameCtx> | undefined,
): number | undefined {
  return resource?.record.kind === 'buffer' ? resource.record.descriptor.size : undefined;
}

function sameViewFormats(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  const count = a?.length ?? 0;
  if (count !== (b?.length ?? 0)) return false;
  for (let i = 0; i < count; i++) if (a?.[i] !== b?.[i]) return false;
  return true;
}

function sameTexture<FrameCtx>(
  left: CompiledResource<FrameCtx> | undefined,
  right: CompiledResource<FrameCtx> | undefined,
): boolean {
  const a = left?.resolvedDescriptor ?? left?.textureDescriptor,
    b = right?.resolvedDescriptor ?? right?.textureDescriptor;
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
    sameViewFormats(a.viewFormats, b.viewFormats)
  );
}

function sameView<FrameCtx extends RenderGraphFrame>(
  left: CompiledView<FrameCtx> | undefined,
  right: CompiledView<FrameCtx> | undefined,
  texture: CompiledResource<FrameCtx> | undefined,
): boolean {
  const allocation = texture?.resolvedDescriptor ?? texture?.textureDescriptor;
  if (left === undefined || right === undefined || allocation === undefined) return false;
  const a = left.record.descriptor;
  const b = right.record.descriptor;
  const mip = a.baseMipLevel ?? 0;
  const layer = a.baseArrayLayer ?? 0;
  const layers = allocation.size.depthOrArrayLayers;
  const dimension = allocation.dimension === '3d' ? '3d' : layers > 1 ? '2d-array' : '2d';
  const mipCount = (allocation.mipLevelCount ?? 1) - mip;
  return (
    mip === (b.baseMipLevel ?? 0) &&
    layer === (b.baseArrayLayer ?? 0) &&
    (a.format ?? allocation.format) === (b.format ?? allocation.format) &&
    (a.dimension ?? dimension) === (b.dimension ?? dimension) &&
    (a.aspect ?? 'all') === (b.aspect ?? 'all') &&
    (a.mipLevelCount ?? mipCount) === (b.mipLevelCount ?? mipCount) &&
    (a.arrayLayerCount ?? layers - layer) === (b.arrayLayerCount ?? layers - layer)
  );
}

export class CompiledRenderGraphImpl<FrameCtx extends RenderGraphFrame>
  implements CompiledRenderGraph<FrameCtx>
{
  private retired = false;
  private nativeRecorder: NativeCommandRecorder<FrameCtx> | undefined;
  private subgraphBindings: SubgraphBindings | undefined;
  private resolving = false;
  private retireResult: Promise<Result<void, RenderGraphError>> | undefined;
  private readonly allocationLedger = new RenderGraphAllocationLedger();
  private inspection: CompiledRenderGraphInfo | undefined;
  private declarations: CompiledRenderGraphInfo['passes'] | undefined;
  private importsResolved = false;
  private readonly acceptsParentPorts: boolean;
  // Frame-resource tables and per-pass resolvers are retained across frames:
  // every execution refills the same tables, so steady frames allocate neither.
  private readonly frameResources: FrameResources = {
    buffers: new FrameBindings<Buffer>(),
    textures: new FrameBindings<Texture>(),
    views: new FrameBindings<TextureView>(),
    accelerationStructures: new FrameBindings<Tlas>(),
  };
  private readonly resolvers: (
    | {
        readonly resolver: GraphResourceResolver;
        raster?: Writable<RenderPassDescriptor>;
        compute?: ComputePassDescriptor;
      }
    | undefined
  )[] = [];
  private readonly importedViews: (
    | { texture: Texture; view: ResultOk<TextureView> }
    | undefined
  )[] = [];
  /** The compiler owns fixed membership; mutable resolution values stay with their records. */
  private readonly imports: Extract<ResourceRecord<FrameCtx>, { origin: 'imported' }>[] = [];
  private readonly frameViews: CompiledView<FrameCtx>[] = [];
  private readonly nativeInputs: {
    record: Extract<ResourceRecord<FrameCtx>, { origin: 'imported'; kind: 'texture' }>;
    views: CompiledView<FrameCtx>[];
    prepared?: Texture;
  }[] = [];
  private readonly allocationsByTexture = new Map<Texture, GraphTextureAllocation>();
  private readonly firstViewByResource: (CompiledView<FrameCtx> | undefined)[] = [];
  private readonly viewExtents: (
    | ReturnType<GraphResourceResolver['textureViewExtent']>
    | CompiledResource<FrameCtx>
    | undefined
  )[] = [];
  private pendingTextureWrites = new TextureWriteJournal(this.allocationsByTexture);
  private executingTextureWrites = new TextureWriteJournal(this.allocationsByTexture);

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly physical: PhysicalGraphSlots<FrameCtx>,
    private readonly bindings: AttachmentBindings,
    private readonly slotsByLabel: ReadonlyMap<string, number>,
    private readonly accessIds: Uint32Array,
    private readonly passes: readonly CompiledPass<FrameCtx>[],
    private readonly preparationPasses: readonly CompiledPass<FrameCtx>[],
    hasSubgraph: boolean,
    private readonly requiredTextureReads: readonly {
      readonly resourceId: number;
      readonly range: GraphTextureContentRange;
      readonly passName: string;
      readonly usage: GraphAccessUsage;
    }[],
    private readonly rasterBatches: readonly (RasterBatch<FrameCtx> | undefined)[],
  ) {
    compiledGraphs.add(this);

    let importOnly = true;
    for (const compiled of physical.resources()) {
      if (
        compiled.record.origin !== 'imported' ||
        compiled.record.kind === 'acceleration-structure' ||
        (compiled.record.kind === 'texture' && !isResolved(compiled))
      )
        importOnly = false;
      if (!isResolved(compiled)) continue;
      const handle = compiled.texture ?? compiled.buffer;
      if (
        compiled.textureAllocation !== undefined &&
        compiled.record.kind === 'texture' &&
        compiled.record.descriptor.lifetime === 'persistent'
      )
        this.allocationsByTexture.set(
          compiled.textureAllocation.texture,
          compiled.textureAllocation,
        );
      if (compiled.record.origin === 'imported') {
        this.imports.push(compiled.record);
        if (compiled.record.kind === 'texture' && compiled.record.native !== undefined)
          this.nativeInputs.push({ record: compiled.record, views: [] });
        this.allocationLedger.importedResourceCount++;
        continue;
      }
      if (handle === undefined) continue;
      if (compiled.texture !== undefined)
        this.frameResources.textures.bind(compiled.record.id, compiled.texture);
      if (compiled.buffer !== undefined)
        this.frameResources.buffers.bind(compiled.record.id, compiled.buffer);
      if (compiled.borrowedTextureSlot) continue;
      this.allocationLedger.allocate(
        handle,
        allocationBytes(compiled),
        compiled.textureAllocation === undefined || compiled.textureAllocation.references === 1,
      );
    }
    this.acceptsParentPorts = importOnly && !hasSubgraph;
    const nativeViews: (CompiledView<FrameCtx>[] | undefined)[] = [];
    for (const input of this.nativeInputs) nativeViews[input.record.id] = input.views;
    for (const view of physical.views()) {
      const resource = physical.resource(view.record.textureId);
      this.firstViewByResource[view.record.textureId] ??= view;
      if (resource?.usage === 0) continue;
      const size = resource?.textureDescriptor?.size;
      if (
        resource?.record.kind === 'texture' &&
        resource.record.origin === 'imported' &&
        resource.record.native?.resolvedExtent !== undefined
      )
        this.viewExtents[view.record.id] = resource;
      else if (size !== undefined) {
        const mip = view.record.descriptor.baseMipLevel ?? 0;
        this.viewExtents[view.record.id] = ok(
          Object.freeze({
            width: mipDimension(size.width, mip),
            height: mipDimension(size.height, mip),
          }),
        );
      }
      if (view.view !== undefined) this.frameResources.views.bind(view.record.id, view.view);
      else this.frameViews.push(view);
      if (view.record.resolve === undefined) nativeViews[view.record.textureId]?.push(view);
    }
  }

  inspectAllocation(visit?: AllocationVisitor): RenderGraphResourceAllocationInspection {
    if (visit !== undefined) this.allocationLedger.visit(visit);
    return this.allocationLedger.inspect();
  }

  declaresPass(name: string): boolean {
    for (const pass of this.passes) if (pass.name === name) return true;
    return false;
  }

  /** Read the bound declarations of one feature, independent of frame import identities. */
  resourceDeclarations(labels: string | readonly string[]): CompiledRenderGraphInfo['resources'] {
    const resources: CompiledRenderGraphInfo['resources'][number][] = [];
    if (typeof labels === 'string') {
      for (const compiled of this.physical.resources()) {
        if (compiled.record.label.startsWith(labels)) resources.push(inspectResource(compiled));
      }
    } else {
      for (const label of labels) {
        const slot = this.slotsByLabel.get(label);
        const compiled = slot === undefined ? undefined : this.physical.resource(slot);
        if (compiled !== undefined) resources.push(inspectResource(compiled));
      }
    }
    return resources;
  }

  inspect(): CompiledRenderGraphInfo {
    const allocation = this.allocationLedger.inspect();
    if (this.inspection?.resourceAllocation === allocation) return this.inspection;
    const resources = Array.from(this.physical.resources(), (compiled) => {
      const resource = inspectResource(compiled);
      if (this.importsResolved && resource.origin === 'imported') {
        const handle =
          this.frameResources.textures.values[compiled.record.id] ??
          this.frameResources.buffers.values[compiled.record.id];
        if (handle !== undefined)
          return Object.freeze({
            ...resource,
            physicalAllocationKey: physicalAllocationKey(handle),
          });
      }
      if (resource.origin !== 'created' || resource.physicalAllocationKey === undefined)
        return resource;
      return Object.freeze({
        ...resource,
        allocationState: this.allocationLedger.state(compiled.texture ?? compiled.buffer),
      });
    });
    this.inspection = Object.freeze({
      generation: this.generation,
      passes: this.passDeclarations(),
      resources: Object.freeze(resources),
      resourceAllocation: allocation,
    });
    return this.inspection;
  }

  appendPassNames(output: string[], frame?: FrameCtx): void {
    for (const pass of this.passes) {
      const domain = pass.pass.kind === 'subgraph' ? pass.pass.descriptor : undefined;
      if (
        frame !== undefined &&
        domain?.child === undefined &&
        domain?.appendPassNames !== undefined
      ) {
        const start = output.length;
        try {
          domain.appendPassNames(frame, output);
        } catch {
          // A failed diagnostic projection must not interrupt frame recording.
          output.length = start;
          output.push(pass.name);
        }
      } else output.push(pass.name);
    }
  }

  /** The immutable declaration facts captured at compile time, without allocation inspection. */
  passDeclarations(): CompiledRenderGraphInfo['passes'] {
    this.declarations ??= inspectPasses(this.passes, this.physical, this.rasterBatches);
    return this.declarations;
  }

  /** The immutable compiled generation, without materializing allocation inspection. */
  compiledGeneration(): number {
    return this.generation;
  }

  isRetired(): boolean {
    return this.retired;
  }

  preparedResourcesCurrent(): boolean {
    if (this.retired || !this.nativeImportsCurrent()) return false;
    for (const pass of this.preparationPasses) {
      if (pass.pass.descriptor.preparedResourcesCurrent?.() === false || this.retired) return false;
    }
    return !this.retired;
  }

  prepareResources(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    let closed = false;
    let advancing = false;
    let finished = false;
    let closingValue: Result<void, RenderGraphError> | undefined;
    const work = this.prepareResourceSteps(() => !closed && current() && !closed);
    const next = work.next.bind(work);
    const finish = work.return.bind(work);
    const close = (value: Result<void, RenderGraphError>) => {
      closed = true;
      closingValue = value;
      if (!advancing && !finished) {
        finished = true;
        finish(value);
      }
      return { done: true as const, value };
    };
    return Object.freeze(
      Object.assign(work, {
        return: close,
        throw: (cause?: unknown) => {
          close(err(this.preparationInvalid()));
          throw cause;
        },
        next: (value?: unknown) => {
          if (closed || this.resolving || executingGraphs.has(this))
            return close(err(this.preparationInvalid()));
          // Admission covers one synchronous resume, never an ordinary frame between yields.
          this.resolving = true;
          advancing = true;
          try {
            const result = next(value);
            if (result.done) {
              closed = true;
              finished = true;
            }
            return closed && !result.done && closingValue !== undefined
              ? { done: true as const, value: closingValue }
              : result;
          } finally {
            advancing = false;
            this.resolving = false;
            if (closed && !finished && closingValue !== undefined) close(closingValue);
          }
        },
      }),
    );
  }

  private preparationInvalid(): RenderGraphError {
    return new RenderGraphError({
      code: 'graph-preparation-invalid',
      expected: 'the original idle live graph and current native preparation inputs',
      hint: 'reprepare from the original owners outside encoding and import resolution',
      detail: { generation: this.generation },
    });
  }

  private *prepareResourceSteps(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    const live = () => !this.retired && current() && !this.retired;
    const imports = yield* this.prepareNativeImports(live);
    if (!imports.ok) return imports;
    for (const pass of this.preparationPasses) {
      try {
        if (!live()) return err(this.preparationInvalid());
        const prepare = pass.pass.descriptor.prepareResources;
        if (prepare === undefined) continue;
        const resources = Object.freeze({
          createdTextureView: (resource: GraphTextureView): TextureView | undefined => {
            if (this.retired) return undefined;
            const data = handleData(resource);
            if (data?.kind !== 'texture-view' || !this.grants(pass, data.id)) return undefined;
            return this.createdTextureView(resource);
          },
        });
        const recipe = prepare(resources, live);
        let step = recipe.next();
        try {
          while (!step.done) {
            const value = yield step.value;
            // An ordinary frame may replace the View while its native recipe is suspended.
            if (!live()) return err(this.preparationInvalid());
            step = recipe.next(value);
          }
        } finally {
          if (!step.done) recipe.return(undefined);
        }
        if (!live()) return err(this.preparationInvalid());
      } catch (cause) {
        return err(
          new RenderGraphError({
            code: 'pass-preparation-failed',
            expected: `pass '${pass.name}' prepares native resources without encoding`,
            hint: 'inspect the original native owner failure in detail.cause',
            detail: { passName: pass.name, passKind: pass.pass.kind, cause },
          }),
        );
      }
    }
    return live() ? ok(undefined) : err(this.preparationInvalid());
  }

  /** Fixed native ownership only: this never resolves a frame, allocates or grants execution. */
  createdTextureView(resource: GraphTextureView): TextureView | undefined {
    const data = handleData(resource);
    if (this.retired || data?.owner !== this.owner || data.kind !== 'texture-view')
      return undefined;
    const texture = this.physical.resource(data.textureId);
    const view = this.physical.view(data.id);
    return texture?.record.kind === 'texture' &&
      texture.record.origin === 'created' &&
      view?.record.resolve === undefined
      ? view?.view
      : undefined;
  }

  /** @internal Detach physical inputs from pass callbacks, ordinals and inspection. */
  _attachmentBindings(device: RhiDevice): AttachmentBindings | undefined {
    return this.retired || device !== this.device ? undefined : this.bindings;
  }

  commitExecution(): void {
    if (this.retired) {
      this.pendingTextureWrites.clear();
      return;
    }
    const { textures, writes } = this.pendingTextureWrites;
    for (let index = 0; index < writes.length; index++) {
      const allocation = this.allocationsByTexture.get(textures[index] as Texture);
      if (allocation === undefined) continue;
      const write = writes[index] as StagedTextureWrite;
      const committed = allocation.committedContentRanges;
      applyTextureContentWrite(committed, write.range, write.stored);
    }
    this.pendingTextureWrites.clear();
  }

  discardExecution(): void {
    this.pendingTextureWrites.clear();
  }

  getColorTargetView(name: string): TextureView | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined || this.physical.resource(slot)?.passLocal) return undefined;
    const view = this.firstViewByResource[slot];
    return view === undefined
      ? undefined
      : (view.view ?? this.frameResources.views.values[view.record.id]);
  }

  getColorTargetTexture(name: string): Texture | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined) return undefined;
    const resource = this.physical.resource(slot);
    if (resource?.record.kind !== 'texture' || resource.passLocal) return undefined;
    return resource.texture ?? this.frameResources.textures.values[slot];
  }

  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined) return undefined;
    const resource = this.physical.resource(slot);
    if (resource?.record.kind !== 'texture' || resource.passLocal) return undefined;
    if (resource.colorTarget !== undefined) return resource.colorTarget;
    const descriptor = resource.resolvedDescriptor ?? resource.textureDescriptor;
    if (descriptor === undefined) return undefined;
    const { width, height } = descriptor.size;
    if (resource.texture !== undefined) {
      resource.colorTarget = {
        texture: resource.texture,
        format: resource.record.descriptor.format,
        size: { width, height },
        usage: resource.usage,
        sample: resource.record.descriptor.sampleCount ?? 1,
      };
      return resource.colorTarget;
    }
    const texture = this.frameResources.textures.values[slot];
    if (texture === undefined) return undefined;
    return {
      texture,
      format: resource.record.descriptor.format,
      size: { width, height, depthOrArrayLayers: descriptor.size.depthOrArrayLayers ?? 1 },
      usage: descriptor.usage ?? resource.usage,
      sample: descriptor.sampleCount ?? 1,
    };
  }

  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    pendingPasses?: Set<string>,
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
      const resource = this.physical.resource(read.resourceId);
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
    const writes = this.executingTextureWrites;
    const names = frame.nativePassNames;
    const start = names?.length ?? 0;
    let completed = false;
    try {
      const executed = this.#executeResolved(
        frame,
        resolved.value,
        runPass,
        instrumentation,
        { next: 0, pendingPasses },
        writes,
      );
      if (
        executed.ok &&
        writes.writes.length !== 0 &&
        this.pendingTextureWrites.writes.length === 0
      ) {
        this.executingTextureWrites = this.pendingTextureWrites;
        this.pendingTextureWrites = writes;
      } else if (executed.ok) {
        for (let i = 0; i < writes.writes.length; i++) {
          this.pendingTextureWrites.add(
            writes.textures[i] as Texture,
            writes.writes[i] as StagedTextureWrite,
          );
        }
      }
      completed = executed.ok;
      return executed;
    } finally {
      if (!completed && names !== undefined) names.length = start;
      this.executingTextureWrites.clear();
    }
  }

  #stagePassTextureWrites(
    pass: CompiledPass<FrameCtx>,
    resolved: FrameResources,
    writes: TextureWriteJournal,
  ): void {
    if (pass.pass.kind === 'subgraph') return;
    for (const write of pass.textureWrites) {
      const texture = resolved.textures.values[write.resourceId];
      if (texture === undefined) continue;
      writes.add(texture, write);
    }
  }

  #executeResolved(
    frame: FrameCtx,
    resolved: FrameResources,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    indices: ExecutionCursor = { next: 0 },
    writes = this.executingTextureWrites,
  ): Result<void, RenderGraphError> {
    if (this.retired || executingGraphs.has(this))
      return this.subgraphError('execution', 'a live, non-recursive compiled graph');
    executingGraphs.add(this);
    try {
      for (let passIndex = 0; passIndex < this.passes.length; passIndex++) {
        const batch = this.rasterBatches[passIndex];
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
          const execution =
            runPass === undefined && instrumentation === undefined
              ? undefined
              : passExecutionRecord(pass, executionIndex, resolved, this.accessIds);
          if (runPass !== undefined && execution !== undefined) {
            const observed = this.#observePass(
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
            if (!observed.ok) return observed;
          } else {
            const encoded = this.#encodePass(
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
            if (!encoded.ok) return encoded;
            indices.pendingPasses?.delete(pass.name);
            this.#stagePassTextureWrites(pass, resolved, writes);
          }
        } catch (cause) {
          // A native child names the physical command that failed and carries the original RHI cause.
          if (
            pass.pass.kind === 'subgraph' &&
            cause instanceof RenderGraphError &&
            cause.code === 'pass-encode-failed'
          )
            return err(cause);
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
    indices: ExecutionCursor,
    writes: TextureWriteJournal,
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
    let outcome: Result<void, RenderGraphError> = ok(undefined);
    // One invocation frame owns a native pass. The current logical stage advances in order;
    // an observer may enter or omit each stage synchronously using the same callback.
    let i = first;
    const encode = () => {
      if (active.pass.kind !== 'raster')
        throw new Error('compiled raster batch contains non-raster work');
      const descriptor = active.pass.descriptor;
      const resolver = this.passResolver(active, resolved);
      if (encoder === undefined) {
        const physical = {
          name,
          kind: 'raster' as const,
          executionIndex,
          logicalPassNames: names,
        };
        scope = safePassScope(instrumentation, physical, frame);
        const context = this.resolvers[active.id];
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
          resolved,
          this.accessIds,
          final.accessEnd + 1,
          retained?.colorAttachments,
        );
        if (colors instanceof RenderGraphError) throw colors;
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
          frame,
          resolved.views.values[this.accessIds[active.accessEnd] as number],
          retained?.depthStencilAttachment,
        );
        if (depth instanceof RenderGraphError) throw depth;
        const native: Writable<RenderPassDescriptor> = retained ?? {
          label: name,
          colorAttachments: colors,
        };
        native.label = name;
        if (depth === undefined) delete native.depthStencilAttachment;
        else native.depthStencilAttachment = depth;
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
      encoder.setBlendConstant(DEFAULT_BLEND_CONSTANT);
      encoder.setStencilReference(0);
      encoder.pushDebugGroup(active.name);
      try {
        if (descriptor.encodeDirect !== undefined)
          descriptor.encodeDirect(encoder, frame, resolver);
        else descriptor.encode({ pass: encoder, frame, resources: resolver });
      } finally {
        encoder.popDebugGroup();
      }
      frame.nativePassNames?.push(active.name);
      indices.pendingPasses?.delete(active.name);
    };
    try {
      for (; i <= last; i++) {
        active = this.passes[i] as CompiledPass<FrameCtx>;
        const logicalIndex = indices.next++;
        if (runPass === undefined) encode();
        else {
          const execution = passExecutionRecord(active, logicalIndex, resolved, this.accessIds);
          runPass(execution, encode);
        }
      }
      // The native attachment lifetime ends once, with the final descriptor's
      // store/resolve semantics, even when a diagnostic omits a logical body.
      if (encoder !== undefined) this.#stagePassTextureWrites(final, resolved, writes);
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
    indices: ExecutionCursor,
    writes: TextureWriteJournal,
  ): Result<void, RenderGraphError> {
    let encodeResult: Result<void, RenderGraphError> = ok(undefined);
    let encoded = false;
    runPass(execution, () => {
      encoded = true;
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
    if (encoded && encodeResult.ok) {
      indices.pendingPasses?.delete(pass.name);
      this.#stagePassTextureWrites(pass, resolved, writes);
    }
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
    indices: ExecutionCursor,
    writes: TextureWriteJournal,
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
          const descriptor = pass.pass.descriptor;
          // Native beginRenderPass consumes its descriptor synchronously. Reuse
          // this graph's private recording storage; instrumented calls retain
          // their independent descriptors for observer ownership.
          const context = this.resolvers[pass.id];
          const retained = scope === undefined ? context?.raster : undefined;
          const colorAttachments = resolveRasterColors(
            descriptor.colorAttachments,
            frame,
            resolved,
            this.accessIds,
            pass.accessEnd + 1,
            retained?.colorAttachments,
          );
          if (colorAttachments instanceof RenderGraphError) return err(colorAttachments);
          const depthStencilAttachment = resolveRasterDepth(
            descriptor.depthStencilAttachment,
            frame,
            resolved.views.values[this.accessIds[pass.accessEnd] as number],
            retained?.depthStencilAttachment,
          );
          if (depthStencilAttachment instanceof RenderGraphError)
            return err(depthStencilAttachment);
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
    frame.nativePassNames?.push(pass.name);
    return ok(undefined);
  }

  private computePassDescriptor(
    pass: CompiledPass<FrameCtx>,
    begin: ComputePassDescriptor | undefined,
    observed: boolean,
  ): ComputePassDescriptor {
    if (observed || begin !== undefined) return { ...begin, label: pass.name };
    const context = this.resolvers[pass.id];
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
    indices: ExecutionCursor,
    writes: TextureWriteJournal,
  ): Result<void, RenderGraphError> {
    if (pass.pass.kind !== 'subgraph') return this.subgraphError('kind', 'a subgraph pass');
    const descriptor = pass.pass.descriptor;
    if (descriptor.child === undefined) {
      this.nativeRecorder ??= new NativeCommandRecorder(() => this.retired);
      this.nativeRecorder.run(descriptor, frame, resolver, indices, instrumentation, runPass);
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
    if (!child.acceptsParentPorts)
      return this.subgraphError('resources', 'an import-only child without nested subgraphs');
    const snapshot = child.resolveFrameResources(frame);
    if (!snapshot.ok) return snapshot;
    const childResources = snapshot.value;
    const ports = descriptor.accesses;
    let grants: ReadonlyMap<number, number> | undefined;
    if (ports.length > LINEAR_PASS_ACCESS_LIMIT) {
      this.subgraphBindings ??= new SubgraphBindings(
        this.physical.addressCount,
        parent.buffers.values,
        parent.views.values,
      );
      grants = this.subgraphBindings.grantsFor(ports);
    }
    const failure = this.checkSubgraphPorts(ports, grants, parent, child, childResources);
    if (failure !== undefined) return failure;
    // Import callbacks can retire a graph; validation and encoding use this one snapshot.
    if (this.retired || child.retired)
      return this.subgraphError('child', 'parent and child remain live after import resolution');
    return child.#executeResolved(frame, childResources, runPass, instrumentation, indices, writes);
  }

  private checkSubgraphPorts(
    ports: readonly GraphAccess[],
    grants: ReadonlyMap<number, number> | undefined,
    parent: FrameResources,
    child: CompiledRenderGraphImpl<FrameCtx>,
    childResources: FrameResources,
  ): Result<never, RenderGraphError> | undefined {
    let parentBuffers: Set<Buffer> | undefined;
    for (const pass of child.passes) {
      for (const access of pass.pass.descriptor.accesses) {
        const data = handleData(access.resource);
        if (data === undefined) return this.subgraphError('access', 'a compiled child access');
        if (data.kind !== 'buffer' && data.kind !== 'texture-view')
          return this.subgraphError('access', 'only buffer and texture-view child accesses');
        const buffer = data.kind === 'buffer' ? childResources.buffers.values[data.id] : undefined;
        if (data.kind === 'buffer' && buffer === undefined) continue;
        const handle = data.kind === 'buffer' ? buffer : childResources.views.values[data.id];
        const bindings = this.subgraphBindings;
        if (this.grantsChildPort(ports, grants, handle, data, access.usage, child)) continue;
        if (buffer === undefined)
          return this.subgraphError(
            'texture-port',
            'every child texture access uses the exact parent texture, view, extent and usage',
          );
        // Buffers outside the parent's actual resources are private to the child.
        if (bindings !== undefined) {
          if (bindings.first('buffer', buffer) === 0) continue;
        } else {
          if (parentBuffers === undefined) {
            parentBuffers = new Set();
            for (const slot of parent.buffers.values)
              if (slot !== undefined) parentBuffers.add(slot);
          }
          if (!parentBuffers.has(buffer)) continue;
        }
        return this.subgraphError(
          'buffer-port',
          'every shared child buffer access is declared by the parent',
        );
      }
    }
    return undefined;
  }

  private grantsChildPort(
    ports: readonly GraphAccess[],
    grants: ReadonlyMap<number, number> | undefined,
    handle: object | undefined,
    data: Extract<ResourceHandleData, { kind: 'buffer' | 'texture-view' }>,
    usage: GraphAccess['usage'],
    child: CompiledRenderGraphImpl<FrameCtx>,
  ): boolean {
    const bindings = this.subgraphBindings;
    if (grants !== undefined && handle !== undefined && bindings !== undefined) {
      for (let id = bindings.first(data.kind, handle); id !== 0; id = bindings.next[id] as number)
        if (
          SubgraphBindings.allows(grants.get(id), usage) &&
          this.sameSubgraphBinding(id, data, child)
        )
          return true;
      return false;
    }
    for (const port of ports) {
      const source = handleData(port.resource);
      if (
        source?.kind === data.kind &&
        coversUsage(port.usage, usage) &&
        this.sameSubgraphBinding(source.id, data, child)
      )
        return true;
    }
    return false;
  }

  private sameSubgraphBinding(
    id: number,
    data: Extract<ResourceHandleData, { kind: 'buffer' | 'texture-view' }>,
    child: CompiledRenderGraphImpl<FrameCtx>,
  ): boolean {
    if (data.kind === 'buffer')
      return (
        this.frameResources.buffers.values[id] === child.frameResources.buffers.values[data.id] &&
        bufferSize(this.physical.resource(id)) === bufferSize(child.physical.resource(data.id))
      );
    const view = this.physical.view(id);
    if (view === undefined) return false;
    const textureId = view.record.textureId;
    const texture = this.physical.resource(textureId);
    return (
      this.frameResources.views.values[id] === child.frameResources.views.values[data.id] &&
      this.frameResources.textures.values[textureId] ===
        child.frameResources.textures.values[data.textureId] &&
      sameTexture(texture, child.physical.resource(data.textureId)) &&
      sameView(view, child.physical.view(data.id), texture)
    );
  }

  retire(): Promise<Result<void, RenderGraphError>> {
    if (this.retireResult !== undefined) return this.retireResult;
    this.retired = true;
    this.bindings.revoke();
    this.subgraphBindings = undefined;
    this.pendingTextureWrites.clear();
    this.allocationsByTexture.clear();
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
    for (const compiled of this.physical.resources()) {
      if (compiled.record.origin === 'imported' || compiled.borrowedTextureSlot) continue;
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
    const { buffers, textures, views, accelerationStructures } = frameResources;
    let resolved = false;
    try {
      for (const record of this.imports) {
        try {
          if (record.kind === 'texture') {
            const texture = record.resolve(frame);
            if (texture === undefined) return err(resolutionError(record.label));
            if (textures.values[record.id] !== texture) {
              const extent = record.native?.resolvedExtent?.(texture);
              if (extent !== undefined) {
                const resource = this.physical.resource(record.id);
                const { width, height, depthOrArrayLayers } = extent;
                if (
                  resource?.textureDescriptor === undefined ||
                  !validPhysicalDimension(width) ||
                  !validPhysicalDimension(height) ||
                  !validPhysicalDimension(depthOrArrayLayers)
                )
                  return err(resolutionError(record.label, 'invalid physical texture extent'));
                const size = Object.freeze({ width, height, depthOrArrayLayers });
                resource.resolvedDescriptor = { ...resource.textureDescriptor, size };
                resource.resolvedViewExtent = ok(Object.freeze({ width, height }));
              }
              textures.bind(record.id, texture);
              this.inspection = undefined;
            }
          } else if (record.kind === 'buffer') {
            const buffer = record.resolve(frame);
            if (buffer === undefined) return err(resolutionError(record.label));
            const previous = buffers.values[record.id];
            if (buffers.bind(record.id, buffer)) {
              this.subgraphBindings?.replace('buffer', record.id, previous, buffer);
              this.inspection = undefined;
            }
          } else accelerationStructures.bind(record.id, record.resolve(frame));
        } catch (cause) {
          return err(resolutionError(record.label, cause));
        }
      }
      for (const compiled of this.frameViews) {
        const record = compiled.record;
        if (record.resolve !== undefined) {
          try {
            const value = record.resolve(frame);
            const previous = views.values[record.id];
            if (views.bind(record.id, value))
              this.subgraphBindings?.replace('texture-view', record.id, previous, value);
          } catch (cause) {
            return err(resolutionError(record.label, cause));
          }
        } else {
          const texture = textures.values[record.textureId];
          if (texture === undefined) return err(resolutionError(record.label));
          const view = this.importedTextureView(compiled, texture);
          if (!view.ok) return view;
          this.subgraphBindings?.replace(
            'texture-view',
            record.id,
            views.values[record.id],
            view.value,
          );
          views.bind(record.id, view.value, view);
        }
      }
      resolved = true;
      return ok(frameResources);
    } finally {
      if (this.importsResolved !== resolved) this.inspection = undefined;
      this.importsResolved = resolved;
    }
  }

  private importedTextureView(
    compiled: CompiledView<FrameCtx>,
    texture: Texture,
    current?: () => boolean,
  ): Result<TextureView, RenderGraphError> {
    if (current?.() === false) return err(this.preparationInvalid());
    const previous = this.importedViews[compiled.record.id];
    if (previous?.texture === texture) return previous.view;
    const created = this.device.createTextureView(texture, compiled.record.descriptor);
    if (!created.ok) return err(resolutionError(compiled.record.label, created.error));
    if (current?.() === false || this.retired) return err(this.preparationInvalid());
    if (previous === undefined) this.importedViews[compiled.record.id] = { texture, view: created };
    else {
      previous.texture = texture;
      previous.view = created;
    }
    return created;
  }

  private *prepareNativeImports(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    for (const input of this.nativeInputs) {
      const { record, views } = input;
      const owner = record.native;
      if (owner === undefined) continue;
      try {
        if (!current()) return err(this.preparationInvalid());
        const texture = yield* owner.prepare(current);
        const live = () => current() && owner.current() === texture && !this.retired;
        if (!live()) return err(this.preparationInvalid());
        for (const view of views) {
          const prepared = this.importedTextureView(view, texture, live);
          if (!prepared.ok) return prepared;
          yield;
          if (!live()) return err(this.preparationInvalid());
        }
        input.prepared = texture;
      } catch (cause) {
        if (cause instanceof RhiError && cause.code === 'rhi-descriptor-invalid' && !current())
          return err(this.preparationInvalid());
        return err(resolutionError(record.label, cause));
      }
    }
    return ok(undefined);
  }

  private nativeImportsCurrent(): boolean {
    if (this.retired) return false;
    for (const input of this.nativeInputs) {
      const { record, views } = input;
      const actual = record.native?.current();
      if (actual === undefined || input.prepared !== actual || this.retired) return false;
      for (const view of views)
        if (this.importedViews[view.record.id]?.texture !== actual) return false;
    }
    return !this.retired;
  }

  private passResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    let context = this.resolvers[pass.id];
    if (context === undefined) {
      context = { resolver: this.createPassResolver(pass, frameResources) };
      this.resolvers[pass.id] = context;
    }
    return context.resolver;
  }

  /** Resource and view IDs occupy the same builder namespace. A declared view grants its parent. */
  private grants(pass: CompiledPass<FrameCtx>, id: number): boolean {
    let lo = pass.accessStart;
    let hi = pass.accessEnd;
    if (hi - lo <= LINEAR_PASS_ACCESS_LIMIT) {
      for (; lo < hi; lo++) if (this.accessIds[lo] === id) return true;
      return false;
    }
    while (lo < hi) {
      const middle = lo + Math.floor((hi - lo) / 2);
      const value = this.accessIds[middle] as number;
      if (value === id) return true;
      if (value < id) lo = middle + 1;
      else hi = middle;
    }
    return false;
  }

  private createPassResolver(
    pass: CompiledPass<FrameCtx>,
    frameResources: FrameResources,
  ): GraphResourceResolver {
    const lookup = (
      resource: GraphBuffer | GraphTexture | GraphTextureView | GraphAccelerationStructure,
      expectedKind: ResourceHandleData['kind'],
    ): ResourceHandleData | ResultErr<RenderGraphError> => {
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
      if (this.grants(pass, data.id)) return data;
      if (data.kind !== 'texture-view' || !this.grants(pass, data.textureId)) {
        const label = this.physical.resource(resourceId ?? -1)?.record.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only resources present in its accesses`,
            hint: 'add the resource access to this pass before resolving it',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      const label = this.physical.view(data.id)?.record.label;
      return err(
        new RenderGraphError({
          code: 'resource-not-declared-by-pass',
          expected: `pass '${pass.name}' resolves only texture views present in its accesses`,
          hint: 'add this exact texture view to the pass accesses',
          detail: { passName: pass.name, resourceLabel: label },
        }),
      );
    };

    return {
      buffer: (resource) => {
        const data = lookup(resource, 'buffer');
        if ('error' in data) return data;
        const buffer = frameResources.buffers.result(data.id);
        return buffer === undefined
          ? err(resolutionError(this.physical.resource(data.id)?.record.label ?? 'buffer'))
          : buffer;
      },
      bufferSource: (resource) => {
        const data = lookup(resource, 'buffer');
        if ('error' in data) return data;
        const compiled = this.physical.resource(data.id);
        const buffer = frameResources.buffers.values[data.id];
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
        if ('error' in data) return data;
        const texture = frameResources.textures.result(data.id);
        return texture === undefined
          ? err(resolutionError(this.physical.resource(data.id)?.record.label ?? 'texture'))
          : texture;
      },
      textureViewSource: (resource) => {
        const data = lookup(resource, 'texture-view');
        if ('error' in data) return data;
        if (data.kind !== 'texture-view') return err(resolutionError('texture view source'));
        const compiledTexture = this.physical.resource(data.textureId);
        if (compiledTexture?.record.kind !== 'texture')
          return err(resolutionError('texture view source'));
        const descriptor = compiledTexture.resolvedDescriptor ?? compiledTexture.textureDescriptor;
        const viewDescriptor = this.physical.view(data.id)?.record.descriptor;
        const texture = frameResources.textures.values[data.textureId];
        const view = frameResources.views.values[data.id];
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
        if ('error' in data) return data;
        const view = frameResources.views.result(data.id);
        return view === undefined
          ? err(resolutionError(this.physical.view(data.id)?.record.label ?? 'texture view'))
          : view;
      },
      textureViewExtent: (resource) => {
        const data = lookup(resource, 'texture-view');
        if ('error' in data) return data;
        const extent = this.viewExtents[data.id];
        if (extent !== undefined && 'record' in extent)
          return extent.resolvedViewExtent ?? err(resolutionError('owner-sized texture view'));
        return extent ?? err(resolutionError('texture view'));
      },
      accelerationStructure: (resource) => {
        const data = lookup(resource, 'acceleration-structure');
        if ('error' in data) return data;
        const tlas = frameResources.accelerationStructures.result(data.id);
        return tlas === undefined
          ? err(
              resolutionError(
                this.physical.resource(data.id)?.record.label ?? 'acceleration structure',
              ),
            )
          : tlas;
      },
    };
  }
}

/** Append the physical graph's declaration order to the owning frame receipt. */
export function appendCompiledRenderGraphPassNames<Frame extends RenderGraphFrame>(
  graph: Pick<CompiledRenderGraph<Frame>, 'inspect'>,
  output: string[] | undefined,
  frame?: Frame,
): void {
  if (output === undefined) return;
  if (graph instanceof CompiledRenderGraphImpl) graph.appendPassNames(output, frame);
  else for (const pass of graph.inspect().passes) output.push(pass.name);
}

/** Read declarations for explicit resource labels or one feature's label prefix at binding. */
export function compiledRenderGraphResourceDeclarations(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>,
  labels: string | readonly string[],
): CompiledRenderGraphInfo['resources'] {
  if (graph instanceof CompiledRenderGraphImpl) return graph.resourceDeclarations(labels);
  return graph
    .inspect()
    .resources.filter((resource) =>
      typeof labels === 'string'
        ? resource.label.startsWith(labels)
        : labels.includes(resource.label),
    );
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

/** Answer a pass-presence query without constructing the passes' dependency or lifetime inspection. */
export function compiledRenderGraphHasPass(
  graph: { inspect(): { readonly passes: readonly { readonly name: string }[] } },
  name: string,
): boolean {
  return graph instanceof CompiledRenderGraphImpl
    ? graph.declaresPass(name)
    : graph.inspect().passes.some((pass) => pass.name === name);
}

/** Read physical allocations from their owner. External producers may supply totals without handles. */
export function compiledRenderGraphAllocation(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>,
  visit?: AllocationVisitor,
): RenderGraphResourceAllocationInspection | undefined {
  if (graph instanceof CompiledRenderGraphImpl) return graph.inspectAllocation(visit);
  const info = graph.inspect();
  if (visit !== undefined) {
    if (info.resources.some((row) => row.allocationState !== undefined)) {
      for (const row of info.resources) {
        if (
          row.origin === 'created' &&
          row.physicalAllocationKey !== undefined &&
          row.byteSize !== undefined &&
          (row.allocationState === 'live' || row.allocationState === 'pending-retirement')
        ) {
          visit(row.physicalAllocationKey, row.byteSize, row.allocationState);
        }
      }
    } else if (info.resourceAllocation !== undefined) {
      visit(undefined, info.resourceAllocation.liveBytes, 'live');
      visit(undefined, info.resourceAllocation.pendingRetirementBytes, 'pending-retirement');
    }
  }
  return info.resourceAllocation;
}
