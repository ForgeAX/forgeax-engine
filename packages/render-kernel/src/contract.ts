// Complete public RenderKernel V1 contract shared identically by TsRenderKernel and WasmRenderKernel.

import type {
  RhiCaps,
  RhiDevice,
  RhiError,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { FrameRecorder } from './command-stream.js';

export type KernelCreateShaderModuleImmediate = (
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
) => Result<ShaderModule, RhiError>;

import type {
  DynamicTextureDesc,
  DynamicTextureUploadSource,
  TextureFormatCode,
} from './dynamic-texture.js';
import type { KernelError, Result } from './errors.js';
import type {
  BufferId,
  CullId,
  DynamicTextureId,
  LightId,
  MaterialId,
  MeshId,
  PipelineId,
  RenderObjectId,
  SamplerId,
  ShaderProgramId,
  SurfaceId,
  TextureId,
} from './handles.js';
import type { SceneDeltaWriter } from './scene-delta.js';

export type KernelBackendMode = 'ts' | 'wasm';
export type KernelBackendKind = 'ts-rhi' | 'rust-wasm-rhi' | 'rust-wgpu-wasm' | 'rust-wgpu-native';

export const CULL_FLAG_CULL_LIGHTS = 1 << 0;
export const CULL_FLAG_COMPUTE_VISIBLE_BOUNDS = 1 << 1;
export const CULL_FLAG_INCLUDE_SHADOW_ONLY = 1 << 2;

export interface KernelSubmeshDesc {
  readonly firstIndex?: number;
  readonly indexCount?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
  readonly vertexCount?: number;
}

export interface KernelMeshDesc {
  readonly vertexLayoutId: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly isUint32Index?: boolean;
  readonly topology?: number;
  readonly submeshes?: readonly KernelSubmeshDesc[];
  readonly label?: string;
}

export interface KernelTextureDesc {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormatCode;
  readonly usage?: number;
  readonly mipLevelCount?: number;
  readonly arrayLayerCount?: number;
  readonly sampleCount?: 1 | 4;
  readonly label?: string;
}

export interface KernelBufferDesc {
  readonly size: number;
  readonly usage: number;
  readonly label?: string;
}

export interface KernelSamplerDesc {
  readonly magFilter?: GPUFilterMode;
  readonly minFilter?: GPUFilterMode;
  readonly mipmapFilter?: GPUMipmapFilterMode;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly compare?: GPUCompareFunction;
  readonly label?: string;
}

export type KernelBlendMode = 'none' | 'alpha' | 'premultiplied' | 'additive';

export interface KernelColorTargetDesc {
  readonly format: GPUTextureFormat;
  readonly blendMode?: KernelBlendMode;
  readonly writeMask?: number;
}

export interface KernelDepthStencilDesc {
  readonly format: GPUTextureFormat;
  readonly depthWriteEnabled?: boolean;
  readonly depthCompare?: GPUCompareFunction;
  readonly depthBias?: number;
  readonly depthBiasSlopeScale?: number;
  readonly depthBiasClamp?: number;
}

export interface KernelShaderProgramDesc {
  readonly code: string;
  readonly vertexEntryPoint?: string;
  readonly fragmentEntryPoint?: string;
  readonly computeEntryPoint?: string;
  readonly layoutFamilyId: number;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly colorFormats?: readonly GPUTextureFormat[];
  /** Per-target MRT color state descriptors (overrides `colorFormats` when present). */
  readonly colorTargets?: readonly KernelColorTargetDesc[];
  readonly depthFormat?: GPUTextureFormat;
  /** Explicit depth-stencil pipeline state (overrides `depthFormat` defaults when present). */
  readonly depthStencil?: KernelDepthStencilDesc;
  readonly sampleCount?: 1 | 4;
  readonly blendMode?: KernelBlendMode;
  readonly cullMode?: GPUCullMode;
  readonly frontFace?: GPUFrontFace;
  readonly primitiveTopology?:
    | 'triangle-list'
    | 'triangle-strip'
    | 'line-list'
    | 'line-strip'
    | 'point-list';
  readonly label?: string;
}

export interface KernelReadbackResult {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly pixels: Uint8Array;
}

export interface KernelMaterialDesc {
  readonly shaderProgramId: ShaderProgramId;
  readonly layoutFamilyId: number;
  readonly renderStateBits: number;
  readonly variantFlags?: number;
  readonly queue?: number;
  readonly baseColorTextureId?: TextureId;
  readonly normalTextureId?: TextureId;
  readonly metallicRoughnessTextureId?: TextureId;
  readonly emissiveTextureId?: TextureId;
  readonly occlusionTextureId?: TextureId;
  readonly samplerId?: SamplerId;
  readonly dynamicTextureIds?: readonly DynamicTextureId[];
  readonly label?: string;
}

export interface KernelCullParams {
  readonly viewProj: Float32Array;
  readonly cameraPos: readonly [number, number, number];
  readonly layerMask?: number;
  readonly flags?: number;
  readonly lodBias?: number;
}

export interface KernelVisibleLightSummary {
  readonly lightId: LightId;
  readonly kind: 0 | 1 | 2;
  readonly castShadow: boolean;
  readonly cascadeCount: number;
  readonly screenCoverage: number;
}

export interface KernelCullSummary {
  readonly cullId: CullId;
  readonly candidateCount: number;
  readonly visibleOpaqueCount: number;
  readonly visibleMaskedCount: number;
  readonly visibleTransparentCount: number;
  readonly visibleShadowCasterCount: number;
  readonly visibleBoundsMin: readonly [number, number, number];
  readonly visibleBoundsMax: readonly [number, number, number];
  readonly visibleLights: readonly KernelVisibleLightSummary[];
}

export interface FrameSubmitReceipt {
  readonly frameId: number;
  readonly sceneRevision: number;
  readonly status: 'ready' | 'pending-pipelines' | 'failed';
  readonly submittedPassCount: number;
  readonly mergedPassCount: number;
  readonly submittedDrawCount: number;
  readonly submittedIndirectCount: number;
  readonly pendingPipelineCount: number;
  readonly firstMissingObjectId: RenderObjectId | 0;
  readonly firstMissingSubmesh: number;
  readonly poolTextureCount: number;
  readonly poolAllocations: number;
  readonly poolReuses: number;
  /** Exact resolved physical command stream words emitted for this frame (for RHI replay & parity). */
  readonly resolvedPhysicalCommands: Uint32Array;
  /** Compact submission coverage bitmap (1 bit per scene row). */
  readonly submittedBitmap: Uint32Array;
}

export interface KernelAssetApi {
  createMesh(
    desc: KernelMeshDesc,
    vertexBytes: Uint8Array,
    indexBytes?: Uint8Array,
  ): Result<MeshId, KernelError>;
  destroyMesh(id: MeshId): Result<void, KernelError>;

  createTexture(desc: KernelTextureDesc, initialBytes?: Uint8Array): Result<TextureId, KernelError>;
  destroyTexture(id: TextureId): Result<void, KernelError>;

  createDynamicTexture(desc: DynamicTextureDesc): Result<DynamicTextureId, KernelError>;
  /**
   * Returns `ok(true)` if dimensions changed and physical TextureView was reallocated,
   * or `ok(false)` for zero-rebuild same-size in-place update / unchanged revision.
   */
  uploadDynamicTexture(
    id: DynamicTextureId,
    revision: number,
    width: number,
    height: number,
    source: DynamicTextureUploadSource,
  ): Result<boolean, KernelError>;
  destroyDynamicTexture(id: DynamicTextureId): Result<void, KernelError>;

  createBuffer(desc: KernelBufferDesc, initialBytes?: Uint8Array): Result<BufferId, KernelError>;
  writeBuffer(id: BufferId, offset: number, bytes: Uint8Array): Result<void, KernelError>;
  destroyBuffer(id: BufferId): Result<void, KernelError>;

  createSampler(desc: KernelSamplerDesc): Result<SamplerId, KernelError>;
  destroySampler(id: SamplerId): Result<void, KernelError>;

  registerShaderProgram(desc: KernelShaderProgramDesc): Result<ShaderProgramId, KernelError>;
  destroyShaderProgram(id: ShaderProgramId): Result<void, KernelError>;

  createMaterial(
    desc: KernelMaterialDesc,
    initialParamBytes: Uint8Array,
  ): Result<MaterialId, KernelError>;
  updateMaterialParams?(id: MaterialId, paramBytes: Uint8Array): Result<void, KernelError>;
  destroyMaterial(id: MaterialId): Result<void, KernelError>;

  /** Uploads GPU skeletal joint palette matrices (64B mat4 per slot) for skinned 4-BGL meshes. */
  setSkinJoints?(slotOffset: number, jointMatrices: Float32Array): Result<void, KernelError>;

  registerExternalSurface(
    texture: Texture,
    view: TextureView,
    width: number,
    height: number,
  ): SurfaceId;
  registerExternalPipeline(pipeline: import('@forgeax/engine-rhi').RenderPipeline): PipelineId;
}

/**
 * Minimal cross-backend kernel execution surface shared by WebGPU/Dawn (`WasmRenderKernel`,
 * `TsRenderKernel`), Browser WebGL2 WASM closure (`WasmWgpuRenderKernel`), and Desktop Native
 * (`NativeRenderKernel`). Declarative `CompiledKernelGraph` executes identically on any target
 * implementing this interface without requiring a TS `RhiDevice`.
 */
export interface RenderKernelExecutionTarget {
  readonly backendKind: KernelBackendKind;
  readonly assets?: Partial<KernelAssetApi>;
  /** Whether this backend supports the fixed 4-BGL storage-buffer scene layout (`LAYOUT_FAMILY_SCENE_4BGL`). */
  readonly supportsScene4Bgl?: boolean | (() => boolean);
  beginSceneDelta?(minBytes?: number): SceneDeltaWriter;
  commitSceneDelta?(writer: SceneDeltaWriter): Result<number, KernelError>;
  beginFrame(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): Result<FrameRecorder, KernelError>;
  cull(params: KernelCullParams): Result<KernelCullSummary, KernelError>;
  submitFrame(recorder: FrameRecorder): Result<FrameSubmitReceipt, KernelError>;
  readbackTicket?(ticketId: number): Promise<Result<KernelReadbackResult, KernelError>>;
}

export interface RenderKernel extends RenderKernelExecutionTarget {
  readonly backendKind: KernelBackendKind;
  readonly mode: KernelBackendMode;
  readonly caps: Readonly<RhiCaps>;
  readonly device: RhiDevice;
  readonly assets: KernelAssetApi;

  beginSceneDelta(minBytes?: number): SceneDeltaWriter;
  commitSceneDelta(writer: SceneDeltaWriter): Result<number, KernelError>;

  /** Returns the physical RHI Texture backing a transient pool slot (useful for readback/tests). */
  getPoolTexture(poolSlotId: number): Texture | undefined;
  dispose(): void;
}
