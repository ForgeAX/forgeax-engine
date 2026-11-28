import type { Buffer, RhiCaps, Texture, Tlas } from '@forgeax/engine-rhi';
import type { AttachmentBindings } from './attachment-bindings.js';
import { BoundGraphResources, releaseBoundResource } from './bound-resources.js';
import {
  type AttachmentSlots,
  addAttachmentSlot,
  placeColorAttachments,
  privateSamples,
} from './color-attachment-placement.js';
import { type BoundRenderGraphRecording, CompiledRenderGraphImpl } from './compiled-graph.js';
import { allocationBytes } from './compiled-inspection.js';
import {
  applyTextureContentWrite,
  firstMissingTextureRead,
  intersectTextureRange,
  textureRangeCovered,
} from './content-ranges.js';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import {
  accelerationStructureHandle,
  bufferHandle,
  type CompiledPass,
  type CompiledResource,
  type CompiledView,
  type GraphTextureAllocation,
  handleData,
  LINEAR_PASS_ACCESS_LIMIT,
  type PassRecord,
  PhysicalGraphSlots,
  type PhysicalTextureShape,
  type ResourceRecord,
  snapshotPass,
  snapshotTextureDescriptor,
  type TextureViewRecord,
  textureHandle,
  textureViewHandle,
} from './kernel-internal.js';
import { allocateRenderPassGeneration } from './native-pass.js';
import type { PassResourcePreparation } from './native-recording-resources.js';
import {
  accessMode,
  accessModeForPass,
  mayLoadAttachment,
  viewAccessRange,
} from './pass-access.js';
import { planRasterBatches, RasterBatchCandidates } from './raster-batching.js';
import { isTextureViewDimensionCompatible } from './resource-registry.js';
import type {
  CompiledRenderGraph,
  ComputeGraphPass,
  CopyGraphPass,
  GraphAccelerationStructure,
  GraphAccess,
  GraphAccessUsage,
  GraphBuffer,
  GraphBufferAccess,
  GraphBufferDescriptor,
  GraphExtent,
  GraphPass,
  GraphTexture,
  GraphTextureAccess,
  GraphTextureContentRange,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedAccelerationStructureDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RasterGraphPass,
  RenderGraphCompileOptions,
  RenderGraphFrame,
  SubgraphPass,
} from './types.js';
import { firstScopeConflict, type ScopeAccess, type ScopeWorkspace } from './usage-scope.js';

const BUFFER_USAGE = {
  copySrc: 0x0004,
  copyDst: 0x0008,
  index: 0x0010,
  vertex: 0x0020,
  uniform: 0x0040,
  storage: 0x0080,
  indirect: 0x0100,
} as const;

const TEXTURE_USAGE = {
  copySrc: 0x01,
  copyDst: 0x02,
  textureBinding: 0x04,
  storageBinding: 0x08,
  renderAttachment: 0x10,
} as const;

const NO_TEXTURE_WRITES = Object.freeze([]);
const NO_CONSUMER_READS: readonly GraphAccess[] = Object.freeze([]);
const NO_DEFERRED_PASSES = Object.freeze([]);

function consumerReadRole(usage: GraphAccessUsage): number {
  return usage === 'vertex-read' ? 1 : usage === 'sampled-read' ? 2 : 0;
}

type TextureSlot<Frame extends RenderGraphFrame> = Extract<
  CompiledResource<Frame>,
  { kind: 'texture' }
>;
const DEPTH_STENCIL_FORMATS = new Set<GPUTextureFormat>([
  'depth24plus-stencil8',
  'depth32float-stencil8',
]);

let compileCount = 0;
let orderedViewBindCount = 0;

/**
 * Realm-lifetime count of compiled or directly bound recordings (monotonic). Engine-owned
 * frame diagnostics read it before and after a draw to report compiles per
 * frame; it is not a stable public API.
 * @internal
 */
export function renderGraphCompileCount(): number {
  return compileCount + orderedViewBindCount;
}

/** @internal Successful physical bindings produced by the built-in display path. */
export function renderOrderedViewBindCount(): number {
  return orderedViewBindCount;
}

type BindingOptions = Omit<RenderGraphCompileOptions, 'reuseResourcesFrom'> & {
  readonly previous: AttachmentBindings | undefined;
};

function bindingOptions(options: RenderGraphCompileOptions): BindingOptions {
  const { device, surfaceSize, retainPassLocalTargets, reuseResourcesFrom } = options;
  return {
    device,
    surfaceSize: { width: surfaceSize.width, height: surfaceSize.height },
    retainPassLocalTargets: retainPassLocalTargets === true,
    previous:
      reuseResourcesFrom instanceof CompiledRenderGraphImpl
        ? reuseResourcesFrom._attachmentBindings(device)
        : undefined,
  };
}

const NO_VIEW_FORMATS = Object.freeze([]);

/** A physical attachment moves between one descriptor family and a last-use pass. */
interface PassLocalSlot {
  readonly label: string;
  readonly family: PassLocalSlot[];
  nextEnding: PassLocalSlot | undefined;
  allocation?: GraphTextureAllocation;
}

interface NormalizedAccess extends ScopeAccess {
  repeatedColorAccess?: true;
  precedingResolve?: number;
  readonly resourceId: number;
  readonly viewId?: number | undefined;
  read: boolean;
  /** A bound color source stores or discards. A resolve destination always stores. */
  colorStore?: boolean;
}

/** Builder-owned until the pass is emitted to its physical program. */
type RecordingPass<Frame extends RenderGraphFrame> = {
  -readonly [P in keyof CompiledPass<Frame>]: CompiledPass<Frame>[P];
};

interface PassDeclaration<Frame extends RenderGraphFrame> {
  record: RecordingPass<Frame>;
  accesses: NormalizedAccess[];
  requiredCaps: number;
}

interface PhysicalPassProgram<Frame extends RenderGraphFrame> {
  readonly passes: CompiledPass<Frame>[];
  readonly preparations: readonly PassResourcePreparation[];
  readonly hasSubgraph: boolean;
  readonly accessIds: Uint32Array;
}

interface PassStream<Frame extends RenderGraphFrame> {
  append(
    pass: RecordingPass<Frame>,
    accesses: readonly NormalizedAccess[],
    requiredCaps: number,
  ): RenderGraphError | undefined;
  finish(
    physical: PhysicalGraphSlots<Frame>,
    invalidImport: ImportWithUsage<Frame> | undefined,
  ): Result<PhysicalPassProgram<Frame>, RenderGraphError>;
}

type ImportWithUsage<Frame extends RenderGraphFrame> = Extract<
  CompiledResource<Frame>,
  { kind: 'texture' | 'buffer'; origin: 'imported' }
>;

function invalidImportUsage<Frame extends RenderGraphFrame>(
  resource: ImportWithUsage<Frame>,
): RenderGraphError {
  const { usage, label } = resource;
  return new RenderGraphError({
    code: 'import-usage-mismatch',
    expected: `imported resource '${label}' physical usage contains derived graph usage ${usage}`,
    hint: 'recreate the imported resource with every usage declared by graph accesses',
    detail: {
      resourceLabel: label,
      field: 'usage',
      expected: String(usage),
      actual: resource.descriptor.usage,
    },
  });
}

function surfaceExtentError(
  surfaceSize: RenderGraphCompileOptions['surfaceSize'],
): RenderGraphError | undefined {
  if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'surfaceSize width and height are positive integers',
      hint: 'compile after the render surface has a non-zero physical extent',
      detail: {
        resourceLabel: 'surface',
        field: 'surfaceSize',
        expected: 'width > 0 and height > 0',
        actual: `${surfaceSize.width}x${surfaceSize.height}`,
      },
    });
  }
  return undefined;
}

function uninitializedRead(
  label: string,
  passName: string,
  usage: GraphAccessUsage,
): RenderGraphError {
  return new RenderGraphError({
    code: 'uninitialized-read',
    expected: `graph-created resource '${label}' is written before pass '${passName}' reads it`,
    hint: 'add a clear/write/copy-dst pass before the first read, or import initialized data',
    detail: { passName, resourceLabel: label, usage },
  });
}

const STORAGE_BUFFER_CAP = 1;
const STORAGE_TEXTURE_CAP = 2;
const INDIRECT_CAP = 4;
const RAY_QUERY_CAP = 8;
const ACCESS_CAPABILITIES = {
  [STORAGE_BUFFER_CAP]: 'storage-buffer',
  [STORAGE_TEXTURE_CAP]: 'storage-texture',
  [INDIRECT_CAP]: 'indirect',
  [RAY_QUERY_CAP]: 'ray-query',
} as const;

function operandCapability(
  access: NormalizedAccess,
  kind: ResourceRecord<unknown>['kind'] | undefined,
) {
  switch (access.usage) {
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return kind === 'buffer' ? STORAGE_BUFFER_CAP : kind === 'texture' ? STORAGE_TEXTURE_CAP : 0;
    case 'sampled-storage-read-write':
    case 'sampled-storage-write':
      return kind === 'texture' ? STORAGE_TEXTURE_CAP : 0;
    case 'indirect-read':
      return INDIRECT_CAP;
    case 'acceleration-structure-read':
    case 'acceleration-structure-build':
      return RAY_QUERY_CAP;
    default:
      return 0;
  }
}

function bufferUsage(access: GraphBufferAccess): number {
  switch (access) {
    case 'uniform-read':
      return BUFFER_USAGE.uniform;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return BUFFER_USAGE.storage;
    case 'indirect-read':
      return BUFFER_USAGE.indirect;
    case 'vertex-read':
      return BUFFER_USAGE.vertex;
    case 'index-read':
      return BUFFER_USAGE.index;
    case 'copy-src':
      return BUFFER_USAGE.copySrc;
    case 'copy-dst':
      return BUFFER_USAGE.copyDst;
  }
}

function textureUsage(access: GraphTextureAccess): number {
  switch (access) {
    case 'sampled-read':
      return TEXTURE_USAGE.textureBinding;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return TEXTURE_USAGE.storageBinding;
    case 'sampled-storage-read-write':
    case 'sampled-storage-write':
      return TEXTURE_USAGE.storageBinding | TEXTURE_USAGE.textureBinding;
    case 'color-attachment':
    case 'depth-stencil-read':
    case 'depth-stencil-write':
      return TEXTURE_USAGE.renderAttachment;
    case 'copy-src':
      return TEXTURE_USAGE.copySrc;
    case 'copy-dst':
      return TEXTURE_USAGE.copyDst;
  }
}

export class RenderGraphBuilder<FrameCtx extends RenderGraphFrame> {
  private consumerReadGroups?: Map<
    string,
    {
      reads: GraphAccess[];
      readonly roles: Map<GraphAccess['resource'], number>;
    }
  >;
  /** Share the exact graph handle with a later native consumer pass. This is
   * topology metadata, not a second resource allocation or execution callback. */
  publishConsumerRead(
    group: string,
    resource: GraphBuffer | GraphTextureView,
    usage: 'vertex-read' | 'sampled-read',
  ): Result<void, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(resource);
    if (data?.owner !== this.owner) return err(this.foreignHandleError());
    this.consumerReadGroups ??= new Map();
    const groups = this.consumerReadGroups;
    let current = groups.get(group);
    if (current === undefined) {
      current = { reads: [], roles: new Map() };
      groups.set(group, current);
    }
    const role = consumerReadRole(usage);
    const prior = current.roles.get(resource) ?? 0;
    if ((prior & role) === 0) {
      if (Object.isFrozen(current.reads)) current.reads = current.reads.slice();
      current.reads.push(Object.freeze({ resource, usage }) as GraphAccess);
      current.roles.set(resource, prior | role);
    }
    return ok(undefined);
  }

  consumerReads(group: string): readonly GraphAccess[] {
    const current = this.consumerReadGroups?.get(group);
    return current === undefined ? NO_CONSUMER_READS : Object.freeze(current.reads);
  }

  /** Merge a published group into the consumer's own pass, preserving both declaration orders. */
  appendConsumerReads(group: string, accesses: GraphAccess[]): void {
    const reads = this.consumerReadGroups?.get(group)?.reads;
    if (reads === undefined) return;
    let present: Map<GraphAccess['resource'], number> | undefined;
    for (const access of accesses) {
      const role = consumerReadRole(access.usage);
      if (role === 0) continue;
      present ??= new Map();
      present.set(access.resource, (present.get(access.resource) ?? 0) | role);
    }
    // The producer has already admitted each (resource, role) pair exactly once.
    for (const read of reads)
      if (((present?.get(read.resource) ?? 0) & consumerReadRole(read.usage)) === 0)
        accesses.push(read);
  }

  private readonly owner = Object.freeze({});
  private slotsByLabel: Map<string, number> | undefined = new Map();
  private physical: PhysicalGraphSlots<FrameCtx> | undefined = new PhysicalGraphSlots<FrameCtx>();

  private declare(slot: CompiledResource<FrameCtx> | CompiledView<FrameCtx>): void {
    if (this.physical === undefined) throw this.sealedError();
    this.physical.insert(slot);
    const ordered = this.ordered;
    if (ordered === undefined) return;
    if ('kind' in slot) {
      ordered.resourceError ??= this.prepareResourceShape(slot, ordered.surfaceSize);
    } else {
      ordered.viewError ??= this.viewDimensionError(slot);
    }
  }

  private resourceAt(id: number): CompiledResource<FrameCtx> | undefined {
    return this.physical?.resource(id);
  }

  private viewAt(id: number): CompiledView<FrameCtx> | undefined {
    return this.physical?.view(id);
  }
  private deferredPasses?: PassDeclaration<FrameCtx>[] | undefined;
  /** Only automatic attachment stores and overwritten resolves need their future uses. */
  private placements?: Map<number, AttachmentSlots | undefined>;
  private bindings: BindingOptions | undefined;
  private ordered:
    | {
        readonly program: PassStream<FrameCtx>;
        readonly operands: NormalizedAccess[];
        readonly surfaceSize: BindingOptions['surfaceSize'];
        resourceError: RenderGraphError | undefined;
        viewError?: RenderGraphError | undefined;
      }
    | undefined;

  /** The stock procedure emits checked physical operands on append. An authored
   * pipeline may defer that analysis until all declarations arrive. Both borrow
   * only active physical bindings from their source and drop them after binding. */
  static procedure<Frame extends RenderGraphFrame>(
    options: RenderGraphCompileOptions,
    mode: 'ordered' | 'deferred' = 'ordered',
  ) {
    const passes = new RenderGraphBuilder<Frame>();
    passes.bindings = bindingOptions(options);
    if (mode === 'ordered') passes.beginOrdered(passes.bindings);
    return { passes, bindResources: () => passes.bindResources() };
  }

  /** Bind a built-in display's emitted stream directly to its device. */
  static orderedView<Frame extends RenderGraphFrame>(options: RenderGraphCompileOptions) {
    const passes = new RenderGraphBuilder<Frame>();
    passes.bindings = bindingOptions(options);
    passes.beginOrdered(passes.bindings);
    return { passes, bindResources: () => passes.bindOrderedView() };
  }

  private beginOrdered(options: BindingOptions): void {
    this.ordered = {
      program: this.passStream(options),
      operands: [],
      surfaceSize: options.surfaceSize,
      resourceError: surfaceExtentError(options.surfaceSize),
    };
  }

  private bindResources(): Result<BoundRenderGraphRecording<FrameCtx>, RenderGraphError> {
    return this.bindings === undefined ? err(this.sealedError()) : this.finish(this.bindings);
  }

  private bindOrderedView(): Result<BoundRenderGraphRecording<FrameCtx>, RenderGraphError> {
    const { bindings, slotsByLabel, physical, ordered } = this;
    if (
      bindings === undefined ||
      slotsByLabel === undefined ||
      physical === undefined ||
      ordered === undefined
    )
      return err(this.sealedError());
    this.slotsByLabel = undefined;
    try {
      const error = ordered.resourceError ?? ordered.viewError ?? this.snapshotError;
      if (error !== undefined) return err(error);
      const result = this.bindPhysicalRecording(bindings, slotsByLabel, physical, ordered.program);
      if (result.ok) orderedViewBindCount++;
      return result;
    } finally {
      this.releaseDeclarationStorage();
    }
  }

  private snapshotError: RenderGraphError | undefined;
  private invalidImport: ImportWithUsage<FrameCtx> | undefined;
  private readonly passLocalFirstUses: number[] = [];
  private rasterCandidates: RasterBatchCandidates<FrameCtx> | undefined =
    new RasterBatchCandidates<FrameCtx>();
  private readonly passNames = new Set<string>();
  private lastSubgraph = -1;
  private get nextId(): number {
    return this.physical?.addressCount || 1;
  }
  private addressWordCount = 0;
  private get sealed(): boolean {
    return this.slotsByLabel === undefined;
  }

  createTexture(
    label: string,
    descriptor: GraphTextureDescriptor,
  ): Result<GraphTexture, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    this.declare({
      id,
      label,
      kind: 'texture',
      origin: 'created',
      descriptor: snapshotTextureDescriptor(descriptor),
      usage: descriptor.usage ?? 0,
      firstUse: null,
      lastUse: null,
    });
    return ok(textureHandle(this.owner, id));
  }

  importTexture(
    label: string,
    descriptor: ImportedTextureDescriptor,
    resolve: (frame: FrameCtx) => Texture,
    native?: import('./types.js').NativeTextureImport,
  ): Result<GraphTexture, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    this.declare({
      id,
      label,
      kind: 'texture',
      origin: 'imported',
      descriptor: snapshotTextureDescriptor(descriptor),
      usage: 0,
      firstUse: null,
      lastUse: null,
      resolve,
      ...(native === undefined
        ? {}
        : {
            native: Object.freeze({
              prepare: native.prepare.bind(native),
              current: native.current.bind(native),
              ...(native.resolvedExtent === undefined
                ? {}
                : { resolvedExtent: native.resolvedExtent.bind(native) }),
            }),
          }),
    });
    return ok(textureHandle(this.owner, id));
  }

  /** Independent graph storage with the source's exact allocation descriptor. */
  createTextureLike(
    label: string,
    source: GraphTexture,
    sampleCount?: 1 | 4,
  ): Result<GraphTexture, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(source);
    if (data?.kind !== 'texture' || data.owner !== this.owner)
      return err(this.foreignHandleError());
    const record = this.resourceAt(data.id);
    if (record?.kind !== 'texture') return err(this.foreignHandleError());
    if (record.origin === 'imported' && record.native?.resolvedExtent !== undefined)
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'a graph-created image has a fixed allocation descriptor',
          hint: 'allocate the corresponding destination from the current owner extent',
          detail: { resourceLabel: label, field: 'size', expected: 'fixed source extent' },
        }),
      );
    return this.createTexture(
      label,
      sampleCount === undefined ? record.descriptor : { ...record.descriptor, sampleCount },
    );
  }

  createBuffer(
    label: string,
    descriptor: GraphBufferDescriptor,
  ): Result<GraphBuffer, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    this.declare({
      id,
      label,
      kind: 'buffer',
      origin: 'created',
      descriptor: Object.freeze({ ...descriptor }),
      usage: 0,
      firstUse: null,
      lastUse: null,
    });
    return ok(bufferHandle(this.owner, id));
  }

  importBuffer(
    label: string,
    descriptor: ImportedBufferDescriptor,
    resolve: (frame: FrameCtx) => Buffer,
  ): Result<GraphBuffer, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    this.declare({
      id,
      label,
      kind: 'buffer',
      origin: 'imported',
      descriptor: Object.freeze({ ...descriptor }),
      usage: 0,
      firstUse: null,
      lastUse: null,
      resolve,
    });
    return ok(bufferHandle(this.owner, id));
  }

  importAccelerationStructure(
    label: string,
    descriptor: ImportedAccelerationStructureDescriptor,
    resolve: (frame: FrameCtx) => Tlas,
  ): Result<GraphAccelerationStructure, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    this.declare({
      id,
      label,
      kind: 'acceleration-structure',
      origin: 'imported',
      descriptor: Object.freeze({ ...descriptor }),
      usage: 0,
      firstUse: null,
      lastUse: null,
      resolve,
    });
    return ok(accelerationStructureHandle(this.owner, id));
  }

  view(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor = {},
  ): Result<GraphTextureView, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resourceAt(data.id);
    if (textureRecord?.kind !== 'texture') return err(this.foreignHandleError());
    return this.declareView(textureRecord, descriptor);
  }

  importView(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor,
    resolve: ImportedTextureViewResolver<FrameCtx>,
  ): Result<GraphTextureView, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resourceAt(data.id);
    if (textureRecord?.kind !== 'texture' || textureRecord.origin !== 'imported') {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'an imported view belongs to an imported texture',
          hint: 'use view() for graph-created textures and importView() for host-owned views',
          detail: {
            resourceLabel: textureRecord?.label ?? 'foreign',
            field: 'origin',
            expected: 'imported',
            actual: textureRecord?.origin ?? 'foreign',
          },
        }),
      );
    }
    return this.declareView(textureRecord, descriptor, resolve);
  }

  private declareView(
    texture: Extract<CompiledResource<FrameCtx>, { kind: 'texture' }>,
    descriptor: GraphTextureViewDescriptor,
    resolve?: ImportedTextureViewResolver<FrameCtx>,
  ): Result<GraphTextureView, RenderGraphError> {
    const label = descriptor.label ?? `${texture.label}.view.${this.nextId}`;
    if (
      texture.origin === 'imported' &&
      texture.native?.resolvedExtent !== undefined &&
      (resolve === undefined ||
        (texture.descriptor.mipLevelCount ?? 1) !== 1 ||
        (descriptor.baseMipLevel ?? 0) !== 0 ||
        (descriptor.mipLevelCount ?? 1) !== 1 ||
        (descriptor.baseArrayLayer ?? 0) !== 0 ||
        descriptor.arrayLayerCount !== undefined)
    ) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'an owner-sized image exposes its complete single-mip imported view',
          hint: 'record physical attachment slices inside the owner pass',
          detail: { resourceLabel: label, field: 'view', expected: 'whole imported texture view' },
        }),
      );
    }
    const unique = this.reserveLabel(label);
    if (unique !== undefined) return err(unique);
    const id = this.nextId;
    const captured = Object.freeze({ ...descriptor });
    this.declare({
      id,
      label,
      textureId: texture.id,
      descriptor: captured,
      range: Object.freeze(viewAccessRange(texture.descriptor, captured)),
      resolve,
    });
    texture.firstView ??= id;
    return ok(textureViewHandle(this.owner, id, texture.id));
  }

  /** A transfer gives the graph exclusive ownership of all descriptor data and callbacks. */
  addRasterPass(
    name: string,
    descriptor: RasterGraphPass<FrameCtx>,
    ownership?: 'transfer',
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'raster', descriptor }, ownership);
  }

  addComputePass(
    name: string,
    descriptor: ComputeGraphPass<FrameCtx>,
    ownership?: 'transfer',
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'compute', descriptor }, ownership);
  }

  addCopyPass(
    name: string,
    descriptor: CopyGraphPass<FrameCtx>,
    ownership?: 'transfer',
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'copy', descriptor }, ownership);
  }

  addSubgraphPass(
    name: string,
    descriptor: SubgraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'subgraph', descriptor });
  }

  compile(
    options: RenderGraphCompileOptions,
  ): Result<CompiledRenderGraph<FrameCtx>, RenderGraphError> {
    if (this.bindings !== undefined)
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'bind the resources of the active procedure',
          hint: 'call bindResources on the procedure that owns the device and surface',
          detail: {
            resourceLabel: 'active procedure',
            field: 'compile',
            expected: 'bindResources',
          },
        }),
      );
    return this.finish(bindingOptions(options));
  }

  private finish(
    options: BindingOptions,
  ): Result<BoundRenderGraphRecording<FrameCtx>, RenderGraphError> {
    const labels = this.slotsByLabel;
    const physical = this.physical;
    if (labels === undefined || physical === undefined) return err(this.sealedError());
    this.slotsByLabel = undefined;
    try {
      const result = this.compileDeclarations(options, labels, physical);
      if (result.ok) compileCount++;
      return result;
    } finally {
      this.releaseDeclarationStorage();
    }
  }

  private releaseDeclarationStorage(): void {
    // Callbacks and external inspection may keep a sealed builder alive.
    // The recording now owns the physical records and their label map.
    if (this.consumerReadGroups !== undefined)
      for (const group of this.consumerReadGroups.values()) group.roles.clear();
    this.physical = undefined;
    this.deferredPasses = undefined;
    this.placements?.clear();
    this.passLocalFirstUses.length = 0;
    this.passNames.clear();
    this.rasterCandidates = undefined;
    this.snapshotError = undefined;
    this.invalidImport = undefined;
    this.ordered = undefined;
    this.bindings = undefined;
  }

  private compileDeclarations(
    options: BindingOptions,
    labels: Map<string, number>,
    physical: PhysicalGraphSlots<FrameCtx>,
  ): Result<BoundRenderGraphRecording<FrameCtx>, RenderGraphError> {
    const ordered = this.ordered;
    const invalidShape =
      ordered === undefined
        ? this.preparePhysicalShapes(physical, options.surfaceSize)
        : (ordered.resourceError ?? ordered.viewError);
    if (invalidShape !== undefined) return err(invalidShape);
    if (this.snapshotError !== undefined) return err(this.snapshotError);
    let program = ordered?.program;
    if (program === undefined) {
      program = this.passStream(options);
      for (const { record, accesses, requiredCaps } of this.deferredPasses ?? NO_DEFERRED_PASSES) {
        const failure = program.append(record, accesses, requiredCaps);
        if (failure !== undefined) return err(failure);
      }
    }
    return this.bindPhysicalRecording(options, labels, physical, program);
  }

  private bindPhysicalRecording(
    options: BindingOptions,
    labels: Map<string, number>,
    physical: PhysicalGraphSlots<FrameCtx>,
    program: PassStream<FrameCtx>,
  ): Result<BoundRenderGraphRecording<FrameCtx>, RenderGraphError> {
    const analyzed = program.finish(physical, this.invalidImport);
    if (!analyzed.ok) return analyzed;

    const passes = analyzed.value.passes;
    const resources = new BoundGraphResources<FrameCtx>();
    const allocated = this.allocate(physical, options, resources);
    if (!allocated.ok) return allocated;
    const rasterBatches = planRasterBatches(passes, this.rasterCandidates?.finish());

    return ok(
      new CompiledRenderGraphImpl(
        allocateRenderPassGeneration(),
        this.owner,
        options.device,
        physical,
        resources,
        labels,
        analyzed.value.accessIds,
        Object.freeze(passes),
        analyzed.value.preparations,
        analyzed.value.hasSubgraph,
        rasterBatches,
      ),
    );
  }

  private addPass(
    name: string,
    pass: GraphPass<FrameCtx>,
    ownership?: 'transfer',
  ): Result<void, RenderGraphError> {
    if (this.sealed) return err(this.sealedError());
    if (this.passNames.has(name)) {
      return err(
        new RenderGraphError({
          code: 'duplicate-pass-name',
          expected: `pass name '${name}' is unique within one builder`,
          hint: `rename the second '${name}' pass; names are diagnostics, not identity`,
          detail: { passName: name },
        }),
      );
    }
    for (const access of pass.descriptor.accesses) {
      const valid = this.validateAccessHandle(name, access);
      if (valid !== undefined) return err(valid);
    }
    const captured = ownership === 'transfer' ? pass : snapshotPass(pass);
    if (captured.kind !== 'subgraph') {
      const { encode, encodeDirect } = captured.descriptor;
      if (
        (encode !== undefined && typeof encode !== 'function') ||
        (encodeDirect !== undefined && typeof encodeDirect !== 'function') ||
        (typeof encode === 'function') === (typeof encodeDirect === 'function')
      )
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'exactly one encode or encodeDirect callback',
            hint: 'choose the context form or direct encoder/frame/resources arguments',
            detail: {
              resourceLabel: name,
              field: 'encode',
              expected: 'exactly one encoding callback',
            },
          }),
        );
    }
    const id = this.passNames.size;
    const record = {
      id,
      name,
      pass: captured,
      accessStart: 0,
      accessEnd: 0,
      textureWrites: NO_TEXTURE_WRITES,
    };
    const accesses = this.ordered?.operands ?? [];
    let requiredCaps = 0;
    for (const access of captured.descriptor.accesses) {
      const normalized = this.normalizeAccess(record, access);
      if (normalized instanceof RenderGraphError) {
        // An accessor can change its handle between admission and descriptor capture.
        this.snapshotError ??= normalized;
        break;
      }
      const resource = this.resourceAt(normalized.resourceId);
      if (resource === undefined) {
        this.snapshotError ??= this.foreignHandleError(name);
        break;
      }
      if (
        resource.kind === 'texture' &&
        resource.origin === 'imported' &&
        resource.native?.resolvedExtent !== undefined &&
        captured.kind !== 'subgraph' &&
        normalized.usage !== 'sampled-read' &&
        normalized.usage !== 'copy-src'
      ) {
        this.snapshotError ??= new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'ordinary consumers sample or copy the owner-sized image',
          hint: 'record shape-dependent attachments or writes with their physical producer',
          detail: {
            resourceLabel: resource.label,
            field: 'usage',
            expected: 'sampled-read or copy-src',
            actual: normalized.usage,
          },
        });
      }
      requiredCaps |= operandCapability(normalized, resource?.kind);
      const usage =
        resource.kind === 'buffer'
          ? bufferUsage(normalized.usage as GraphBufferAccess)
          : resource.kind === 'texture'
            ? textureUsage(normalized.usage as GraphTextureAccess)
            : 0;
      this.recordResourceUse(resource, record, normalized, usage, accesses);
      accesses.push(normalized);
      this.addressWordCount += normalized.viewId === undefined ? 1 : 2;
    }
    this.passNames.add(name);
    if (captured.kind === 'subgraph') this.lastSubgraph = id;
    if (captured.kind === 'raster') {
      this.rasterCandidates?.append(id, captured.descriptor);
      this.addressWordCount += 1 + 2 * captured.descriptor.colorAttachments.length;
      for (const attachment of captured.descriptor.colorAttachments) {
        if (attachment.resolveTarget !== undefined && captured.descriptor.executeIf === undefined)
          this.recordColorResolve(
            id,
            attachment.resolveTarget,
            captured.descriptor.accesses,
            accesses,
          );
        if (attachment.storeOp === 'auto') {
          this.placements ??= new Map();
          this.placements.set(id, undefined);
        }
        if (attachment.loadOp === 'clear' && captured.descriptor.executeIf === undefined) {
          const data = handleData(attachment.view);
          if (data?.kind !== 'texture-view') continue;
          const use = this.resourceAt(data.textureId);
          if (
            use?.firstUse !== id ||
            use.lastAccess === undefined ||
            !privateSamples(this.resourceAt(data.textureId))
          )
            continue;
          const access = accesses[use.lastAccess];
          if (
            access?.usage === 'color-attachment' &&
            !access.repeatedColorAccess &&
            captured.descriptor.accesses[use.lastAccess]?.resource === attachment.view
          )
            use.firstClear = data.id;
        }
      }
    }
    if (this.ordered !== undefined) {
      this.snapshotError ??= this.ordered.program.append(record, accesses, requiredCaps);
      accesses.length = 0;
    } else {
      this.deferPass(record, accesses, requiredCaps);
    }
    return ok(undefined);
  }

  private deferPass(
    record: RecordingPass<FrameCtx>,
    accesses: NormalizedAccess[],
    requiredCaps: number,
  ): void {
    this.deferredPasses ??= [];
    this.deferredPasses.push({ record, accesses, requiredCaps });
  }

  private recordResourceUse(
    resource: CompiledResource<FrameCtx>,
    pass: PassRecord<FrameCtx>,
    access: NormalizedAccess,
    usage: number,
    operands: readonly NormalizedAccess[],
  ): void {
    const { id, pass: declaration } = pass;
    if (
      resource.firstUse === null &&
      resource.kind === 'texture' &&
      resource.origin === 'created' &&
      resource.descriptor.lifetime === 'pass-local' &&
      declaration.kind !== 'subgraph' &&
      declaration.descriptor.executeIf === undefined
    )
      this.passLocalFirstUses.push(resource.id);
    if (resource.resolvedView !== undefined) {
      if (
        resource.resolvedView === access.viewId &&
        resource.lastUse !== null &&
        resource.lastUse > this.lastSubgraph
      )
        access.precedingResolve = resource.lastUse;
      resource.resolvedView = undefined;
    }
    this.addResourceUsage(resource, usage);
    resource.firstUse ??= id;
    if (resource.lastUse === id && resource.lastAccess !== undefined) {
      if (access.usage === 'color-attachment') access.repeatedColorAccess = true;
      const sibling = operands[resource.lastAccess];
      if (sibling !== undefined) {
        sibling.nextOfResource = operands.length;
        access.resourceFollower = true;
      }
    }
    resource.lastUse = id;
    resource.lastAccess = operands.length;
  }

  private addResourceUsage(resource: CompiledResource<FrameCtx>, flags: number): void {
    const usage = resource.usage | flags;
    if (usage === resource.usage) return;
    resource.usage = usage;
    if (resource.origin === 'created') {
      if (resource.textureShape !== undefined) resource.textureShape.descriptor.usage = usage;
      return;
    }
    if (
      resource.kind !== 'acceleration-structure' &&
      (usage & resource.descriptor.usage) !== usage &&
      (this.invalidImport === undefined || this.invalidImport.id > resource.id)
    )
      this.invalidImport = resource;
  }

  /** A resolve may replace only an unobserved write to the same private view.
   * The ordinary resource access walk has already identified its sole use and prior writer. */
  private recordColorResolve(
    pass: number,
    view: GraphTextureView,
    declared: readonly GraphAccess[],
    normalized: readonly NormalizedAccess[],
  ): void {
    const data = handleData(view);
    if (data?.kind !== 'texture-view' || this.resourceAt(data.textureId)?.origin !== 'created')
      return;
    const use = this.resourceAt(data.textureId);
    if (use?.lastUse !== pass || use.lastAccess === undefined) return;
    const access = normalized[use.lastAccess];
    if (
      access?.usage !== 'color-attachment' ||
      access.repeatedColorAccess ||
      declared[use.lastAccess]?.resource !== view
    )
      return;
    use.resolvedView = data.id;
    if (access.precedingResolve === undefined) return;
    const previous = access.precedingResolve;
    this.placements ??= new Map();
    this.placements.set(previous, addAttachmentSlot(this.placements.get(previous), data.textureId));
  }

  private validateAccessHandle(
    passName: string,
    access: GraphAccess,
  ): RenderGraphError | undefined {
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return this.foreignHandleError(passName);
    }
    if (data.kind === 'texture-view') {
      if (this.viewAt(data.id) === undefined) return this.foreignHandleError(passName);
      return undefined;
    }
    if (
      (data.kind !== 'buffer' && data.kind !== 'acceleration-structure') ||
      this.resourceAt(data.id) === undefined
    ) {
      return this.foreignHandleError(passName);
    }
    return undefined;
  }

  /** Both graph declarations and built-in procedures issue the same checked operand stream. */
  private passStream(options: BindingOptions): PassStream<FrameCtx> {
    const compiledPasses: CompiledPass<FrameCtx>[] = [];
    const preparations: PassResourcePreparation[] = [];
    let hasSubgraph = false;
    let accessIds = new Uint32Array(this.addressWordCount);
    const scope: ScopeWorkspace = {};
    const colorBindings = new Map<GraphTextureView, number>();
    let accessEnd = 0;
    const initializedBuffers: number[] = [];
    const contentRanges: (GraphTextureContentRange[] | undefined)[] = [];
    // Each inherited cell either has its first use verified on execution, or is replaced
    // by a local write. No later pass replays the preceding write history.
    const inheritedRanges: (GraphTextureContentRange[] | undefined)[] = [];
    const prior = options.previous;
    // Later operands determine the complete allocation signature. Until bind, only
    // first reads of cells left untouched by this procedure can require prior bytes.
    const beginTexture = (texture: TextureSlot<FrameCtx>): void => {
      if (
        contentRanges[texture.id] !== undefined ||
        prior === undefined ||
        texture.origin !== 'created' ||
        texture.descriptor.lifetime !== 'persistent'
      )
        return;
      const whole = viewAccessRange(texture.descriptor, {});
      contentRanges[texture.id] = [whole];
      inheritedRanges[texture.id] = [whole];
    };

    const readTextureRange = (
      resource: CompiledResource<FrameCtx>,
      access: NormalizedAccess,
      range: GraphTextureContentRange,
      passName: string,
    ): boolean => {
      const id = resource.id;
      const committed = contentRanges[id];
      if (committed === undefined || !textureRangeCovered(range, committed)) return false;
      const inherited = inheritedRanges[id];
      if (inherited !== undefined && inherited.length !== 0) {
        let reads = resource.inheritedTextureReads;
        const firstRead = reads?.length ?? 0;
        for (const cell of inherited) {
          const dependency = intersectTextureRange(cell, range);
          if (dependency === undefined) continue;
          reads ??= [];
          reads.push({ range: dependency, passName, usage: access.usage });
        }
        if (reads !== undefined && reads.length !== firstRead) {
          resource.inheritedTextureReads = reads;
          applyTextureContentWrite(inherited, range, false);
        }
      }
      return true;
    };

    let textureWrites: CompiledPass<FrameCtx>['textureWrites'][number][] | undefined;
    const writeTextureRange = (
      texture: TextureSlot<FrameCtx>,
      range: GraphTextureContentRange,
      stored: boolean,
    ) => {
      const id = texture.id;
      if (texture.origin === 'created') {
        beginTexture(texture);
        contentRanges[id] ??= [];
        applyTextureContentWrite(contentRanges[id], range, stored);
        const inherited = inheritedRanges[id];
        if (inherited !== undefined && inherited.length !== 0)
          applyTextureContentWrite(inherited, range, false);
      }
      if (texture.origin === 'imported' || texture.descriptor.lifetime === 'persistent') {
        textureWrites ??= [];
        textureWrites.push({ texture, range, stored });
      }
    };

    const writeAttachments = (pass: CompiledPass<FrameCtx>, at: number): number => {
      if (pass.pass.kind !== 'raster') return at;
      const descriptor = pass.pass.descriptor;
      accessIds[at++] = handleData(descriptor.depthStencilAttachment?.view)?.id ?? 0;
      for (const color of descriptor.colorAttachments) {
        accessIds[at++] = handleData(color.view)?.id ?? 0;
        accessIds[at++] = handleData(color.resolveTarget)?.id ?? 0;
      }
      return at;
    };
    const append: PassStream<FrameCtx>['append'] = (pass, normalized, requiredCaps) => {
      if (accessIds.length < this.addressWordCount) {
        const next = new Uint32Array(Math.max(this.addressWordCount, 32, accessIds.length * 2));
        next.set(accessIds);
        accessIds = next;
      }
      const capability = this.validateCapabilities(
        pass,
        options.device.caps,
        requiredCaps,
        normalized,
      );
      if (capability !== undefined) return capability;
      const accessStart = accessEnd;
      for (const item of normalized) {
        accessIds[accessEnd++] = item.resourceId;
        if (item.viewId !== undefined) accessIds[accessEnd++] = item.viewId;
      }
      if (accessEnd - accessStart > LINEAR_PASS_ACCESS_LIMIT)
        accessIds.subarray(accessStart, accessEnd).sort();
      const conflict = this.validatePassAccesses(pass, normalized, scope);
      if (conflict !== undefined) return conflict;
      const attachments = this.bindRasterAttachments(pass, normalized, colorBindings);
      if (attachments !== undefined) return attachments;

      for (const current of normalized) {
        if (!current.read) continue;
        const resource = this.resourceAt(current.resourceId);
        if (resource?.origin !== 'created') continue;
        let initialized: boolean;
        let range = current.range;
        if (range === undefined) initialized = initializedBuffers[current.resourceId] === 1;
        else {
          if (resource.kind === 'texture') beginTexture(resource);
          // Color clear/resolve was classified as write-only on admission. Only mixed
          // depth/stencil can narrow a read to part of the declared view.
          let second: GraphTextureContentRange | undefined;
          const depth =
            pass.pass.kind === 'raster' && current.usage === 'depth-stencil-write'
              ? pass.pass.descriptor.depthStencilAttachment
              : undefined;
          if (depth !== undefined && handleData(depth.view)?.id === current.viewId) {
            const depthLoad = mayLoadAttachment(depth.depthLoadOp);
            const stencilLoad = mayLoadAttachment(depth.stencilLoadOp);
            if (
              range.aspect === 'all' &&
              resource.kind === 'texture' &&
              DEPTH_STENCIL_FORMATS.has(resource.descriptor.format)
            ) {
              if (!depthLoad && !stencilLoad) continue;
              if (depthLoad && stencilLoad) second = { ...range, aspect: 'stencil-only' };
              range = { ...range, aspect: depthLoad ? 'depth-only' : 'stencil-only' };
            } else if (!(range.aspect === 'stencil-only' ? stencilLoad : depthLoad)) continue;
          }
          initialized =
            readTextureRange(resource, current, range, pass.name) &&
            (second === undefined || readTextureRange(resource, current, second, pass.name));
        }
        if (!initialized) return uninitializedRead(resource.label, pass.name, current.usage);
      }

      // Publish only after every read in this pass has been checked.
      textureWrites = undefined;
      for (const access of normalized) {
        if (!access.write) continue;
        const id = access.resourceId;
        const range = access.range;
        if (range === undefined) {
          initializedBuffers[id] = 1;
          continue;
        }
        if (pass.pass.kind === 'subgraph') continue;
        const texture = this.resourceAt(id);
        if (texture?.kind !== 'texture') continue;
        this.publishTextureAccess(pass, access, texture, range, writeTextureRange);
      }

      pass.accessStart = accessStart;
      pass.accessEnd = accessEnd;
      pass.textureWrites =
        textureWrites === undefined ? NO_TEXTURE_WRITES : Object.freeze(textureWrites);
      compiledPasses.push(pass);
      hasSubgraph ||= pass.pass.kind === 'subgraph';
      const descriptor = pass.pass.descriptor;
      const { prepareResources, preparedResourcesCurrent } = descriptor;
      if (prepareResources !== undefined || preparedResourcesCurrent !== undefined) {
        preparations.push({
          name: pass.name,
          kind: pass.pass.kind,
          accessStart: pass.accessStart,
          accessEnd: pass.accessEnd,
          prepareResources,
          preparedResourcesCurrent: preparedResourcesCurrent?.bind(descriptor),
        });
      }
      accessEnd = writeAttachments(pass, accessEnd);
      return undefined;
    };

    const finish = (
      physical: PhysicalGraphSlots<FrameCtx>,
      invalidImport: ImportWithUsage<FrameCtx> | undefined,
    ): Result<PhysicalPassProgram<FrameCtx>, RenderGraphError> => {
      if (invalidImport !== undefined) return err(invalidImportUsage(invalidImport));
      // Future users can alter only auto-stores and unobserved resolves. Their
      // attachment operands are the only portion of an emitted pass that needs patching.
      if (this.placements !== undefined)
        for (const [id, omitted] of this.placements) {
          const placed = placeColorAttachments(
            compiledPasses[id] as CompiledPass<FrameCtx>,
            omitted,
            physical,
            this.lastSubgraph,
          );
          compiledPasses[id] = placed;
          writeAttachments(placed, placed.accessEnd);
        }
      return ok({
        passes: compiledPasses,
        preparations,
        hasSubgraph,
        accessIds,
      });
    };
    return { append, finish };
  }

  private publishTextureAccess(
    pass: PassRecord<FrameCtx>,
    access: NormalizedAccess,
    texture: TextureSlot<FrameCtx>,
    range: GraphTextureContentRange,
    store: (
      texture: TextureSlot<FrameCtx>,
      range: GraphTextureContentRange,
      stored: boolean,
    ) => void,
  ): void {
    if (
      pass.pass.kind !== 'raster' ||
      (access.usage !== 'color-attachment' && access.usage !== 'depth-stencil-write')
    ) {
      store(texture, range, true);
      return;
    }
    if (access.usage === 'color-attachment') {
      if (access.colorStore !== undefined) store(texture, range, access.colorStore);
      return;
    }
    const depth = pass.pass.descriptor.depthStencilAttachment;
    if (depth === undefined || handleData(depth.view)?.id !== access.viewId) return;
    if (range.aspect === 'all' && DEPTH_STENCIL_FORMATS.has(texture.descriptor.format)) {
      store(texture, { ...range, aspect: 'depth-only' }, depth.depthStoreOp === 'store');
      store(texture, { ...range, aspect: 'stencil-only' }, depth.stencilStoreOp === 'store');
    } else {
      const op = range.aspect === 'stencil-only' ? depth.stencilStoreOp : depth.depthStoreOp;
      store(texture, range, op === 'store');
    }
  }

  private normalizeAccess(
    pass: PassRecord<FrameCtx>,
    access: GraphAccess,
  ): NormalizedAccess | RenderGraphError {
    const passName = pass.name;
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return this.foreignHandleError(passName);
    }
    // Raster colors acquire their load/store roles from the bound output slot at seal.
    const mode =
      pass.pass.kind === 'raster' && access.usage === 'color-attachment'
        ? accessMode(access.usage)
        : accessModeForPass(pass, access);
    if (data.kind === 'buffer' || data.kind === 'acceleration-structure') {
      if (this.resourceAt(data.id) === undefined) return this.foreignHandleError(passName);
      return {
        resourceId: data.id,
        usage: access.usage,
        read: mode.read,
        write: mode.write,
      };
    }
    if (data.kind !== 'texture-view') return this.foreignHandleError(passName);
    const view = this.viewAt(data.id);
    if (view === undefined || view.textureId !== data.textureId) {
      return this.foreignHandleError(passName);
    }
    return {
      resourceId: data.textureId,
      viewId: data.id,
      usage: access.usage,
      read: mode.read,
      write: mode.write,
      range: view.range,
    };
  }

  private validateCapabilities(
    pass: PassRecord<FrameCtx>,
    caps: RhiCaps,
    required: number,
    accesses: readonly NormalizedAccess[],
  ): RenderGraphError | undefined {
    if (
      pass.pass.kind === 'raster' &&
      pass.pass.descriptor.colorAttachments.length > caps.maxColorAttachments
    ) {
      return this.capabilityError(pass.name, 'color-attachments');
    }
    if (pass.pass.kind === 'compute' && !caps.compute) {
      return this.capabilityError(pass.name, 'compute');
    }
    let missing = 0;
    if ((required & STORAGE_BUFFER_CAP) !== 0 && !caps.storageBuffer) missing |= STORAGE_BUFFER_CAP;
    if ((required & STORAGE_TEXTURE_CAP) !== 0 && !caps.storageTexture)
      missing |= STORAGE_TEXTURE_CAP;
    if ((required & INDIRECT_CAP) !== 0 && !caps.indirectDrawing) missing |= INDIRECT_CAP;
    if ((required & RAY_QUERY_CAP) !== 0 && !caps.rayQuery.supported) missing |= RAY_QUERY_CAP;
    if (missing !== 0) {
      for (const access of accesses) {
        const cap = operandCapability(access, this.resourceAt(access.resourceId)?.kind);
        if (cap !== 0 && (missing & cap) !== 0)
          return this.capabilityError(pass.name, ACCESS_CAPABILITIES[cap], access);
      }
    }
    return undefined;
  }

  private capabilityError(
    passName: string,
    capability:
      | 'compute'
      | 'storage-buffer'
      | 'storage-texture'
      | 'indirect'
      | 'color-attachments'
      | 'ray-query',
    access?: NormalizedAccess,
  ): RenderGraphError {
    const resourceId = access?.resourceId;
    return new RenderGraphError({
      code: 'capability-missing',
      expected: `pass '${passName}' is built only when capability '${capability}' is available`,
      hint: 'select the fallback algorithm before adding this pass to the builder',
      detail: {
        passName,
        capability,
        ...(resourceId === undefined
          ? {}
          : { resourceLabel: this.resourceAt(resourceId)?.label, usage: access?.usage }),
      },
    });
  }

  private validatePassAccesses(
    pass: PassRecord<FrameCtx>,
    accesses: readonly NormalizedAccess[],
    scope: ScopeWorkspace,
  ): RenderGraphError | undefined {
    // A child has separately validated, ordered scopes rather than one GPU pass.
    if (pass.pass.kind === 'subgraph') return undefined;
    const conflict = firstScopeConflict(accesses, scope);
    if (conflict !== undefined) {
      const [left, right] = conflict;
      const label = this.resourceAt(left.resourceId)?.label;
      return new RenderGraphError({
        code: 'access-conflict',
        expected: `pass '${pass.name}' uses resource '${label}' in one compatible WebGPU usage scope`,
        hint: 'split conflicting read/write roles into ordered passes or use storage-read-write once',
        detail: {
          passName: pass.name,
          resourceLabel: label,
          accesses: [left.usage, right.usage],
        },
      });
    }
    if (pass.pass.kind !== 'compute') {
      const invalid = accesses.find((access) => access.usage === 'sampled-storage-write');
      if (invalid !== undefined) {
        return new RenderGraphError({
          code: 'access-conflict',
          expected: `pass '${pass.name}' uses ordered compute dispatches for sampled-storage-write`,
          hint: 'move the write-then-sample chain into a compute pass',
          detail: { passName: pass.name, usage: invalid.usage },
        });
      }
    }
    if (pass.pass.kind !== 'copy') {
      const invalid = accesses.find((access) => access.usage === 'acceleration-structure-build');
      if (invalid !== undefined) {
        return new RenderGraphError({
          code: 'access-conflict',
          expected: `pass '${pass.name}' builds acceleration structures only from a copy pass`,
          hint: 'record acceleration-structure-build in a copy pass ordered before its readers',
          detail: { passName: pass.name, usage: invalid.usage },
        });
      }
    }
    if (pass.pass.kind === 'copy') {
      const invalid = accesses.find(
        (access) =>
          access.usage !== 'copy-src' &&
          access.usage !== 'copy-dst' &&
          access.usage !== 'acceleration-structure-build',
      );
      if (invalid !== undefined) {
        return new RenderGraphError({
          code: 'access-conflict',
          expected: `copy pass '${pass.name}' declares only copy-src/copy-dst/acceleration-structure-build accesses`,
          hint: 'move shader or attachment work into raster/compute passes',
          detail: { passName: pass.name, usage: invalid.usage },
        });
      }
    }
    return undefined;
  }

  /** Match physical outputs to their declaring access once. The table belongs to
   * this seal, is reused across passes, and contains only the current color outputs.
   * Positive entries await a grant. Negative entries preserve the granted slot. */
  private bindRasterAttachments(
    pass: PassRecord<FrameCtx>,
    normalized: readonly NormalizedAccess[],
    colors: Map<GraphTextureView, number>,
  ): RenderGraphError | undefined {
    if (pass.pass.kind !== 'raster') return undefined;
    const { accesses, colorAttachments, depthStencilAttachment: depth } = pass.pass.descriptor;
    colors.clear();
    if (colorAttachments.length === 0 && depth === undefined) return undefined;
    for (const color of colorAttachments) {
      if (color.resolveTarget !== undefined) colors.set(color.resolveTarget, 1);
    }
    // A source takes precedence over a resolve to the same view. The first source
    // defines its load/store operations, including repeated attachment declarations.
    for (let i = colorAttachments.length - 1; i >= 0; i--)
      colors.set((colorAttachments[i] as (typeof colorAttachments)[number]).view, i + 2);
    const depthUsage = depth?.depthReadOnly === true ? 'depth-stencil-read' : 'depth-stencil-write';
    let depthGranted = false;
    for (let i = 0; i < normalized.length; i++) {
      const access = normalized[i] as NormalizedAccess;
      if (
        access.usage !== 'color-attachment' &&
        (depth === undefined || access.usage !== depthUsage)
      )
        continue;
      const view = (accesses[i] as GraphAccess).resource as GraphTextureView;
      if (access.usage === depthUsage && view === depth?.view) depthGranted = true;
      if (access.usage !== 'color-attachment') continue;
      const slot = colors.get(view);
      if (slot === undefined) continue;
      if (slot > 0) colors.set(view, -slot);
      const source = colorAttachments[Math.abs(slot) - 2];
      access.read = mayLoadAttachment(source?.loadOp);
      access.colorStore = source?.storeOp !== 'discard';
    }
    for (const color of colorAttachments) {
      if ((colors.get(color.view) ?? 0) >= 0)
        return this.missingAttachmentAccess(pass.name, color.view, 'color-attachment');
      if (color.resolveTarget !== undefined && (colors.get(color.resolveTarget) ?? 0) >= 0)
        return this.missingAttachmentAccess(pass.name, color.resolveTarget, 'color-attachment');
    }
    if (depth !== undefined && !depthGranted)
      return this.missingAttachmentAccess(pass.name, depth.view, depthUsage);
    return undefined;
  }

  private missingAttachmentAccess(
    passName: string,
    view: GraphTextureView,
    usage: GraphTextureAccess,
  ): RenderGraphError {
    const data = handleData(view);
    const label = data?.kind === 'texture-view' ? this.viewAt(data.id)?.label : undefined;
    return new RenderGraphError({
      code: 'resource-not-declared-by-pass',
      expected: `raster pass '${passName}' attachment '${label}' declares '${usage}' access`,
      hint: 'add the attachment view and matching usage to accesses',
      detail: { passName, resourceLabel: label, usage },
    });
  }

  private preparePhysicalShapes(
    physical: PhysicalGraphSlots<FrameCtx>,
    surfaceSize: BindingOptions['surfaceSize'],
  ): RenderGraphError | undefined {
    const invalidSurface = surfaceExtentError(surfaceSize);
    if (invalidSurface !== undefined) return invalidSurface;
    let viewError: RenderGraphError | undefined;
    for (const slot of physical.entries()) {
      if (slot === undefined) continue;
      if ('kind' in slot) {
        const invalid = this.prepareResourceShape(slot, surfaceSize);
        if (invalid !== undefined) return invalid;
      } else {
        viewError ??= this.viewDimensionError(slot);
      }
    }
    return viewError;
  }

  private prepareResourceShape(
    resource: CompiledResource<FrameCtx>,
    surfaceSize: BindingOptions['surfaceSize'],
  ): RenderGraphError | undefined {
    if (resource.kind === 'buffer' && resource.descriptor.size <= 0) {
      return new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: `buffer '${resource.label}' size is greater than zero`,
        hint: 'derive a positive byte size before creating/importing the buffer',
        detail: {
          resourceLabel: resource.label,
          field: 'size',
          expected: 'size > 0',
          actual: resource.descriptor.size,
        },
      });
    }
    if (resource.kind !== 'texture') return undefined;
    const d = resource.descriptor;
    const extent = this.resolveExtent(d.size, surfaceSize);
    if (extent.width <= 0 || extent.height <= 0 || extent.depthOrArrayLayers <= 0) {
      return new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: `texture '${resource.label}' extent is positive`,
        hint: 'repair the authored extent or compile surface size',
        detail: {
          resourceLabel: resource.label,
          field: 'size',
          expected: 'all extent axes > 0',
          actual: `${extent.width}x${extent.height}x${extent.depthOrArrayLayers}`,
        },
      });
    }
    resource.textureShape = {
      descriptor: {
        label: resource.label,
        size: extent,
        dimension: d.dimension ?? '2d',
        format: d.format,
        sampleCount: d.sampleCount ?? 1,
        mipLevelCount: d.mipLevelCount ?? 1,
        usage: resource.origin === 'imported' ? resource.descriptor.usage : resource.usage,
        viewFormats: d.viewFormats ?? NO_VIEW_FORMATS,
      },
      lifetime: d.lifetime ?? 'transient',
    };
    return undefined;
  }

  private viewDimensionError(view: TextureViewRecord<FrameCtx>): RenderGraphError | undefined {
    const texture = this.resourceAt(view.textureId);
    if (texture?.kind !== 'texture') return undefined;
    const allocationDimension = texture.descriptor.dimension ?? '2d';
    const viewDimension = view.descriptor.dimension;
    if (!isTextureViewDimensionCompatible(allocationDimension, viewDimension)) {
      return new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: `texture '${texture.label}' view dimension matches allocation dimension`,
        hint: 'use a 3d view only for a 3d allocation and preserve array views on 2d allocations',
        detail: {
          resourceLabel: texture.label,
          field: 'dimension',
          expected: allocationDimension,
          actual: viewDimension ?? '2d',
        },
      });
    }
    return undefined;
  }

  /** First uses were recorded in pass order. Only pass-local lifetimes enter this sweep. */
  private planPassLocalSlots(
    physical: PhysicalGraphSlots<FrameCtx>,
  ): (PassLocalSlot | undefined)[] {
    const slots: (PassLocalSlot | undefined)[] = [];
    const idle = new Map<string, PassLocalSlot[]>();
    const ending: (PassLocalSlot | undefined)[] = [];
    let cursor = 0;
    for (const id of this.passLocalFirstUses) {
      const interval = physical.resource(id);
      const shape = interval?.textureShape;
      if (
        interval?.firstUse == null ||
        interval.lastUse === null ||
        shape === undefined ||
        (shape.descriptor.usage & TEXTURE_USAGE.copySrc) !== 0
      )
        continue;
      while (cursor < interval.firstUse) {
        let released = ending[cursor++];
        while (released !== undefined) {
          const next = released.nextEnding;
          released.nextEnding = undefined;
          released.family.push(released);
          released = next;
        }
      }
      const descriptor = shape.descriptor;
      const { width, height, depthOrArrayLayers } = descriptor.size;
      // The alias sweep has no owning label. Group only the actual pass-local
      // candidates, after their observable copies and intervals are known.
      const familyKey = `${width}/${height}/${depthOrArrayLayers}/${descriptor.dimension}/${descriptor.format}/${descriptor.sampleCount}/${descriptor.mipLevelCount}/${descriptor.usage}/${descriptor.viewFormats.join(',')}`;
      let family = idle.get(familyKey);
      if (family === undefined) {
        family = [];
        idle.set(familyKey, family);
      }
      const slot = family.pop() ?? {
        label: shape.descriptor.label,
        family,
        nextEnding: undefined,
      };
      slots[id] = slot;
      slot.nextEnding = ending[interval.lastUse];
      ending[interval.lastUse] = slot;
    }
    return slots;
  }

  private allocate(
    physical: PhysicalGraphSlots<FrameCtx>,
    options: BindingOptions,
    resources: BoundGraphResources<FrameCtx>,
  ): Result<void, RenderGraphError> {
    const slots =
      this.passLocalFirstUses.length !== 0 && !options.retainPassLocalTargets
        ? this.planPassLocalSlots(physical)
        : undefined;
    // A view is declared after its texture. Both can bind in physical address
    // order, with the same rollback covering every lease already acquired.
    for (const record of physical.entries()) {
      if (record === undefined) continue;
      const error =
        'kind' in record
          ? this.bindResource(record, slots?.[record.id], options, resources)
          : this.bindView(record, physical.resource(record.textureId), options, resources);
      if (error !== undefined) {
        for (const slot of resources.owningSlots()) releaseBoundResource(options.device, slot);
        return err(error);
      }
    }
    return ok(undefined);
  }

  private bindResource(
    resource: CompiledResource<FrameCtx>,
    slot: PassLocalSlot | undefined,
    options: BindingOptions,
    resources: BoundGraphResources<FrameCtx>,
  ): RenderGraphError | undefined {
    if (resource.origin === 'imported') {
      resources.addImport(resource);
      return undefined;
    }
    resources.importOnly = false;
    const { usage } = resource;
    if (resource.kind === 'texture') {
      if (
        resource.descriptor.lifetime === 'pass-local' &&
        !options.retainPassLocalTargets &&
        (usage & TEXTURE_USAGE.copySrc) === 0
      )
        resource.passLocal = true;
      const shape = resource.textureShape;
      if (usage !== 0 && shape !== undefined)
        return this.bindCreatedTexture(resource, shape, slot, options, resources);
      return undefined;
    }
    if (usage === 0) return undefined;
    const created = options.device.createBuffer({
      label: resource.label,
      size: resource.descriptor.size,
      usage,
      mappedAtCreation: resource.descriptor.mappedAtCreation ?? false,
    });
    if (!created.ok)
      return new RenderGraphError({
        code: 'resource-allocation-failed',
        expected: `RHI creates graph buffer '${resource.label}'`,
        hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
        detail: { resourceKey: resource.label, rhiCode: created.error.code },
      });
    resource.handle = created.value;
    resources.own(resource);
    return undefined;
  }

  private bindCreatedTexture(
    resource: Extract<CompiledResource<FrameCtx>, { kind: 'texture'; origin: 'created' }>,
    shape: PhysicalTextureShape,
    slot: PassLocalSlot | undefined,
    options: BindingOptions,
    resources: BoundGraphResources<FrameCtx>,
  ): RenderGraphError | undefined {
    const borrowed = slot?.allocation;
    if (borrowed !== undefined) {
      resource.textureAllocation = borrowed;
      resource.handle = borrowed.texture;
      return undefined;
    }

    // The first binding owns the lease even when a different logical target
    // is read first in pass order and provides the stable physical label.
    const label = slot?.label ?? resource.label;
    let allocation = options.previous?.texture(label, shape);
    const reads = resource.inheritedTextureReads;
    if (reads !== undefined) {
      const missing = firstMissingTextureRead(reads, allocation?.committedContentRanges);
      if (missing !== undefined)
        return uninitializedRead(resource.label, missing.passName, missing.usage);
    }
    if (allocation === undefined) {
      const created = options.device.createTexture({
        ...shape.descriptor,
        label,
        viewFormats: [...shape.descriptor.viewFormats],
      });
      if (!created.ok)
        return new RenderGraphError({
          code: 'resource-allocation-failed',
          expected: `RHI creates graph texture '${resource.label}'`,
          hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
          detail: { resourceKey: resource.label, rhiCode: created.error.code },
        });
      allocation = {
        texture: created.value,
        shape,
        byteSize: allocationBytes(resource),
        references: 1,
        committedContentRanges: [],
      };
    } else {
      allocation.references++;
    }
    if (reads !== undefined) {
      resources.inherit(resource.label, allocation, reads);
      delete resource.inheritedTextureReads;
    }
    resources.attachments.own(label, allocation);
    if (slot !== undefined) slot.allocation = allocation;
    resource.textureAllocation = allocation;
    resource.handle = allocation.texture;
    resources.own(resource);
    return undefined;
  }

  private bindView(
    view: CompiledView<FrameCtx>,
    resource: CompiledResource<FrameCtx> | undefined,
    options: BindingOptions,
    resources: BoundGraphResources<FrameCtx>,
  ): RenderGraphError | undefined {
    if (resource?.kind !== 'texture') return undefined;
    if (resource.origin === 'imported') {
      resources.addImportedView(view, resource);
      return undefined;
    }
    if (resource.handle === undefined) return undefined;
    const bindings = resources.attachments;
    const texture = resource.handle;
    let physicalView = bindings.view(texture, view.descriptor);
    if (physicalView === undefined) {
      physicalView = options.previous?.view(texture, view.descriptor);
      if (physicalView === undefined) {
        const created = options.device.createTextureView(texture, view.descriptor);
        if (!created.ok)
          return new RenderGraphError({
            code: 'resource-allocation-failed',
            expected: `RHI creates graph texture view '${view.label}'`,
            hint: 'inspect detail.rhiCode and repair the view descriptor/capability route',
            detail: { resourceKey: view.label, rhiCode: created.error.code },
          });
        physicalView = created.value;
      }
      bindings.bindView(texture, view.descriptor, physicalView);
    }
    view.handle = physicalView;
    return undefined;
  }

  private resolveExtent(
    extent: GraphExtent,
    surface: RenderGraphCompileOptions['surfaceSize'],
  ): { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number } {
    if (extent === 'surface') return { ...surface, depthOrArrayLayers: 1 };
    if (extent === 'half-surface' || extent === 'quarter-surface') {
      const divisor = extent === 'quarter-surface' ? 4 : 2;
      return {
        width: Math.ceil(surface.width / divisor),
        height: Math.ceil(surface.height / divisor),
        depthOrArrayLayers: 1,
      };
    }
    return {
      width: extent.width,
      height: extent.height,
      depthOrArrayLayers: extent.depthOrArrayLayers ?? 1,
    };
  }

  private sealedError(): RenderGraphError {
    return new RenderGraphError({
      code: 'builder-sealed',
      expected: 'a RenderGraphBuilder accepts declarations only before compile()',
      hint: 'create a new builder for a changed topology',
      detail: {},
    });
  }

  private reserveLabel(label: string): RenderGraphError | undefined {
    const labels = this.slotsByLabel;
    if (labels === undefined) return this.sealedError();
    if (labels.has(label)) {
      return new RenderGraphError({
        code: 'duplicate-resource-label',
        expected: `resource label '${label}' is unique within one builder`,
        hint: `rename the second '${label}' declaration`,
        detail: { resourceLabel: label },
      });
    }
    labels.set(label, this.nextId);
    return undefined;
  }

  private foreignHandleError(passName?: string): RenderGraphError {
    return new RenderGraphError({
      code: 'foreign-resource-handle',
      expected: 'every graph resource handle belongs to this builder',
      hint: 'create/import/view the resource on the same builder that declares the pass',
      detail: { ...(passName === undefined ? {} : { passName }) },
    });
  }
}
