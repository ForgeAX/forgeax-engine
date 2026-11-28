// Device-agnostic Standard 3D PBR pipeline & scene renderer contract over RenderKernel + KernelRenderGraph.
// Executes identically across Desktop Native (Metal/DX12/Vulkan), WebGPU/Dawn (RhiPhysicalExecutor),
// and Browser WebGL2 WASM closure (WasmWgpuRenderKernel) with zero TS RhiDevice dependency.

import type { FrameRecorder } from '../command-stream.js';
import type {
  BindingSetId,
  BufferId,
  CullId,
  DynamicTextureId,
  MeshId,
  SamplerId,
  ShaderProgramId,
  TextureId,
} from '../handles.js';

export type KernelResourceKey = string | number;

/** Closed output-transform tone curve vocabulary aligned with `@forgeax/engine-render`. */
export type KernelTonemapMode = 'aces' | 'agx' | 'reinhard' | 'neutral' | 'none';

export interface KernelStandardSubmeshInput {
  readonly firstIndex?: number | undefined;
  readonly indexCount?: number | undefined;
  readonly baseVertex?: number | undefined;
  readonly firstVertex?: number | undefined;
  readonly vertexCount?: number | undefined;
}

export interface KernelStandardMeshInput {
  readonly key: KernelResourceKey;
  /**
   * Packed 12-float interleaved vertices: pos(3) + normal(3) + uv(2) + tangent(4) = 48 bytes/vertex,
   * OR 20-float skinned vertices (`skinned: true`): + joints(4) + weights(4) = 80 bytes/vertex.
   */
  readonly vertices: Float32Array;
  readonly skinned?: boolean | undefined;
  readonly indices?: Uint16Array | Uint32Array | undefined;
  readonly submeshes?: readonly KernelStandardSubmeshInput[] | undefined;
  readonly boundsMin?: readonly [number, number, number] | undefined;
  readonly boundsMax?: readonly [number, number, number] | undefined;
  readonly label?: string | undefined;
}

export interface KernelStandardTextureInput {
  readonly key: KernelResourceKey;
  readonly width: number;
  readonly height: number;
  readonly rgbaBytes: Uint8Array;
  readonly label?: string | undefined;
}

export interface KernelStandardCustomShaderOptions {
  readonly vertexEntryPoint?: string | undefined;
  readonly fragmentEntryPoint?: string | undefined;
  readonly skinned?: boolean | undefined;
  readonly blendMode?: 'alpha' | 'premultiplied' | 'additive' | undefined;
  readonly label?: string | undefined;
}

export interface KernelStandardMaterialInput {
  readonly key: KernelResourceKey;
  /** Linear RGBA base color factor [r, g, b, a]. */
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness?: number | undefined;
  readonly metallic?: number | undefined;
  readonly emissive?: readonly [number, number, number] | undefined;
  readonly normalScale?: number | undefined;
  readonly occlusionStrength?: number | undefined;
  readonly alphaMode?: 'opaque' | 'mask' | 'blend' | undefined;
  readonly alphaCutoff?: number | undefined;
  readonly queue?: number | undefined;
  readonly transparent?: boolean | undefined;
  readonly doubleSided?: boolean | undefined;
  /** When true, binds the GPU skinning 4-BGL shader (`@group(2) @binding(4)` joint palette). */
  readonly skinned?: boolean | undefined;
  readonly baseColorTextureKey?: KernelResourceKey | undefined;
  readonly normalTextureKey?: KernelResourceKey | undefined;
  readonly metallicRoughnessTextureKey?: KernelResourceKey | undefined;
  readonly emissiveTextureKey?: KernelResourceKey | undefined;
  readonly occlusionTextureKey?: KernelResourceKey | undefined;
  /** Optional custom 4-BGL WGSL shader key registered via `registerCustomShader`. */
  readonly customShaderKey?: KernelResourceKey | undefined;
  readonly label?: string | undefined;
}

export interface KernelStandardSkylightInput {
  readonly skyColor: readonly [number, number, number];
  readonly groundColor?: readonly [number, number, number] | undefined;
  readonly intensity?: number | undefined;
}

export interface KernelStandardFogInput {
  readonly mode: 'none' | 'exp' | 'exp2' | 'linear';
  readonly color: readonly [number, number, number];
  readonly density?: number | undefined;
  readonly heightFalloff?: number | undefined;
  readonly near?: number | undefined;
  readonly far?: number | undefined;
  readonly maxOpacity?: number | undefined;
}

export interface KernelStandardSkyboxInput {
  readonly zenithColor: readonly [number, number, number];
  readonly horizonColor: readonly [number, number, number];
  readonly groundColor?: readonly [number, number, number] | undefined;
  readonly intensity?: number | undefined;
}

export interface KernelStandardBloomInput {
  readonly enabled: boolean;
  readonly threshold?: number | undefined;
  readonly intensity?: number | undefined;
}

export interface KernelStandardVignetteInput {
  readonly enabled: boolean;
  readonly intensity?: number | undefined;
  readonly smoothness?: number | undefined;
}

export interface KernelStandardCameraInput {
  /** Column-major WebGPU [0, 1] NDC view-projection matrix (16 floats). */
  readonly viewProj: Float32Array;
  readonly position: readonly [number, number, number];
  readonly clearColor?: readonly [number, number, number, number] | undefined;
  readonly exposure?: number | undefined;
  readonly tonemap?: KernelTonemapMode | undefined;
  readonly cullMask?: number | undefined;
  readonly bloom?: KernelStandardBloomInput | undefined;
  readonly fxaa?: boolean | undefined;
  readonly vignette?: KernelStandardVignetteInput | undefined;
}

export interface KernelStandardLightInput {
  readonly id: number;
  readonly kind: 'directional' | 'point' | 'spot';
  readonly position?: readonly [number, number, number] | undefined;
  readonly direction?: readonly [number, number, number] | undefined;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number | undefined;
  readonly outerConeCos?: number | undefined;
  readonly castShadow?: boolean | undefined;
  readonly cascadeCount?: number | undefined;
  readonly shadowDistance?: number | undefined;
  readonly shadowTarget?: readonly [number, number, number] | undefined;
  readonly shadowViewProj?: Float32Array | undefined;
}

export interface KernelStandardRenderObjectInput {
  readonly entityId: number;
  readonly meshKey: KernelResourceKey;
  readonly submeshIndex?: number | undefined;
  readonly materialKey: KernelResourceKey;
  /** Column-major 4x4 world matrix (16 floats). */
  readonly worldMatrix: Float32Array;
  readonly visible?: boolean | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  readonly frustumCulled?: boolean | undefined;
  readonly layerMask?: number | undefined;
  readonly tint?: readonly [number, number, number, number] | undefined;
  readonly skinSlot?: number | undefined;
  readonly skinInLocalSpace?: boolean | undefined;
}

export interface KernelStandardFrameInput {
  readonly width: number;
  readonly height: number;
  readonly camera: KernelStandardCameraInput;
  readonly skylight?: KernelStandardSkylightInput | undefined;
  readonly fog?: KernelStandardFogInput | undefined;
  readonly skybox?: KernelStandardSkyboxInput | undefined;
  readonly lights: readonly KernelStandardLightInput[];
  readonly objects: readonly KernelStandardRenderObjectInput[];
  /** Optional ticket ID to queue a GPU texture readback of the final presented image. */
  readonly readbackTicketId?: number | undefined;
  /** Arbitrary user payload forwarded into installed `KernelRenderFeature` callbacks. */
  readonly userData?: unknown;
}

export interface KernelStandardRendererOptions {
  readonly shadowMapSize?: number | undefined;
  readonly outputFormat?: GPUTextureFormat | undefined;
  readonly hdrFormat?: GPUTextureFormat | undefined;
  /** When true, final output writes to a transient readback-capable texture rather than swapchain. */
  readonly headless?: boolean | undefined;
  readonly defaultClearColor?: readonly [number, number, number, number] | undefined;
}

export interface KernelStandardSceneStats {
  readonly supportsScene4Bgl: boolean;
  readonly graphCompilations: number;
  readonly graphCacheHits: number;
  readonly installedFeatureCount: number;
  readonly objectCount: number;
  readonly meshCount: number;
  readonly materialCount: number;
  readonly textureCount: number;
  readonly framesSubmitted: number;
  readonly sceneRevision: number;
}

/** Resolved draw item used on the WebGL2 uniform-buffer fallback path (when `supportsScene4Bgl == false`). */
export interface KernelUniformFallbackDraw {
  readonly meshId: MeshId;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly isUint32Index: boolean;
  readonly firstIndex: number;
  readonly baseVertex: number;
  readonly firstVertex: number;
  readonly transparent: boolean;
  readonly baseColor: readonly [number, number, number, number];
  readonly emissive: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly worldMatrix: Float32Array;
  readonly baseColorTexId: TextureId | undefined;
}

/** Per-frame context passed to every built-in pass and installed `KernelRenderFeature`. */
export interface KernelStandardPipelineFrame {
  readonly width: number;
  readonly height: number;
  readonly camera: KernelStandardCameraInput;
  readonly skybox: KernelStandardSkyboxInput | undefined;
  readonly clearColor: readonly [number, number, number, number];
  readonly viewUniformOffset: number;
  readonly viewUniformLength: number;
  readonly mainCullId: CullId;
  readonly shadowCullIds: readonly CullId[];
  readonly cascadeCount: number;
  readonly shadowMapSize: number;
  readonly hasShadowLight: boolean;
  readonly hasTransparent: boolean;
  readonly skinnedObjectCount: number;
  readonly supportsScene4Bgl: boolean;
  readonly postSampler: SamplerId;
  readonly shaders: {
    readonly shadow: ShaderProgramId;
    readonly skinnedShadow: ShaderProgramId;
    readonly uniformPbrOpaque: ShaderProgramId;
    readonly uniformPbrTransparent: ShaderProgramId;
    readonly skybox: ShaderProgramId;
    readonly bloomExtractH: ShaderProgramId;
    readonly bloomBlurV: ShaderProgramId;
    readonly bloomComposite: ShaderProgramId;
    readonly tonemapLdr: ShaderProgramId;
    readonly tonemapOutput: ShaderProgramId;
    readonly fxaaOutput: ShaderProgramId;
    readonly debugLines: ShaderProgramId;
    readonly uiOverlayOutput: ShaderProgramId;
  };
  readonly defaultWhiteTexture: TextureId;
  readonly uiOverlayTexId: DynamicTextureId | undefined;
  readonly uiOverlayActive: boolean;
  readonly debugLineBuffer: BufferId | undefined;
  readonly debugLineVertexCount: number;
  readonly readbackTicketId: number | undefined;
  readonly fallbackDraws: readonly KernelUniformFallbackDraw[];
  readonly fallbackLightDir: readonly [number, number, number];
  readonly fallbackLightColorIntensity: readonly [number, number, number, number];
  readonly fallbackAmbient: readonly [number, number, number, number];
  readonly fallbackFog0: readonly [number, number, number, number];
  readonly fallbackFog1: readonly [number, number, number, number];
  readonly cascadeViewUboBytes: readonly Uint8Array[];
  readonly skyboxUboBytes: Uint8Array;
  readonly bloomUboBytes: Uint8Array;
  readonly tonemapUboBytes: Uint8Array;
  readonly fxaaUboBytes: Uint8Array;
  /** Mutable scratch slot storing the shadow map binding set created after the shadow pass. */
  shadowBindSet: BindingSetId | 0;
  readonly userData: unknown;
  /** Low-level escape hatch if a feature needs to record directly onto the frame recorder. */
  readonly recorder?: FrameRecorder | undefined;
}
