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

export type GraphResource =
  | GraphTexture
  | GraphTextureView
  | GraphBuffer
  | GraphAccelerationStructure;
export type GraphResourceOrigin = 'created' | 'imported';
export type GraphResourceKind = 'texture' | 'buffer' | 'acceleration-structure';

export type GraphExtent =
  | 'surface'
  | 'half-surface'
  | {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers?: number | undefined;
    };

export interface GraphTextureDescriptor {
  readonly format: TextureFormat;
  readonly size: GraphExtent;
  /** Additional RHI usage required by an external diagnostic consumer such as readback. */
  readonly usage?: number | undefined;
  readonly mipLevelCount?: number | undefined;
  readonly sampleCount?: number | undefined;
  readonly dimension?: GPUTextureDimension | undefined;
  readonly viewFormats?: readonly TextureFormat[] | undefined;
  /** Explicit semantic color domain; never inferred from the attachment format. */
  readonly domain?: ColorValueDomain | undefined;
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
  texture(resource: GraphTexture): Result<Texture, RenderGraphError>;
  textureView(resource: GraphTextureView): Result<TextureView, RenderGraphError>;
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
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly depthSlice?: number | undefined;
}

export interface RasterDepthStencilAttachment {
  readonly view: GraphTextureView;
  readonly depthClearValue?: number | undefined;
  readonly depthLoadOp?: GPULoadOp | undefined;
  readonly depthStoreOp?: GPUStoreOp | undefined;
  readonly depthReadOnly?: boolean | undefined;
  readonly stencilClearValue?: number | undefined;
  readonly stencilLoadOp?: GPULoadOp | undefined;
  readonly stencilStoreOp?: GPUStoreOp | undefined;
  readonly stencilReadOnly?: boolean | undefined;
}

export interface RasterGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly colorAttachments: readonly RasterColorAttachment<FrameCtx>[];
  readonly depthStencilAttachment?: RasterDepthStencilAttachment | undefined;
  /** Producer-owned query set, resolved once per execution when frame-dependent. */
  readonly occlusionQuerySet?: QuerySet | ((frame: FrameCtx) => QuerySet | undefined) | undefined;
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  encode(context: {
    readonly pass: RhiRenderPassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
}

export interface ComputeGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  readonly begin?: ((frame: FrameCtx) => ComputePassDescriptor) | undefined;
  readonly onBeginError?: ((frame: FrameCtx, cause: unknown) => void) | undefined;
  encode(context: {
    readonly pass: RhiComputePassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
  readonly after?: ((frame: FrameCtx) => void) | undefined;
}

export interface CopyGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  encode(context: {
    readonly encoder: RhiCommandEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
}

export type GraphPass<FrameCtx> =
  | { readonly kind: 'raster'; readonly descriptor: RasterGraphPass<FrameCtx> }
  | { readonly kind: 'compute'; readonly descriptor: ComputeGraphPass<FrameCtx> }
  | { readonly kind: 'copy'; readonly descriptor: CopyGraphPass<FrameCtx> };

export type GraphPassKind = GraphPass<unknown>['kind'];

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
}

export interface RenderGraphPassExecution {
  readonly name: string;
  readonly kind: GraphPassKind;
  readonly executionIndex: number;
  /**
   * The frame-resolved depth view used by an active raster pass. This is
   * absent for non-raster, no-depth, and skipped passes.
   */
  readonly resolvedDepthStencilAttachmentView?: TextureView | undefined;
}

export type RenderGraphPassRunner = (pass: RenderGraphPassExecution, encode: () => void) => void;

/**
 * The graph-neutral boundary for observing and decorating an actual pass.
 * Render owns the policy supplied here; the graph only preserves pass
 * provenance and applies the decorated descriptor at the real pass-open
 * boundary. Timestamp policy and acceptance remain outside the graph.
 */
export interface RenderGraphPassInstrumentationScope {
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
  /** Share identical graph-created textures with a live graph on the same device. */
  readonly reuseResourcesFrom?: CompiledRenderGraph<RenderGraphFrame> | undefined;
}

export interface CompiledRenderGraph<FrameCtx extends RenderGraphFrame> {
  execute(
    frame: FrameCtx,
    runPass?: RenderGraphPassRunner,
    instrumentation?: RenderGraphPassInstrumentation<FrameCtx>,
  ): Result<void, RenderGraphError>;
  inspect(): CompiledRenderGraphInfo;
  retire(): Promise<Result<void, RenderGraphError>>;
}
