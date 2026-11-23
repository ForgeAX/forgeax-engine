import type {
  Buffer,
  ComputePassDescriptor,
  QuerySet,
  RenderPassDescriptor,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Texture,
  TextureFormat,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import type { RenderGraphError, Result } from './errors.js';
import type { ColorValueDomain } from './pipeline/color-value-domain.js';

declare const graphTextureBrand: unique symbol;
declare const graphTextureViewBrand: unique symbol;
declare const graphBufferBrand: unique symbol;
declare const graphAccelerationStructureBrand: unique symbol;

export interface GraphTexture {
  readonly [graphTextureBrand]: true;
}

export interface GraphTextureView {
  readonly [graphTextureViewBrand]: true;
}

export interface GraphBuffer {
  readonly [graphBufferBrand]: true;
}

/** A host-owned top-level acceleration structure; import-only, never graph-allocated. */
export interface GraphAccelerationStructure {
  readonly [graphAccelerationStructureBrand]: true;
}

export type GraphResourceOrigin = 'created' | 'imported';
export type GraphResourceKind = 'texture' | 'buffer' | 'acceleration-structure';

export type GraphExtent =
  | 'surface'
  | 'half-surface'
  | 'quarter-surface'
  | {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers?: number | undefined;
    };

export interface GraphTextureDescriptor {
  readonly format: TextureFormat;
  readonly size: GraphExtent;
  /** Pass-local contents exist only between declared graph accesses. Only transient and persistent
   * textures expose named targets outside those passes. Persistent contents can cross compilations. */
  readonly lifetime?: 'transient' | 'persistent' | 'pass-local' | undefined;
  /** Additional RHI usage required by an external diagnostic consumer such as readback. */
  readonly usage?: number | undefined;
  readonly mipLevelCount?: number | undefined;
  readonly sampleCount?: number | undefined;
  readonly dimension?: GPUTextureDimension | undefined;
  readonly viewFormats?: readonly TextureFormat[] | undefined;
  /** Explicit semantic color domain; never inferred from the attachment format. */
  readonly domain?: ColorValueDomain | undefined;
}

/** Explicit original owner for imports that can prepare without an execution frame. */
export interface NativeTextureImport {
  prepare(current: () => boolean): Generator<GraphPreparationStep, Texture>;
  /** Pure physical identity lookup; it never allocates, resolves a frame or renews stale facts. */
  current(): Texture | undefined;
  /** A single-mip whole image resolved by this owner may resize between executions.
   * The parent samples or copies the whole image. Its native child owns attachment slices. */
  resolvedExtent?(texture: Texture): {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
  };
}

export interface ImportedTextureDescriptor extends GraphTextureDescriptor {
  readonly usage: number;
}

export interface GraphTextureViewDescriptor {
  readonly label?: string | undefined;
  readonly format?: TextureFormat | undefined;
  readonly dimension?: GPUTextureViewDimension | undefined;
  readonly aspect?: GPUTextureAspect | undefined;
  readonly baseMipLevel?: number | undefined;
  readonly mipLevelCount?: number | undefined;
  readonly baseArrayLayer?: number | undefined;
  readonly arrayLayerCount?: number | undefined;
}

export type ImportedTextureViewResolver<FrameCtx> = (frame: FrameCtx) => TextureView;

export interface GraphBufferDescriptor {
  readonly size: number;
  readonly mappedAtCreation?: boolean | undefined;
}

export interface ImportedBufferDescriptor extends GraphBufferDescriptor {
  readonly usage: number;
}

export interface ImportedAccelerationStructureDescriptor {
  /** The TLAS capacity, retained in compiled graph facts. */
  readonly maxInstances: number;
}

/**
 * `build` encodes BLAS/TLAS builds on the frame encoder (copy passes only);
 * `read` binds the TLAS to a Ray Query shader. Both require `caps.rayQuery`.
 */
export type GraphAccelerationStructureAccess =
  | 'acceleration-structure-build'
  | 'acceleration-structure-read';

export type GraphBufferAccess =
  | 'uniform-read'
  | 'storage-read'
  | 'storage-write'
  | 'storage-read-write'
  | 'indirect-read'
  | 'vertex-read'
  | 'index-read'
  | 'copy-src'
  | 'copy-dst';

export type GraphTextureAccess =
  | 'sampled-read'
  | 'storage-read'
  | 'storage-write'
  | 'storage-read-write'
  | 'sampled-storage-read-write'
  /** Compute dispatches fully write before sampling; no incoming contents are consumed. */
  | 'sampled-storage-write'
  | 'color-attachment'
  | 'depth-stencil-read'
  | 'depth-stencil-write'
  | 'copy-src'
  | 'copy-dst';

export type GraphAccess =
  | { readonly resource: GraphBuffer; readonly usage: GraphBufferAccess }
  | { readonly resource: GraphTextureView; readonly usage: GraphTextureAccess }
  | {
      readonly resource: GraphAccelerationStructure;
      readonly usage: GraphAccelerationStructureAccess;
    };

export type GraphAccessUsage = GraphAccess['usage'];

export interface GraphResourceResolver {
  buffer(resource: GraphBuffer): Result<Buffer, RenderGraphError>;
  bufferSource?(resource: GraphBuffer): Result<
    {
      readonly buffer: Buffer;
      readonly descriptor: ImportedBufferDescriptor;
    },
    RenderGraphError
  >;
  texture(resource: GraphTexture): Result<Texture, RenderGraphError>;
  textureView(resource: GraphTextureView): Result<TextureView, RenderGraphError>;
  /** Borrow one declared view with its exact compiled allocation and slice facts. */
  textureViewSource?(resource: GraphTextureView): Result<
    {
      readonly texture: Texture;
      readonly view: TextureView;
      readonly descriptor: ImportedTextureDescriptor;
      readonly viewDescriptor: GraphTextureViewDescriptor;
    },
    RenderGraphError
  >;
  /** Pixel extent of the declared view's base mip, from compiled allocation facts. */
  textureViewExtent(
    resource: GraphTextureView,
  ): Result<{ readonly width: number; readonly height: number }, RenderGraphError>;
  accelerationStructure(resource: GraphAccelerationStructure): Result<Tlas, RenderGraphError>;
}

export interface RasterColorAttachment<FrameCtx> {
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
  readonly clearValue?: GPUColor | ((frame: FrameCtx) => GPUColor) | undefined;
  /** Dynamic loads conservatively require initialized attachment contents. */
  readonly loadOp: GPULoadOp | ((frame: FrameCtx) => GPULoadOp);
  /** Auto permits discarding dead resolved MSAA samples; explicit stores are preserved. */
  readonly storeOp: GPUStoreOp | 'auto';
  readonly depthSlice?: number | undefined;
}

export interface RasterDepthStencilAttachment<FrameCtx = unknown> {
  readonly view: GraphTextureView;
  readonly depthClearValue?: number | undefined;
  /** A frame-selected load requires the depth aspect to have an earlier producer. */
  readonly depthLoadOp?: GPULoadOp | ((frame: FrameCtx) => GPULoadOp) | undefined;
  readonly depthStoreOp?: GPUStoreOp | undefined;
  readonly depthReadOnly?: boolean | undefined;
  readonly stencilClearValue?: number | undefined;
  readonly stencilLoadOp?: GPULoadOp | ((frame: FrameCtx) => GPULoadOp) | undefined;
  readonly stencilStoreOp?: GPUStoreOp | undefined;
  readonly stencilReadOnly?: boolean | undefined;
}

/** Exactly one callback form: direct arguments avoid a temporary context record. */
export type GraphPassEncoding<Context, Args extends readonly unknown[]> =
  | { encode(context: Context): void; readonly encodeDirect?: never }
  | { readonly encode?: never; encodeDirect(...args: Args): void };

/** Fixed graph-created views only; imports retain their producer's preparation contract. */
export interface GraphPreparationResources {
  createdTextureView(resource: GraphTextureView): TextureView | undefined;
}
export type GraphPreparationStep = void | Promise<void>;
export interface GraphPassPreparation {
  readonly preparedResourcesCurrent?: () => boolean;
  readonly prepareResources?: (
    resources: GraphPreparationResources,
    current: () => boolean,
  ) => Generator<GraphPreparationStep>;
}

export type RasterGraphPass<FrameCtx> = GraphPassPreparation & {
  readonly accesses: readonly GraphAccess[];
  readonly colorAttachments: readonly RasterColorAttachment<FrameCtx>[];
  readonly depthStencilAttachment?: RasterDepthStencilAttachment<FrameCtx> | undefined;
  /** Producer-owned query set, resolved once per execution when frame-dependent. */
  readonly occlusionQuerySet?: QuerySet | ((frame: FrameCtx) => QuerySet | undefined) | undefined;
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
} & GraphPassEncoding<
    {
      readonly pass: RhiRenderPassEncoder;
      readonly frame: FrameCtx;
      readonly resources: GraphResourceResolver;
    },
    [pass: RhiRenderPassEncoder, frame: FrameCtx, resources: GraphResourceResolver]
  >;

export type ComputeGraphPass<FrameCtx> = GraphPassPreparation & {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  readonly begin?: ((frame: FrameCtx) => ComputePassDescriptor) | undefined;
  readonly onBeginError?: ((frame: FrameCtx, cause: unknown) => void) | undefined;
  readonly after?: ((frame: FrameCtx) => void) | undefined;
} & GraphPassEncoding<
    {
      readonly pass: RhiComputePassEncoder;
      readonly frame: FrameCtx;
      readonly resources: GraphResourceResolver;
    },
    [pass: RhiComputePassEncoder, frame: FrameCtx, resources: GraphResourceResolver]
  >;

export type CopyGraphPass<FrameCtx> = GraphPassPreparation & {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
} & GraphPassEncoding<
    {
      readonly encoder: RhiCommandEncoder;
      readonly frame: FrameCtx;
      readonly resources: GraphResourceResolver;
    },
    [encoder: RhiCommandEncoder, frame: FrameCtx, resources: GraphResourceResolver]
  >;

/**
 * Ordered import-only child work on the parent's device and encoder. Ports cover
 * every borrowed texture view and shared buffer usage; child-private buffers
 * remain caller-owned. Selecting a child neither submits nor transfers ownership.
 */
export type RenderGraphNativePass = {
  /** Stable profiling operation for frame-selected jobs. The name still identifies the physical command. */
  readonly profileName?: string;
} & (
  | {
      readonly kind: 'raster';
      readonly name: string;
      readonly descriptor: RenderPassDescriptor;
      readonly encode: (pass: RhiRenderPassEncoder) => void;
    }
  | {
      readonly kind: 'compute';
      readonly name: string;
      readonly descriptor?: ComputePassDescriptor;
      readonly encode: (pass: RhiComputePassEncoder) => void;
    }
  | {
      readonly kind: 'copy';
      readonly name: string;
      readonly encode: (encoder: RhiCommandEncoder) => void;
    }
);

/** A native command is issued on the synchronous recording that supplied its number. */
export type RenderGraphNativeIssue = (recording: number, pass: RenderGraphNativePass) => void;

/** Profiling identity owned by a physical command declaration. */
export type NativePassProfile = Pick<RenderGraphNativePass, 'name' | 'kind' | 'profileName'>;
export type RenderGraphNativeCommands<FrameCtx> = (
  frame: FrameCtx,
  resources: GraphResourceResolver,
  issue: RenderGraphNativeIssue,
  recording: number,
) => void;

/**
 * An ordered, synchronous command domain. Every graph-owned resource is a declared
 * port; undeclared resources must be caller-owned and disjoint from other graph
 * domains. The executor opens/closes native passes and preserves instrumentation.
 */
export type SubgraphPass<FrameCtx extends RenderGraphFrame> = GraphPassPreparation & {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  /** Finite physical command roster for profiler capture admission. */
  readonly profilePasses?: (() => readonly NativePassProfile[]) | undefined;
  /** Physical names for this frame's ordered submission receipt. */
  readonly appendPassNames?: (frame: FrameCtx, output: string[]) => void;
} & (
    | {
        readonly child: (
          frame: FrameCtx,
          resources: GraphResourceResolver,
        ) => CompiledRenderGraph<FrameCtx>;
        readonly commands?: never;
        readonly commandsDirect?: never;
      }
    | {
        readonly child?: never;
        readonly commandsDirect?: never;
        commands(context: {
          readonly frame: FrameCtx;
          readonly resources: GraphResourceResolver;
          readonly execute: (pass: RenderGraphNativePass) => void;
        }): void;
      }
    | {
        readonly child?: never;
        readonly commands?: never;
        /** The same issuer can span frames. Its recording number expires when this call returns. */
        readonly commandsDirect: RenderGraphNativeCommands<FrameCtx>;
      }
  );

export type GraphPass<FrameCtx extends RenderGraphFrame> =
  | { readonly kind: 'raster'; readonly descriptor: RasterGraphPass<FrameCtx> }
  | { readonly kind: 'compute'; readonly descriptor: ComputeGraphPass<FrameCtx> }
  | { readonly kind: 'copy'; readonly descriptor: CopyGraphPass<FrameCtx> }
  | { readonly kind: 'subgraph'; readonly descriptor: SubgraphPass<FrameCtx> };

export type GraphPassKind = GraphPass<RenderGraphFrame>['kind'];

export interface GraphAccessInfo {
  readonly resource: string;
  readonly usage: GraphAccessUsage;
}

export type CompiledResourceByteSizeUnknownReason =
  | 'imported-owner'
  | 'format-or-layout-unknown'
  | 'not-allocated';

/** Detached physical allocation facts for one compiled graph resource. */
export type CompiledResourceDescriptor =
  | {
      readonly kind: 'texture';
      readonly format: TextureFormat;
      /** Explicit semantic color domain retained in detached graph facts. */
      readonly domain?: ColorValueDomain | undefined;
      /** Authored extent retained so consumers can validate the allocation contract. */
      readonly size: GraphExtent;
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
      readonly mipLevelCount: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'buffer';
      readonly size: number;
    }
  | {
      readonly kind: 'acceleration-structure';
      readonly maxInstances: number;
    };

export interface CompiledRenderGraphInfo {
  readonly passes: readonly {
    readonly name: string;
    readonly kind: GraphPassKind;
    readonly executionIndex: number;
    /** Consecutive logical stages sharing one physical raster attachment lifetime. */
    readonly rasterBatch?: readonly string[] | undefined;
    readonly nativeProfilePasses?: readonly NativePassProfile[] | undefined;
    readonly accesses: readonly GraphAccessInfo[];
    readonly dependencies: readonly string[];
  }[];
  readonly resources: readonly {
    readonly label: string;
    readonly kind: GraphResourceKind;
    readonly origin: GraphResourceOrigin;
    readonly descriptor: CompiledResourceDescriptor;
    readonly firstUse: number | null;
    readonly lastUse: number | null;
    readonly derivedUsage: number;
    /** Stable identity of the physical RHI allocation across shared generations. */
    readonly physicalAllocationKey?: string | undefined;
    readonly allocationState?: 'live' | 'pending-retirement' | 'released' | undefined;
    /** Descriptor-derived byte size when the format is uncompressed and known. */
    readonly byteSize?: number | undefined;
    /** Why byteSize is absent; no zero is fabricated for an unknown owner/format. */
    readonly byteSizeUnknownReason?: CompiledResourceByteSizeUnknownReason | undefined;
    /** Texture format retained for producer-owned resource inspection. */
    readonly format?: TextureFormat | undefined;
    /** Texture allocation facts retained for capability/lifetime inspection. */
    readonly dimension?: GPUTextureDimension | undefined;
    readonly extent?:
      | { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number }
      | undefined;
  }[];
  /** Monotonic graph generation assigned when this graph was compiled. */
  readonly generation: number;
  /**
   * Graph-owned logical allocation facts. Imported resources are counted only
   * as references; their physical bytes stay with the importing owner.
   */
  readonly resourceAllocation?: RenderGraphResourceAllocationInspection | undefined;
}

/**
 * RenderGraph-owned logical allocation facts. Byte totals include only
 * descriptor-derived sizes known by this package; physical GPU residency and
 * imported-resource bytes remain unknown by contract.
 */
export interface RenderGraphResourceAllocationInspection {
  readonly unit: 'engine-allocation-bytes';
  readonly physicalResidency: 'unknown';
  readonly liveBytes: number;
  readonly pendingRetirementBytes: number;
  readonly peakBytes: number;
  readonly successfulAllocationCount: number;
  readonly successfulAllocationBytes: number;
  readonly pendingRetirementCount: number;
  readonly retiredBytes: number;
  readonly failedAllocationRollbacks: number;
  readonly failedAllocationRollbackBytes: number;
  readonly unknownByteSizeCount: number;
  readonly importedResourceCount: number;
}

/** One graph generation included in the renderer-wide replacement ledger. */
export interface RenderGraphGenerationAllocationEntry {
  readonly generation: number;
  /** A graph may be both the current active graph and an unsubmitted candidate. */
  readonly roles: readonly ('active' | 'candidate' | 'retiring')[];
  readonly retirement: 'active' | 'pending' | 'failed';
  readonly allocation: RenderGraphResourceAllocationInspection;
}

/**
 * Renderer-wide logical allocation facts across graph generations. Current
 * live and pending bytes are summed across the generations that overlap;
 * peakBytes is captured from simultaneous owner events instead of summing
 * historical per-graph peaks. This does not estimate physical VRAM or include
 * imported owner bytes.
 */
export interface RenderGraphGenerationAllocationInspection {
  readonly unit: 'engine-allocation-bytes';
  readonly physicalResidency: 'unknown';
  readonly availability: 'complete' | 'partial' | 'unavailable';
  readonly unavailableGenerationCount: number;
  readonly entries: readonly RenderGraphGenerationAllocationEntry[];
  readonly liveBytes: number;
  readonly pendingRetirementBytes: number;
  /** Peak simultaneous logical bytes observed by this renderer owner. */
  readonly peakBytes: number;
  readonly failedRetirementCount: number;
  readonly failedRetirementBytes: number;
}

export interface RenderGraphFrame {
  readonly encoder: RhiCommandEncoder;
  /** Ordered completed command labels, including logical members of fused raster passes.
   * The caller owns the list. A failed graph execution removes only its own suffix. */
  readonly nativePassNames?: string[] | undefined;
}

export interface RenderGraphPassExecution {
  readonly name: string;
  readonly profileName?: string;
  readonly kind: GraphPassKind;
  readonly executionIndex: number;
  /** Present only at a physical instrumentation boundary; never timed per member. */
  readonly logicalPassNames?: readonly string[] | undefined;
  /**
   * The frame-resolved depth view used by an active raster pass. This is
   * absent for non-raster, no-depth, and skipped passes.
   */
  readonly resolvedDepthStencilAttachmentView?: TextureView | undefined;
}

export type RenderGraphPassRunner = ((
  pass: RenderGraphPassExecution,
  encode: () => void,
) => void) & {
  /** Explicit native observation/copy seam. Ordinary CPU wrappers need no boundary. */
  readonly requiresPassBoundary?: ((passName: string) => boolean) | undefined;
};

/**
 * The graph-neutral boundary for observing and decorating an actual pass.
 * Render owns the policy supplied here; the graph only preserves pass
 * provenance and applies the decorated descriptor at the real pass-open
 * boundary. Timestamp policy and acceptance remain outside the graph.
 */
export interface RenderGraphPassInstrumentationScope {
  /** Render-owned synchronous work nested around this actual pass encode. */
  readonly endPass?: (() => void) | undefined;
  readonly renderPassDescriptor?: (descriptor: RenderPassDescriptor) => RenderPassDescriptor;
  readonly computePassDescriptor?: (descriptor: ComputePassDescriptor) => ComputePassDescriptor;
  readonly beforeCopy?: (encoder: RhiCommandEncoder) => void;
  readonly afterCopy?: (encoder: RhiCommandEncoder) => void;
}

export interface RenderGraphPassInstrumentation<FrameCtx extends RenderGraphFrame> {
  begin(
    pass: RenderGraphPassExecution,
    frame: FrameCtx,
  ): RenderGraphPassInstrumentationScope | undefined;
}

export interface RenderGraphCompileOptions {
  readonly device: RhiDevice;
  readonly surfaceSize: { readonly width: number; readonly height: number };
  /** Capture mode keeps each logical attachment separately inspectable after its last pass. */
  readonly retainPassLocalTargets?: boolean;
  /** Share identical graph-created textures with a live graph on the same device. */
  readonly reuseResourcesFrom?: CompiledRenderGraph<RenderGraphFrame> | undefined;
}

/** Texture mip/layer range whose contents were written by an executed graph pass. */
export interface GraphTextureContentRange {
  readonly mipStart: number;
  readonly mipEnd: number;
  readonly layerStart: number;
  readonly layerEnd: number;
  readonly aspect: GPUTextureAspect;
}

export interface CompiledRenderGraph<FrameCtx extends RenderGraphFrame> {
  /** Step original Pass native recipes without a frame, encoder, import resolution or submission. */
  prepareResources(
    current: () => boolean,
  ): Generator<GraphPreparationStep, Result<void, RenderGraphError>>;
  preparedResourcesCurrent(): boolean;
  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
    /** Remove names as their command bodies complete. Only consume the result after success. */
    pendingPasses?: Set<string>,
  ): Result<void, RenderGraphError>;
  /** Commit writes from successful execute() calls after their command buffer is submitted. */
  commitExecution(): void;
  /** Discard staged writes when the frame containing execute() is rejected. */
  discardExecution(): void;
  /** Graph-owned physical texture, available until the graph retires. */
  getColorTargetTexture(name: string): Texture | undefined;
  inspect(): CompiledRenderGraphInfo;
  /** Retirement is monotonic and revokes ownership before the GPU fence settles. */
  isRetired(): boolean;
  /** Borrow a live graph-created native view without resolving imports or authorizing Pass access. */
  createdTextureView(resource: GraphTextureView): TextureView | undefined;
  retire(): Promise<Result<void, RenderGraphError>>;
}
