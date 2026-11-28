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
import type { AttachmentBindings } from './attachment-bindings.js';
import {
  type AllocationVisitor,
  type BoundGraphResources,
  type GraphAllocationObserver,
  releaseBoundResource,
} from './bound-resources.js';
import { inspectPasses, inspectResource } from './compiled-inspection.js';
import { applyTextureContentWrite, firstMissingTextureRead } from './content-ranges.js';
import { err, ok, RenderGraphError, type Result, type ResultErr } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import type {
  CompiledPass,
  CompiledResource,
  CompiledTextureWrite,
  CompiledView,
  GraphTextureAllocation,
  PhysicalGraphSlots,
  ResourceHandleData,
} from './kernel-internal.js';
import {
  bindSlot,
  handleData,
  LINEAR_PASS_ACCESS_LIMIT,
  physicalAllocationKey,
} from './kernel-internal.js';
import {
  decorateDescriptor,
  NativeCommandRecorder,
  safeEndPass,
  safePassScope,
} from './native-pass.js';
import {
  type BoundRenderGraphResources,
  NativeRecordingResources,
  type PassResourcePreparation,
  passGrantsAccess,
  resolutionError,
} from './native-recording-resources.js';
import type { RasterBatch } from './raster-batching.js';
import { coversUsage, SubgraphBindings } from './subgraph-bindings.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  GraphAccelerationStructure,
  GraphAccess,
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
  physical: PhysicalGraphSlots<FrameCtx>,
  addresses: Uint32Array,
): RenderGraphPassExecution {
  if (pass.pass.kind === 'raster' && pass.pass.descriptor.depthStencilAttachment !== undefined) {
    const view = physical.handle<TextureView>(addresses[pass.accessEnd] as number);
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

interface ExecutionCursor {
  next: number;
  readonly pendingPasses?: Set<string> | undefined;
}

type StagedTextureWrite = { readonly range: GraphTextureContentRange; readonly stored: boolean };

/** Record physical destinations in issue order. Only an imported alias needs
 * to resolve its handle against the owning graph's persistent allocations. */
class TextureWriteJournal {
  private readonly destinations: GraphTextureAllocation[] = [];
  private readonly writes: StagedTextureWrite[] = [];

  constructor(private readonly owned: ReadonlyMap<Texture, GraphTextureAllocation> | undefined) {}

  get length(): number {
    return this.writes.length;
  }

  record<Frame extends RenderGraphFrame>(write: CompiledTextureWrite<Frame>): void {
    const slot = write.texture;
    const allocation =
      slot.textureAllocation ??
      (slot.handle === undefined ? undefined : this.owned?.get(slot.handle));
    if (allocation === undefined) return;
    this.destinations.push(allocation);
    this.writes.push(write);
  }

  append(other: TextureWriteJournal): void {
    for (let i = 0; i < other.writes.length; i++) {
      this.destinations.push(other.destinations[i] as GraphTextureAllocation);
      this.writes.push(other.writes[i] as StagedTextureWrite);
    }
  }

  commit(): void {
    for (let i = 0; i < this.writes.length; i++) {
      const allocation = this.destinations[i] as GraphTextureAllocation;
      const { range, stored } = this.writes[i] as StagedTextureWrite;
      applyTextureContentWrite(allocation.committedContentRanges, range, stored);
    }
    this.clear();
  }

  clear(): void {
    this.destinations.length = 0;
    this.writes.length = 0;
  }
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** Resolve one pass's color attachments into its retained native descriptor. */
function resolveRasterColors<FrameCtx extends RenderGraphFrame>(
  attachments: readonly RasterColorAttachment<FrameCtx>[],
  frame: FrameCtx,
  physical: PhysicalGraphSlots<FrameCtx>,
  addresses: Uint32Array,
  firstColor: number,
  retained: RenderPassDescriptor['colorAttachments'] | undefined,
): Writable<RenderPassColorAttachment>[] | RenderGraphError {
  const colorAttachments = (retained ?? []) as Writable<RenderPassColorAttachment>[];
  let colorIndex = 0;
  for (const attachment of attachments) {
    const view = physical.handle<TextureView>(addresses[firstColor++] as number);
    const targetId = addresses[firstColor++] as number;
    const resolveTarget = targetId === 0 ? undefined : physical.handle<TextureView>(targetId);
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

function validPhysicalDimension(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0;
}

function bufferSize<FrameCtx>(
  resource: CompiledResource<FrameCtx> | undefined,
): number | undefined {
  return resource?.kind === 'buffer' ? resource.descriptor.size : undefined;
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
  const a = left?.resolvedDescriptor ?? left?.textureShape?.descriptor,
    b = right?.resolvedDescriptor ?? right?.textureShape?.descriptor;
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
  const allocation = texture?.resolvedDescriptor ?? texture?.textureShape?.descriptor;
  if (left === undefined || right === undefined || allocation === undefined) return false;
  const a = left.descriptor;
  const b = right.descriptor;
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

/** The physical recording already owns its target addresses and execution generation. */
export interface BoundRenderGraphRecording<Frame extends RenderGraphFrame>
  extends CompiledRenderGraph<Frame> {
  readonly graphGeneration: number;
  readonly nativeResources: BoundRenderGraphResources;
  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined;
  getColorTargetView(name: string): TextureView | undefined;
}

export class CompiledRenderGraphImpl<FrameCtx extends RenderGraphFrame>
  implements BoundRenderGraphRecording<FrameCtx>
{
  readonly nativeResources: NativeRecordingResources<FrameCtx>;
  private nativeRecorder: NativeCommandRecorder<FrameCtx> | undefined;
  private subgraphBindings: SubgraphBindings | undefined;
  private retireResult: Promise<Result<void, RenderGraphError>> | undefined;
  private inspection: CompiledRenderGraphInfo | undefined;
  private declarations: CompiledRenderGraphInfo['passes'] | undefined;
  private importsResolved = false;
  private readonly acceptsParentPorts: boolean;
  private readonly resolvers: (
    | {
        readonly resolver: GraphResourceResolver;
        raster?: Writable<RenderPassDescriptor>;
        compute?: ComputePassDescriptor;
      }
    | undefined
  )[] = [];
  private pendingTextureWrites: TextureWriteJournal;
  private executingTextureWrites: TextureWriteJournal;

  constructor(
    private readonly generation: number,
    private readonly owner: object,
    private readonly device: RhiDevice,
    private readonly physical: PhysicalGraphSlots<FrameCtx>,
    private readonly resources: BoundGraphResources<FrameCtx>,
    private readonly slotsByLabel: ReadonlyMap<string, number>,
    private readonly accessIds: Uint32Array,
    private readonly passes: readonly CompiledPass<FrameCtx>[],
    preparations: readonly PassResourcePreparation[],
    hasSubgraph: boolean,
    private readonly rasterBatches: readonly (RasterBatch<FrameCtx> | undefined)[],
  ) {
    this.nativeResources = new NativeRecordingResources(
      generation,
      owner,
      device,
      physical,
      resources.nativeInputs,
      accessIds,
      preparations,
    );
    this.acceptsParentPorts = resources.importOnly && !hasSubgraph;
    this.pendingTextureWrites = new TextureWriteJournal(resources.persistentTextures);
    this.executingTextureWrites = new TextureWriteJournal(resources.persistentTextures);
  }

  inspectAllocation(visit?: AllocationVisitor): RenderGraphResourceAllocationInspection {
    if (visit !== undefined) this.resources.visit(visit);
    return this.resources.inspect();
  }

  get graphGeneration(): number {
    return this.generation;
  }

  observeAllocations(observer: GraphAllocationObserver): boolean {
    return this.resources.observeAllocations(observer);
  }

  declaresPass(name: string): boolean {
    for (const pass of this.passes) if (pass.name === name) return true;
    return false;
  }

  countPassesBeginningWith(prefix: string): number {
    let count = 0;
    for (const pass of this.passes) if (pass.name.startsWith(prefix)) count++;
    return count;
  }

  /** Read the bound declarations of one feature, independent of frame import identities. */
  resourceDeclarations(labels: string | readonly string[]): CompiledRenderGraphInfo['resources'] {
    const resources: CompiledRenderGraphInfo['resources'][number][] = [];
    if (typeof labels === 'string') {
      for (const compiled of this.physical.resources()) {
        if (compiled.label.startsWith(labels)) resources.push(inspectResource(compiled));
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
    const allocation = this.resources.inspect();
    if (this.inspection?.resourceAllocation === allocation) return this.inspection;
    const resources = Array.from(this.physical.resources(), (compiled) => {
      const resource = inspectResource(compiled);
      if (this.importsResolved && resource.origin === 'imported') {
        const handle = compiled.kind === 'acceleration-structure' ? undefined : compiled.handle;
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
        allocationState: this.resources.state(compiled.handle),
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
    return this.nativeResources.isRetired();
  }

  preparedResourcesCurrent(): boolean {
    return this.nativeResources.preparedResourcesCurrent();
  }

  prepareResources(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>> {
    return this.nativeResources.prepareResources(current);
  }

  createdTextureView(resource: GraphTextureView): TextureView | undefined {
    return this.nativeResources.createdTextureView(resource);
  }

  /** @internal Detach physical inputs from pass callbacks, ordinals and inspection. */
  _attachmentBindings(device: RhiDevice): AttachmentBindings | undefined {
    return this.nativeResources.isRetired() || device !== this.device
      ? undefined
      : this.resources.attachments;
  }

  commitExecution(): void {
    if (this.nativeResources.isRetired()) this.pendingTextureWrites.clear();
    else this.pendingTextureWrites.commit();
  }

  discardExecution(): void {
    this.pendingTextureWrites.clear();
  }

  getColorTargetView(name: string): TextureView | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined) return undefined;
    const resource = this.physical.resource(slot);
    if (resource?.firstView === undefined || resource.passLocal) return undefined;
    return this.physical.handle<TextureView>(resource.firstView);
  }

  getColorTargetTexture(name: string): Texture | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined) return undefined;
    const resource = this.physical.resource(slot);
    if (resource?.kind !== 'texture' || resource.passLocal) return undefined;
    return resource.handle;
  }

  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined {
    const slot = this.slotsByLabel.get(name);
    if (slot === undefined) return undefined;
    const resource = this.physical.resource(slot);
    if (resource?.kind !== 'texture' || resource.passLocal) return undefined;
    if (resource.colorTarget !== undefined) return resource.colorTarget;
    const descriptor = resource.resolvedDescriptor ?? resource.textureShape?.descriptor;
    if (descriptor === undefined) return undefined;
    const { width, height } = descriptor.size;
    const texture = resource.handle;
    if (texture === undefined) return undefined;
    if (resource.origin === 'created') {
      resource.colorTarget = {
        texture,
        format: resource.descriptor.format,
        size: { width, height },
        usage: resource.usage,
        sample: resource.descriptor.sampleCount ?? 1,
      };
      return resource.colorTarget;
    }
    return {
      texture,
      format: resource.descriptor.format,
      size: { width, height, depthOrArrayLayers: descriptor.size.depthOrArrayLayers ?? 1 },
      usage: descriptor.usage ?? resource.usage,
      sample: descriptor.sampleCount ?? 1,
    };
  }

  private checkInheritedTextureReads(): RenderGraphError | undefined {
    const inherited = this.resources.inheritedTextureReads;
    if (inherited === undefined) return undefined;
    for (const { label, allocation, reads } of inherited) {
      const read = firstMissingTextureRead(reads, allocation.committedContentRanges);
      if (read === undefined) continue;
      return new RenderGraphError({
        code: 'uninitialized-read',
        expected: `borrowed persistent texture content remains initialized before pass '${read.passName}' executes`,
        hint: 'recompile the candidate after the allocation content changes',
        detail: { passName: read.passName, resourceLabel: label, usage: read.usage },
      });
    }
    return undefined;
  }

  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    pendingPasses?: Set<string>,
  ): Result<void, RenderGraphError> {
    if (this.nativeResources.isRetired()) {
      return err(
        new RenderGraphError({
          code: 'compiled-graph-retired',
          expected: 'a compiled graph executes only before retire()',
          hint: 'publish and execute the replacement compiled graph',
          detail: { generation: this.generation },
        }),
      );
    }

    const resolved = this.resolveFrameResources(frame);
    if (!resolved.ok) return resolved;
    const inherited = this.checkInheritedTextureReads();
    if (inherited !== undefined) return err(inherited);
    const writes = this.executingTextureWrites;
    const names = frame.nativePassNames;
    const start = names?.length ?? 0;
    let completed = false;
    try {
      const executed = this.#executeResolved(
        frame,
        runPass,
        instrumentation,
        { next: 0, pendingPasses },
        writes,
      );
      if (executed.ok && writes.length !== 0) {
        if (this.pendingTextureWrites.length === 0) {
          this.executingTextureWrites = this.pendingTextureWrites;
          this.pendingTextureWrites = writes;
        } else this.pendingTextureWrites.append(writes);
      }
      completed = executed.ok;
      return executed;
    } finally {
      if (!completed && names !== undefined) names.length = start;
      this.executingTextureWrites.clear();
    }
  }

  #stagePassTextureWrites(pass: CompiledPass<FrameCtx>, writes: TextureWriteJournal): void {
    for (const write of pass.textureWrites) writes.record(write);
  }

  #executeResolved(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    indices: ExecutionCursor = { next: 0 },
    writes = this.executingTextureWrites,
  ): Result<void, RenderGraphError> {
    if (!this.nativeResources.enter())
      return this.subgraphError('execution', 'a live, non-recursive compiled graph');
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
        const resolver = this.passResolver(pass);
        try {
          if (pass.pass.descriptor.executeIf?.(frame) === false) continue;
          // The execution record and encode closure exist only for an observer.
          const execution =
            runPass === undefined && instrumentation === undefined
              ? undefined
              : passExecutionRecord(pass, executionIndex, this.physical, this.accessIds);
          if (runPass !== undefined && execution !== undefined) {
            const observed = this.#observePass(
              pass,
              frame,
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
              resolver,
              execution,
              runPass,
              instrumentation,
              indices,
              writes,
            );
            if (!encoded.ok) return encoded;
            indices.pendingPasses?.delete(pass.name);
            this.#stagePassTextureWrites(pass, writes);
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
      this.nativeResources.leave();
    }
  }

  #encodeRasterBatch(
    batch: RasterBatch<FrameCtx>,
    first: number,
    last: number,
    frame: FrameCtx,
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
      const resolver = this.passResolver(active);
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
          this.physical,
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
          this.physical.handle<TextureView>(this.accessIds[active.accessEnd] as number),
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
          const execution = passExecutionRecord(
            active,
            logicalIndex,
            this.physical,
            this.accessIds,
          );
          runPass(execution, encode);
        }
      }
      // The native attachment lifetime ends once, with the final descriptor's
      // store/resolve semantics, even when a diagnostic omits a logical body.
      if (encoder !== undefined) this.#stagePassTextureWrites(final, writes);
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
      this.#stagePassTextureWrites(pass, writes);
    }
    return encodeResult;
  }

  #encodePass(
    pass: CompiledPass<FrameCtx>,
    frame: FrameCtx,
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
            this.physical,
            this.accessIds,
            pass.accessEnd + 1,
            retained?.colorAttachments,
          );
          if (colorAttachments instanceof RenderGraphError) return err(colorAttachments);
          const depthStencilAttachment = resolveRasterDepth(
            descriptor.depthStencilAttachment,
            frame,
            this.physical.handle<TextureView>(this.accessIds[pass.accessEnd] as number),
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
    resolver: GraphResourceResolver,
    runPass: RenderGraphPassRunner | undefined,
    instrumentation: RenderGraphPassInstrumentation<FrameCtx> | undefined,
    indices: ExecutionCursor,
    writes: TextureWriteJournal,
  ): Result<void, RenderGraphError> {
    if (pass.pass.kind !== 'subgraph') return this.subgraphError('kind', 'a subgraph pass');
    const descriptor = pass.pass.descriptor;
    if (descriptor.child === undefined) {
      this.nativeRecorder ??= new NativeCommandRecorder(() => this.nativeResources.isRetired());
      this.nativeRecorder.run(descriptor, frame, resolver, indices, instrumentation, runPass);
      return ok(undefined);
    }
    const selected = descriptor.child(frame, resolver);
    if (selected === null || typeof selected !== 'object' || !(#executeResolved in selected))
      return this.subgraphError('child', 'a graph compiled by RenderGraphBuilder');
    const child = selected as CompiledRenderGraphImpl<FrameCtx>;
    if (child.device !== this.device)
      return this.subgraphError('device', 'the same RHI device for parent and child');
    if (child.isRetired() || child.nativeResources.isBusy())
      return this.subgraphError('child', 'a live, non-recursive child graph');
    if (!child.acceptsParentPorts)
      return this.subgraphError('resources', 'an import-only child without nested subgraphs');
    const snapshot = child.resolveFrameResources(frame);
    if (!snapshot.ok) return snapshot;
    const ports = descriptor.accesses;
    let grants: ReadonlyMap<number, number> | undefined;
    if (ports.length > LINEAR_PASS_ACCESS_LIMIT) {
      this.subgraphBindings ??= new SubgraphBindings(this.physical);
      grants = this.subgraphBindings.grantsFor(ports);
    }
    const failure = this.checkSubgraphPorts(ports, grants, child);
    if (failure !== undefined) return failure;
    // Import callbacks can retire a graph; validation and encoding use this one snapshot.
    if (this.nativeResources.isRetired() || child.isRetired())
      return this.subgraphError('child', 'parent and child remain live after import resolution');
    return child.#executeResolved(frame, runPass, instrumentation, indices, writes);
  }

  private checkSubgraphPorts(
    ports: readonly GraphAccess[],
    grants: ReadonlyMap<number, number> | undefined,
    child: CompiledRenderGraphImpl<FrameCtx>,
  ): Result<never, RenderGraphError> | undefined {
    let parentBuffers: Set<Buffer> | undefined;
    for (const pass of child.passes) {
      for (const access of pass.pass.descriptor.accesses) {
        const data = handleData(access.resource);
        if (data === undefined) return this.subgraphError('access', 'a compiled child access');
        if (data.kind !== 'buffer' && data.kind !== 'texture-view')
          return this.subgraphError('access', 'only buffer and texture-view child accesses');
        const buffer = data.kind === 'buffer' ? child.physical.handle<Buffer>(data.id) : undefined;
        if (data.kind === 'buffer' && buffer === undefined) continue;
        const handle =
          data.kind === 'buffer' ? buffer : child.physical.handle<TextureView>(data.id);
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
            for (const slot of this.physical.resources())
              if (slot.kind === 'buffer' && slot.handle !== undefined)
                parentBuffers.add(slot.handle);
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
        this.physical.handle<Buffer>(id) === child.physical.handle<Buffer>(data.id) &&
        bufferSize(this.physical.resource(id)) === bufferSize(child.physical.resource(data.id))
      );
    const view = this.physical.view(id);
    if (view === undefined) return false;
    const textureId = view.textureId;
    const texture = this.physical.resource(textureId);
    return (
      view.handle === child.physical.handle<TextureView>(data.id) &&
      this.physical.handle<Texture>(textureId) === child.physical.handle<Texture>(data.textureId) &&
      sameTexture(texture, child.physical.resource(data.textureId)) &&
      sameView(view, child.physical.view(data.id), texture)
    );
  }

  retire(): Promise<Result<void, RenderGraphError>> {
    if (this.retireResult !== undefined) return this.retireResult;
    this.nativeResources.revoke();
    this.resources.attachments.revoke();
    this.subgraphBindings = undefined;
    this.pendingTextureWrites.clear();
    this.resources.persistentTextures?.clear();
    this.retireResult = this.finishRetire();
    return this.retireResult;
  }

  private async finishRetire(): Promise<Result<void, RenderGraphError>> {
    this.resources.retireAll();
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
    for (const compiled of this.resources.owningSlots()) {
      let destroyedSuccessfully = false;
      try {
        const destroyed = releaseBoundResource(this.device, compiled);
        destroyedSuccessfully = destroyed.ok;
        if (!destroyed.ok && firstFailure === undefined) {
          firstFailure = new RenderGraphError({
            code: 'resource-retire-failed',
            expected: `graph-created resource '${compiled.label}' retires exactly once`,
            hint: 'inspect detail.cause for the RHI destroy refusal',
            detail: {
              generation: this.generation,
              resourceLabel: compiled.label,
              cause: destroyed.error,
            },
          });
        }
      } catch (cause) {
        firstFailure ??= new RenderGraphError({
          code: 'resource-retire-failed',
          expected: `graph-created resource '${compiled.label}' retires exactly once`,
          hint: 'inspect detail.cause for the RHI destroy failure',
          detail: { generation: this.generation, resourceLabel: compiled.label, cause },
        });
      } finally {
        // A failed or throwing destroy leaves the handle owned by this
        // graph. Keep its token pending so inspection reflects the
        // retirement failure instead of claiming bytes were released.
        if (destroyedSuccessfully) this.resources.release(compiled.handle);
      }
    }
    return firstFailure === undefined ? ok(undefined) : err(firstFailure);
  }

  private resolveFrameResources(frame: FrameCtx): Result<void, RenderGraphError> {
    if (!this.nativeResources.enter())
      return this.subgraphError('execution', 'a live, non-recursive compiled graph');
    try {
      return this.resolveFrameResourceValues(frame);
    } finally {
      this.nativeResources.leave();
    }
  }

  private resolveFrameResourceValues(frame: FrameCtx): Result<void, RenderGraphError> {
    let resolved = false;
    try {
      for (const record of this.resources.imports) {
        try {
          if (record.kind === 'texture') {
            const texture = record.resolve(frame);
            if (texture === undefined) return err(resolutionError(record.label));
            if (record.handle !== texture) {
              const extent = record.native?.resolvedExtent?.(texture);
              if (extent !== undefined) {
                const { width, height, depthOrArrayLayers } = extent;
                if (
                  record.textureShape === undefined ||
                  !validPhysicalDimension(width) ||
                  !validPhysicalDimension(height) ||
                  !validPhysicalDimension(depthOrArrayLayers)
                )
                  return err(resolutionError(record.label, 'invalid physical texture extent'));
                const size = Object.freeze({ width, height, depthOrArrayLayers });
                record.resolvedDescriptor = { ...record.textureShape.descriptor, size };
                record.resolvedViewExtent = ok(Object.freeze({ width, height }));
              }
              bindSlot(record, texture);
              this.inspection = undefined;
            }
          } else if (record.kind === 'buffer') {
            const buffer = record.resolve(frame);
            if (buffer === undefined) return err(resolutionError(record.label));
            const previous = record.handle;
            if (bindSlot(record, buffer)) {
              this.subgraphBindings?.replace('buffer', record.id, previous, buffer);
              this.inspection = undefined;
            }
          } else bindSlot(record, record.resolve(frame));
        } catch (cause) {
          return err(resolutionError(record.label, cause));
        }
      }
      for (const record of this.resources.frameViews) {
        if (record.resolve !== undefined) {
          try {
            const value = record.resolve(frame);
            const previous = record.handle;
            if (bindSlot(record, value))
              this.subgraphBindings?.replace('texture-view', record.id, previous, value);
          } catch (cause) {
            return err(resolutionError(record.label, cause));
          }
        } else {
          const texture = this.physical.handle<Texture>(record.textureId);
          if (texture === undefined) return err(resolutionError(record.label));
          const view = this.nativeResources.importedTextureView(record, texture);
          if (!view.ok) return view;
          this.subgraphBindings?.replace('texture-view', record.id, record.handle, view.value);
          bindSlot(record, view.value, view);
        }
      }
      resolved = true;
      return ok(undefined);
    } finally {
      if (this.importsResolved !== resolved) this.inspection = undefined;
      this.importsResolved = resolved;
    }
  }

  private passResolver(pass: CompiledPass<FrameCtx>): GraphResourceResolver {
    let context = this.resolvers[pass.id];
    if (context === undefined) {
      context = { resolver: this.createPassResolver(pass) };
      this.resolvers[pass.id] = context;
    }
    return context.resolver;
  }

  private describeViewExtent(view: CompiledView<FrameCtx>): CompiledView<FrameCtx>['extent'] {
    const resource = this.physical.resource(view.textureId);
    if (resource === undefined || resource.usage === 0) return undefined;
    if (
      resource.kind === 'texture' &&
      resource.origin === 'imported' &&
      resource.native?.resolvedExtent !== undefined
    )
      return resource;
    const size = resource.textureShape?.descriptor.size;
    if (size === undefined) return undefined;
    const mip = view.descriptor.baseMipLevel ?? 0;
    return ok(
      Object.freeze({
        width: mipDimension(size.width, mip),
        height: mipDimension(size.height, mip),
      }),
    );
  }

  private createPassResolver(pass: CompiledPass<FrameCtx>): GraphResourceResolver {
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
      if (passGrantsAccess(this.accessIds, pass, data.id)) return data;
      if (data.kind !== 'texture-view' || !passGrantsAccess(this.accessIds, pass, data.textureId)) {
        const label = this.physical.resource(resourceId ?? -1)?.label;
        return err(
          new RenderGraphError({
            code: 'resource-not-declared-by-pass',
            expected: `pass '${pass.name}' resolves only resources present in its accesses`,
            hint: 'add the resource access to this pass before resolving it',
            detail: { passName: pass.name, resourceLabel: label },
          }),
        );
      }
      const label = this.physical.view(data.id)?.label;
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
        const buffer = this.physical.result<Buffer>(data.id);
        return buffer === undefined
          ? err(resolutionError(this.physical.resource(data.id)?.label ?? 'buffer'))
          : buffer;
      },
      bufferSource: (resource) => {
        const data = lookup(resource, 'buffer');
        if ('error' in data) return data;
        const compiled = this.physical.resource(data.id);
        const buffer = this.physical.handle<Buffer>(data.id);
        if (compiled?.kind !== 'buffer' || buffer === undefined)
          return err(resolutionError('buffer source'));
        return ok(
          Object.freeze({
            buffer,
            descriptor: Object.freeze({
              ...compiled.descriptor,
              usage: compiled.origin === 'imported' ? compiled.descriptor.usage : compiled.usage,
            }),
          }),
        );
      },
      texture: (resource) => {
        const data = lookup(resource, 'texture');
        if ('error' in data) return data;
        const texture = this.physical.result<Texture>(data.id);
        return texture === undefined
          ? err(resolutionError(this.physical.resource(data.id)?.label ?? 'texture'))
          : texture;
      },
      textureViewSource: (resource) => {
        const data = lookup(resource, 'texture-view');
        if ('error' in data) return data;
        if (data.kind !== 'texture-view') return err(resolutionError('texture view source'));
        const compiledTexture = this.physical.resource(data.textureId);
        if (compiledTexture?.kind !== 'texture') return err(resolutionError('texture view source'));
        const descriptor =
          compiledTexture.resolvedDescriptor ?? compiledTexture.textureShape?.descriptor;
        const viewDescriptor = this.physical.view(data.id)?.descriptor;
        const texture = this.physical.handle<Texture>(data.textureId);
        const view = this.physical.handle<TextureView>(data.id);
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
              format: compiledTexture.descriptor.format,
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
        const view = this.physical.result<TextureView>(data.id);
        return view === undefined
          ? err(resolutionError(this.physical.view(data.id)?.label ?? 'texture view'))
          : view;
      },
      textureViewExtent: (resource) => {
        const data = lookup(resource, 'texture-view');
        if ('error' in data) return data;
        const view = this.physical.view(data.id);
        if (view === undefined) return err(resolutionError('texture view'));
        view.extent ??= this.describeViewExtent(view);
        if (view.extent !== undefined && 'kind' in view.extent)
          return view.extent.resolvedViewExtent ?? err(resolutionError('owner-sized texture view'));
        return view.extent ?? err(resolutionError('texture view'));
      },
      accelerationStructure: (resource) => {
        const data = lookup(resource, 'acceleration-structure');
        if ('error' in data) return data;
        const tlas = this.physical.result<Tlas>(data.id);
        return tlas === undefined
          ? err(resolutionError(this.physical.resource(data.id)?.label ?? 'acceleration structure'))
          : tlas;
      },
    };
  }
}

/** The authority used by the physical recorder and its native preparation consumers. */
export function boundRenderGraphResources<Frame extends RenderGraphFrame>(
  graph: CompiledRenderGraph<Frame>,
): BoundRenderGraphResources {
  return graph instanceof CompiledRenderGraphImpl ? graph.nativeResources : graph;
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

/** Count declarations without constructing allocation or pass inspection records. */
export function compiledRenderGraphPassCountByPrefix(
  graph: { inspect(): { readonly passes: readonly { readonly name: string }[] } },
  prefix: string,
): number {
  return graph instanceof CompiledRenderGraphImpl
    ? graph.countPassesBeginningWith(prefix)
    : graph
        .inspect()
        .passes.reduce((count, pass) => count + Number(pass.name.startsWith(prefix)), 0);
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

/** @internal Attach the view's physical byte counter until the bound allocations release. */
export function observeCompiledRenderGraphAllocations(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'>,
  observer: GraphAllocationObserver,
): boolean {
  return graph instanceof CompiledRenderGraphImpl && graph.observeAllocations(observer);
}
