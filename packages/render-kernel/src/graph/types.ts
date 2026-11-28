// Declarative cross-backend RenderGraph & RenderPipeline/RenderFeature contract over RenderKernel.
// Low-frequency topology/access/MSAA compilation runs in TS without requiring a TS RhiDevice;
// steady-state frames lower directly into FrameRecorder bytecode and execute identically on
// WebGPU/Dawn (RhiPhysicalExecutor), Browser WebGL2 (WasmWgpuRenderKernel), and Desktop Native (kernel-wgpu).

import type { BindingSetBuilder, KernelDrawRenderersDesc } from '../command-stream.js';
import type { KernelError, Result } from '../errors.js';
import type {
  BindingSetId,
  BufferId,
  MaterialId,
  MeshId,
  PipelineId,
  ShaderProgramId,
  TextureOrTempId,
} from '../handles.js';

export type KernelGraphResourceOrigin = 'transient' | 'imported' | 'surface';

export type KernelGraphTextureUsage =
  | 'color-write'
  | 'depth-write'
  | 'depth-read'
  | 'sampled-read'
  | 'copy-src'
  | 'copy-dst';

export type KernelGraphBufferUsage =
  | 'uniform-read'
  | 'storage-read'
  | 'storage-read-write'
  | 'vertex-read'
  | 'index-read'
  | 'indirect-read'
  | 'copy-src'
  | 'copy-dst';

export interface KernelGraphTextureDesc {
  readonly format: GPUTextureFormat;
  /** Explicit width in pixels; omit or 0 to derive from `surfaceSize.width * scale`. */
  readonly width?: number;
  /** Explicit height in pixels; omit or 0 to derive from `surfaceSize.height * scale`. */
  readonly height?: number;
  /** Resolution scale relative to `surfaceSize` when `width`/`height` are omitted (default 1). */
  readonly scale?: number;
  readonly sampleCount?: 1 | 4;
  readonly mipLevelCount?: number;
  readonly arrayLayerCount?: number;
  readonly colorDomain?: number;
}

export interface KernelGraphTextureHandle {
  readonly kind: 'graph-texture';
  readonly id: number;
  readonly name: string;
  readonly origin: KernelGraphResourceOrigin;
  readonly format: GPUTextureFormat;
}

export interface KernelGraphTextureViewDesc {
  readonly baseMipLevel?: number;
  readonly mipLevelCount?: number;
  readonly baseArrayLayer?: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export interface KernelGraphTextureViewHandle {
  readonly kind: 'graph-texture-view';
  readonly texture: KernelGraphTextureHandle;
  readonly baseMipLevel: number;
  readonly mipLevelCount?: number;
  readonly baseArrayLayer: number;
  readonly aspect: 'all' | 'depth-only' | 'stencil-only';
}

export type KernelGraphTextureRef = KernelGraphTextureHandle | KernelGraphTextureViewHandle;

export interface KernelGraphBufferHandle {
  readonly kind: 'graph-buffer';
  readonly id: number;
  readonly name: string;
}

export type KernelGraphLoadOp<Frame> = 'clear' | 'load' | ((frame: Frame) => 'clear' | 'load');
export type KernelGraphColorStoreOp = 'store' | 'discard' | 'auto';
export type KernelGraphClearColor<Frame> =
  | readonly [number, number, number, number]
  | ((frame: Frame) => readonly [number, number, number, number]);

export interface KernelGraphColorAttachment<Frame> {
  readonly target: KernelGraphTextureRef;
  readonly resolveTarget?: KernelGraphTextureRef;
  readonly loadOp: KernelGraphLoadOp<Frame>;
  readonly storeOp?: KernelGraphColorStoreOp;
  readonly clearColor?: KernelGraphClearColor<Frame>;
}

export interface KernelGraphDepthAttachment<Frame> {
  readonly target: KernelGraphTextureRef;
  readonly loadOp?: KernelGraphLoadOp<Frame>;
  readonly storeOp?: 'store' | 'discard';
  readonly readOnly?: boolean;
  readonly clearDepth?: number;
}

export interface KernelGraphFrameResources {
  texture(ref: KernelGraphTextureRef): TextureOrTempId;
  buffer(handle: KernelGraphBufferHandle): BufferId;
  writeUniform(data: ArrayBufferView): { readonly offset: number; readonly length: number };
  beginBindingSet(): BindingSetBuilder;
  /** Binds a graph texture or subresource view (honoring mip/layer/aspect) into `builder`. */
  bindTexture(builder: BindingSetBuilder, slot: number, ref: KernelGraphTextureRef): void;
}

/** Declarative raster pass encoder lowering directly into `FrameRecorder` (zero JS heap allocs). */
export interface KernelGraphRasterEncoder {
  drawRenderers(desc: KernelDrawRenderersDesc): void;
  drawFullscreen(
    shader: ShaderProgramId,
    bindings?: BindingSetId | 0,
    uniformOffset?: number,
    uniformLength?: number,
  ): void;
  drawMesh(
    mesh: MeshId,
    material: MaterialId,
    transformUniformOffset: number,
    passTag?: number,
    passAttachmentId?: number,
  ): void;
  setShaderPipeline(
    shader: ShaderProgramId,
    renderStateBits?: number,
    passAttachmentId?: number,
    vertexLayoutId?: number,
  ): void;
  setPipeline(pso: PipelineId): void;
  setBindGroup(slot: number, bindingSet: BindingSetId, dynamicOffsets?: Uint32Array): void;
  setVertexBuffer(slot: number, bufferOrMesh: BufferId | MeshId, offsetBytes?: number): void;
  setIndexBuffer(bufferOrMesh: BufferId | MeshId, isUint32?: boolean, offsetBytes?: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndirect(indirectBuffer: BufferId, offsetBytes?: number): void;
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth?: number,
    maxDepth?: number,
  ): void;
  setScissor(x: number, y: number, width: number, height: number): void;
}

/** Declarative compute pass encoder lowering directly into `FrameRecorder`. */
export interface KernelGraphComputeEncoder {
  dispatch(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    uniformOffset: number,
    uniformLength: number,
    x: number,
    y?: number,
    z?: number,
  ): void;
  dispatchIndirect(
    shader: ShaderProgramId,
    bindings: BindingSetId | 0,
    indirectBuffer: BufferId,
    offsetBytes?: number,
  ): void;
}

export interface KernelGraphRasterPassDesc<Frame> {
  readonly colorAttachments: readonly KernelGraphColorAttachment<Frame>[];
  readonly depthAttachment?: KernelGraphDepthAttachment<Frame>;
  /** Textures sampled or read inside this pass (used for RAW/WAR tracking and usage derivation). */
  readonly reads?: readonly KernelGraphTextureRef[];
  readonly bufferReads?: readonly KernelGraphBufferHandle[];
  readonly when?: (frame: Frame) => boolean;
  /** Optional pre-pass hook for defining `BindingSet`s and writing frame uniforms before `beginRenderPass`. */
  readonly prepare?: (frame: Frame, resources: KernelGraphFrameResources) => void;
  readonly encode: (
    pass: KernelGraphRasterEncoder,
    frame: Frame,
    resources: KernelGraphFrameResources,
  ) => void;
}

export interface KernelGraphComputePassDesc<Frame> {
  readonly textureReads?: readonly KernelGraphTextureRef[];
  readonly bufferReads?: readonly KernelGraphBufferHandle[];
  readonly bufferWrites?: readonly KernelGraphBufferHandle[];
  readonly when?: (frame: Frame) => boolean;
  readonly prepare?: (frame: Frame, resources: KernelGraphFrameResources) => void;
  readonly encode: (
    pass: KernelGraphComputeEncoder,
    frame: Frame,
    resources: KernelGraphFrameResources,
  ) => void;
}

export interface KernelGraphCopyTexturePassDesc<Frame> {
  readonly source: KernelGraphTextureRef;
  readonly destination: KernelGraphTextureRef;
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly when?: (frame: Frame) => boolean;
}

export interface KernelGraphCopyBufferPassDesc<Frame> {
  readonly source: KernelGraphBufferHandle;
  readonly sourceOffset?: number;
  readonly destination: KernelGraphBufferHandle;
  readonly destinationOffset?: number;
  readonly byteLength: number;
  readonly when?: (frame: Frame) => boolean;
}

export interface KernelGraphReadbackPassDesc<Frame> {
  readonly source: KernelGraphTextureRef;
  readonly ticketId: number | ((frame: Frame) => number);
  readonly when?: (frame: Frame) => boolean;
}

export type KernelGraphPassKind =
  | 'raster'
  | 'compute'
  | 'copy-texture'
  | 'copy-buffer'
  | 'mipgen'
  | 'readback';

export type KernelGraphDependencyKind = 'RAW' | 'WAR' | 'WAW';

export interface KernelGraphDependencyInfo {
  readonly kind: KernelGraphDependencyKind;
  readonly resource: string;
  readonly fromPass: string;
  readonly toPass: string;
}

export interface KernelGraphResourceInfo {
  readonly name: string;
  readonly origin: KernelGraphResourceOrigin;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: 1 | 4;
  readonly mipLevelCount: number;
  readonly arrayLayerCount: number;
  readonly derivedUsage: number;
  readonly firstPass: number;
  readonly lastPass: number;
  readonly estimatedBytes: number;
}

export interface KernelGraphPassInfo {
  readonly name: string;
  readonly kind: KernelGraphPassKind;
  readonly index: number;
  readonly rasterBatch: number;
  readonly autoDiscardedAttachments: readonly string[];
}

export interface CompiledKernelGraphInfo {
  readonly surfaceSize: { readonly width: number; readonly height: number };
  readonly resources: readonly KernelGraphResourceInfo[];
  readonly passes: readonly KernelGraphPassInfo[];
  readonly dependencies: readonly KernelGraphDependencyInfo[];
  readonly installedFeatures: readonly {
    readonly name: string;
    readonly stage: KernelRenderFeatureStage;
  }[];
}

export type KernelRenderFeatureStage =
  | 'before-shadow'
  | 'after-shadow'
  | 'environment'
  | 'before-scene'
  | 'before-opaque'
  | 'after-depth'
  | 'after-opaque'
  | 'before-medium'
  | 'before-transparent'
  | 'after-transparent'
  | 'scene'
  | 'before-post'
  | 'after-tonemap'
  | 'post'
  | 'after-post'
  | 'before-present';

/** Named logical pipeline targets exposed to `KernelRenderFeature` authors. */
export interface KernelPipelineTargets {
  readonly sceneColor: KernelGraphTextureHandle;
  readonly sceneDepth?: KernelGraphTextureHandle;
  readonly shadowMap?: KernelGraphTextureHandle;
  readonly ldrColor?: KernelGraphTextureHandle;
  /** Active color texture in the ping-pong chain (defaults to `sceneColor`). */
  readonly currentColor?: KernelGraphTextureHandle;
  readonly outputTarget: KernelGraphTextureHandle;
  readonly extras?: Readonly<Record<string, KernelGraphTextureHandle>>;
  /** Advance the active color texture so subsequent features and output passes read `next`. */
  setCurrentColor?(next: KernelGraphTextureHandle): void;
  /** Publish a named intermediate texture handle for downstream features. */
  setExtra?(name: string, handle: KernelGraphTextureHandle): void;
}

/** Mutable pipeline target carrier constructed by pipeline builders for ping-pong handoff. */
export interface MutableKernelPipelineTargets extends KernelPipelineTargets {
  sceneColor: KernelGraphTextureHandle;
  sceneDepth?: KernelGraphTextureHandle;
  shadowMap?: KernelGraphTextureHandle;
  ldrColor?: KernelGraphTextureHandle;
  currentColor: KernelGraphTextureHandle;
  outputTarget: KernelGraphTextureHandle;
  readonly extras: Record<string, KernelGraphTextureHandle>;
  setCurrentColor(next: KernelGraphTextureHandle): void;
  setExtra(name: string, handle: KernelGraphTextureHandle): void;
}

export interface KernelRenderFeature<Frame> {
  readonly name: string;
  readonly stage: KernelRenderFeatureStage;
  /** Optional feature names that must execute before this feature within the same stage. */
  readonly dependencies?: readonly string[];
  /** When explicitly `false`, this feature is skipped during graph compilation. */
  readonly enabled?: boolean;
  install(
    builder: KernelRenderGraphBuilderLike<Frame>,
    targets: KernelPipelineTargets,
  ): Result<void, KernelError>;
}

export interface KernelRenderPipeline<Frame> {
  readonly name: string;
  build(
    builder: KernelRenderGraphBuilderLike<Frame>,
    features: readonly KernelRenderFeature<Frame>[],
  ): Result<void, KernelError>;
}

/** Structural interface implemented by `KernelRenderGraphBuilder<Frame>`. */
export interface KernelRenderGraphBuilderLike<Frame> {
  createTexture(
    name: string,
    desc: KernelGraphTextureDesc,
  ): Result<KernelGraphTextureHandle, KernelError>;
  importTexture(
    name: string,
    desc: { readonly format: GPUTextureFormat; readonly width?: number; readonly height?: number },
    resolve: (frame: Frame) => TextureOrTempId,
  ): Result<KernelGraphTextureHandle, KernelError>;
  importSurface(
    name: string,
    desc: { readonly format: GPUTextureFormat },
    resolve?: (frame: Frame) => TextureOrTempId,
  ): Result<KernelGraphTextureHandle, KernelError>;
  importBuffer(
    name: string,
    resolve: (frame: Frame) => BufferId,
  ): Result<KernelGraphBufferHandle, KernelError>;
  view(
    texture: KernelGraphTextureHandle,
    desc: KernelGraphTextureViewDesc,
  ): KernelGraphTextureViewHandle;
  addRasterPass(name: string, desc: KernelGraphRasterPassDesc<Frame>): Result<void, KernelError>;
  addComputePass(name: string, desc: KernelGraphComputePassDesc<Frame>): Result<void, KernelError>;
  addCopyTexturePass(
    name: string,
    desc: KernelGraphCopyTexturePassDesc<Frame>,
  ): Result<void, KernelError>;
  addCopyBufferPass(
    name: string,
    desc: KernelGraphCopyBufferPassDesc<Frame>,
  ): Result<void, KernelError>;
  addMipGenPass(
    name: string,
    target: KernelGraphTextureHandle,
    when?: (frame: Frame) => boolean,
  ): Result<void, KernelError>;
  addReadbackPass(
    name: string,
    desc: KernelGraphReadbackPassDesc<Frame>,
  ): Result<void, KernelError>;
  installFeatures(
    stage: KernelRenderFeatureStage,
    features: readonly KernelRenderFeature<Frame>[],
    targets: KernelPipelineTargets,
  ): Result<void, KernelError>;
}
