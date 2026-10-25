import type {
  AssetRegistry,
  DynamicTextureStore,
  MaterialRenderProjection,
} from '@forgeax/engine-assets-runtime';
import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type { Profiler } from '@forgeax/engine-profiler';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  CanvasConfiguration,
  ComputePipeline,
  PipelineLayout,
  Result,
  RhiCanvasContext,
  RhiCommandEncoder,
  RhiDevice,
  RenderPipeline as RhiRenderPipeline,
  Sampler,
  ShaderModule,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  type MaterialRuntimeArtifact,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import type {
  MaterialAsset,
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { derive, MAX_CLIPPING_PLANES } from '@forgeax/engine-types';
import type {
  MeshSsboBufferWrapper,
  MeshSsboCapacity,
  MeshSsboGrowController,
} from '../assembly/mesh-ssbo-grow';
import type { DeviceScope } from '../device/device-scope';
import type { EngineMetrics } from '../engine-metrics';
import type { RenderFeatureHost } from '../features/host';
import type { RenderFeatureShaderModuleMode } from '../features/types';
import type { GpuDrivenPbrProgram } from '../gpu-driven/pbr-program';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import type { ShadowViewStatePool } from '../gpu-driven/shadow-views';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { SkylightFallback } from '../ibl/skylight-bind-group';
import type { BloomInspection, ShadowViewInvalidationReason } from '../inspection-types';
import type { HealthListenerRegistry, RhiErrorListenerRegistry } from '../lifecycle';
import {
  appliedOutputColorSpace,
  type OutputColorSpace,
  type OutputColorSpaceReport,
  type OutputColorSpaceState,
  observeDisplayP3Configuration,
  outputColorSpaceFallback,
} from '../output-color-space';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRecordPlan } from '../points-lines/record';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { ReflectionProbeTable } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';
import type {
  FrameObservationDomain,
  RenderPipelineObservationCaptureOwner,
} from '../render-contract';
import type { FrameList } from '../scene/frame-list';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import type { SsrAdmissionIdentity } from '../ssr/identity';
import type { GpuPassTimingError } from './gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './gpu-pass-timing/session';
import type { MaterialBgAssemblyCache } from './material-bg-assembly-cache';

export interface PointsLinesRecordSubmission {
  readonly plan: PointsLinesRecordPlan;
  readonly vertexBuffer: Buffer;
  readonly indexBuffer: Buffer;
  readonly layoutProjection: VertexLayoutProjection;
}

export interface ReflectionProbeRecordState {
  readonly bindingClasses: ReadonlyMap<string, string>;
  readonly table: ReflectionProbeTable;
  readonly selections: ReadonlyMap<string, ReflectionProbeSelectionResult>;
  readonly graph: import('./typed-frame-graph').ReflectionProbeGraphState;
  /** Demand is derived from this frame's renderable/source selection. */
  readonly fallbackDemand?: boolean;
  /** Non-neutral sources require a nonzero diagnostic sample when capture is enabled. */
  readonly fallbackHasNonNeutral?: boolean;
  readonly completeSubmission: (
    submitted: boolean,
    completed?: Promise<unknown>,
    fallbackOutput?: {
      readonly format: TextureFormat;
      readonly size: { readonly width: number; readonly height: number };
      readonly frameId: number;
      readonly graphGeneration: number;
      readonly textureIdentity: number;
      readonly readback?: Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>;
    },
    fallbackRequested?: boolean,
  ) => Promise<void>;
}

export interface MaterialShaderPipelineEntry {
  readonly pipeline: RhiRenderPipeline;
  readonly group2Contract: PipelineGroup2Contract;
  /** Producer receipt for the exact artifact selected with this pipeline. */
  readonly receipt?: {
    readonly identity: string;
    readonly generation: number;
  };
}

import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  RenderDebugOverlay,
  RenderPipelineContext,
  RenderRecordPhase,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import type { GpuDrivenStandardPbrFrameResources } from '../render-pipeline';
import type {
  DispatchList,
  MaterialSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';
import type {
  BindGroupCounts,
  BloomFrameReceipts,
  DispatchCounts,
  RenderFrameState,
  ValidatedRenderable,
} from './frame-snapshot';
import type { FoldDispatchPlan } from './mesh-ssbo';

export interface RenderSystemRuntime {
  readonly demandCapsuleShadow?:
    | ((
        source: import('../render-system-extract').RenderableSnapshot,
      ) => import('../capsule-shadow/world-capsules').CapsuleShadowSnapshot | undefined)
    | undefined;
  /** Actual CPU draw demand; unavailable current poses produce no draw. */
  readonly demandSkinTask?:
    | ((
        source: Pick<
          import('../render-system-extract').RenderableSnapshot,
          'worldId' | 'entityKey'
        >,
      ) => import('./skin-tasks').SkinTaskBinding | undefined)
    | undefined;
  readonly growMeshSsbo?: MeshSsboGrowController['growMeshSsbo'] | undefined;
  readonly meshSsboState?: Readonly<MeshSsboCapacity> | undefined;
  /** The accepted program registry used by material layout and binding preparation. */
  readonly shaderRegistry?: import('@forgeax/engine-shader').ShaderRegistry;
  /** Final display observations wait for the screen UI composition. */
  deferFinalDisplayObservation?: boolean;
  standardDeferredShaders?:
    | import('../pipeline/standard-deferred-lighting').StandardDeferredShaderSources
    | undefined;
  readonly device: RhiDevice;
  /** Current renderer device generation used to fence receipt-bound captures. */
  readonly deviceGeneration?: number;
  /** Public receipt identity reserved before graph encoding. */
  readonly observationFrameId?: number | undefined;
  /** Graph identity written by the typed graph for the current receipt. */
  observationGraphGeneration?: number | undefined;
  /** Renderer-owned capture bridge consumed after queue submission. */
  readonly observationCaptureOwner?: RenderPipelineObservationCaptureOwner | undefined;
  /** Internal backend-fixture hook evaluated at the submit transaction edge. */
  readonly resolvePipelineReference?: import('../assembly/backend-contract').RhiBackendInstrumentation['resolvePipelineReference'];
  readonly beforeSubmit?: ((device: RhiDevice) => RhiError | undefined) | undefined;
  readonly deviceScope: DeviceScope;
  /** Domains explicitly armed for the frame being encoded. */
  readonly observationCaptureDomains?: readonly FrameObservationDomain[] | undefined;
  /** Resolve a recorder/backend wrapper before configuring the native surface. */
  readonly resolveSurfaceDevice?: (device: RhiDevice) => Result<RhiDevice, RhiError>;
  /**
   * Renderer-owned output colour-space negotiation. Absent means sRGB. The
   * record stage encodes `report.effective`; RenderTarget views pin sRGB.
   */
  readonly outputColorSpace?: OutputColorSpaceState | undefined;
  readonly errorRegistry: RhiErrorListenerRegistry;
  readonly debugOverlay?: RenderDebugOverlay | undefined;
  readonly healthRegistry: HealthListenerRegistry;
  readonly getMaterialProjectionForPayload?: (
    material: MaterialAsset,
  ) => MaterialRenderProjection | undefined;
  readonly getMaterialArtifact?: (specializationKey: string) => MaterialRuntimeArtifact | undefined;
  /** Producer-owned cooked Standard PBR artifact used by GPU-driven projection. */
  readonly getMaterialShaderArtifact?: (
    materialShaderId: string,
    request?:
      | {
          readonly vertexColorAvailable?: boolean;
          readonly deformation?: 'rigid' | 'skin';
          readonly variantSet?: string;
          readonly clustered?: boolean;
          readonly probeBlend?: boolean;
          readonly reflectionFallback?: boolean;
          readonly pass?: 'forward' | 'shadow' | 'depth';
          readonly address?: 'direct' | 'scene-index';
        }
      | boolean,
  ) => MaterialShaderArtifact | undefined;
  readonly getMaterialPipelineRequestInspection?: () => {
    readonly hits: number;
    readonly misses: number;
    readonly keyCharacters: number;
  };
  /** Candidate-only failure boundary; native PSO errors cannot poison the live frame. */
  readonly withPipelinePreparationErrors?: (action: () => void) => void;
  readonly prepareMaterialShaderPipeline?: RenderSystemRuntime['getMaterialShaderPipeline'];
  readonly prepareMaterialShaderPipelineEntry?: RenderSystemRuntime['getMaterialShaderPipelineEntry'];
  readonly getMaterialShaderPipeline?: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind?: PassKind,
    meshAttributes?: VertexAttributeMap,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat,
    shaderUvSetCount?: number,
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?:
      | 'pbr'
      | 'pbr-skin'
      | 'gpu-driven-pbr'
      | 'gpu-driven-skin'
      | 'gpu-driven-cluster-pbr'
      | 'gpu-driven-cluster-skin'
      | 'surface-direct-pbr'
      | 'surface-direct-cluster-pbr',
    /** Optional vertex entry override for receipt-owned scene-index passes. */
    vertexEntryPoint?: string,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string,
    particleInputLanes?: number,
    constants?: Readonly<Record<string, number>>,
  ) => RhiRenderPipeline | null;
  readonly getMaterialShaderPipelineEntry?: (
    ...args: Parameters<NonNullable<RenderSystemRuntime['getMaterialShaderPipeline']>>
  ) => MaterialShaderPipelineEntry | null;
  /** Reflection-derived UV count included in the material PipelineSpec cache key. */
  readonly getMaterialShaderUvSetCount?: (materialShaderId: string) => number | undefined;
  /** Read a build-time cooked utility selected for the receiving device. */
  readonly getFeatureShaderSource?: ((identifier: string) => string | undefined) | undefined;
  readonly getMaterialShaderBindingContract?: (
    materialShaderId: string,
  ) => import('../features/plan').RenderFeatureMaterialShaderContract;
  readonly getParamSchema?: (materialShaderId: string) => readonly ParamSchemaEntry[] | undefined;
  readonly getMaterialBindGroupLayout?: (
    materialShaderId: string,
    materialParamSchema?: readonly ParamSchemaEntry[],
  ) => BindGroupLayout | undefined;
  /** Fixed renderer-owned resources for one shared material parameter. The owner
   * retains the binding object while its content is unchanged, even across view reuse. */
  readonly preparedMaterialTexture?: (
    material: MaterialSnapshot,
    parameter: string,
  ) => { readonly textureView: TextureView; readonly sampler: Sampler } | undefined;
  /** Complete immutable numeric parameters for a renderer-owned preparation.
   * Preserve the object while addresses are unchanged; authored values remain on the snapshot. */
  readonly preparedMaterialParameters?: (
    material: MaterialSnapshot,
  ) => MaterialSnapshot['paramSnapshot'];
  /** Handle-first factory for built-in same-frame GPU producers. */
  readonly immediateShaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly metrics: EngineMetrics;
  readonly lookupPostProcess?: (
    id: string,
  ) => import('../fullscreen-post-process-pass').PostProcessShaderEntry | undefined;
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    entry?: import('../fullscreen-post-process-pass').PostProcessShaderEntry,
  ) => RhiRenderPipeline | null;
  /** Candidate-owned post-process pipelines transferred at publication. */
  readonly getRecoveryPostProcessPipelines?: () => ReadonlyMap<string, RhiRenderPipeline>;
  readonly clearPostProcessPipelineCache?: (id: string) => void;
  readonly invalidateShaderModule?: (label: string) => void;
  readonly dynamicTextureStore?: DynamicTextureStore | undefined;
  /** Resolves a render-target source to the active generation-owned GPU view. */
  readonly resolveRenderTargetTextureSource?: (
    source: import('../targets/contracts').RenderTargetTextureSource,
  ) => import('../targets/material-source').RenderTargetMaterialSourceBinding | undefined;
  /** Renderer-owned external texture sources (GPUTexture import and per-frame video). */
  readonly externalTextures?:
    | import('../textures/external-texture').ExternalTextureBinder
    | undefined;
}

/** Renderer-owned bridge from retained Points/Lines facts into main geometry. */
export interface PointsLinesRecordOwner {
  prepare(
    entry: Pick<ValidatedRenderable, 'source'>,
    clustered: boolean,
  ): PointsLinesRecordSubmission | undefined;
  beginFrame(): void;
  track(completed: Promise<unknown>): void;
  resetForDeviceLoss(): void;
  inspections(): readonly PointsLinesInspection[];
}

export interface PerPassResources {
  configured: boolean;
  readonly fxaaPipeline: RhiRenderPipeline | null;
  readonly fxaaBindGroupLayout: BindGroupLayout | null;
  readonly fxaaSampler: Sampler | null;
  readonly skyboxPipeline: RhiRenderPipeline | null;
  readonly skyboxPipelineMsaa: RhiRenderPipeline | null;
  readonly skyboxBindGroupLayout: BindGroupLayout | null;
  readonly skyboxSampler: Sampler | null;
  readonly skyboxRotationBuffer: Buffer | null;
  /** Compiled skybox.wgsl, which also carries the GradientSky entries. */
  readonly skyboxModule?: ShaderModule | null;
  bloomHorizontalPipeline: RhiRenderPipeline | null;
  bloomVerticalPipeline: RhiRenderPipeline | null;
  bloomCompositePipeline: RhiRenderPipeline | null;
  bloomHorizontalBindGroupLayout: BindGroupLayout | null;
  bloomVerticalBindGroupLayout: BindGroupLayout | null;
  bloomCompositeBindGroupLayout: BindGroupLayout | null;
  bloomSampler: Sampler | null;
  bloomHorizontalParamsBuffer: Buffer | null;
  bloomVerticalParamsBuffer: Buffer | null;
  bloomCompositeParamsBuffer: Buffer | null;
  ensureBloomResources?: () => void;
  getBloomResources?: () => BloomPersistentBundle | null;
  commitBloomResources?: () => void;
  commitBloomFrameReceipts?: (receipts: BloomFrameReceipts) => void;
  discardBloomResources?: () => void;
  retireBloomResources?: (completion: Promise<unknown>) => void;
  /** Drain candidate, active, and fence-retiring Bloom generations. */
  drainBloomResources?: () => void;
  inspectBloomResources?: (graph?: CompiledRenderGraphInfo) => BloomInspection;
  ssaoCalcPipeline: RhiRenderPipeline | null;
  ssaoBlurPipeline: RhiRenderPipeline | null;
  ssaoBgl: BindGroupLayout | null;
  ssaoFilteringSampler: Sampler | null;
  ssaoDepthSampler: Sampler | null;
  ssaoFallbackRawView: TextureView | null;
  shadowTexture: Texture | null;
  shadowMapSize: number;
  shadowCascadeCount: number;
  shadowSampler: Sampler | null;
  shadowLightSpaceMatrix: Float32Array | null;
  shadowCsmLightViewProj: Float32Array | null;
  shadowCsmSelection: {
    readonly viewMatrix: Float32Array;
    readonly splitPlanes: Float32Array;
  } | null;
}

/** Renderer-private Bloom bundle selected for one record transaction. */
export interface BloomPersistentBundle {
  readonly scope: DeviceScope;
  readonly generation: number;
  readonly bloomHorizontalPipeline: RhiRenderPipeline | null;
  readonly bloomVerticalPipeline: RhiRenderPipeline | null;
  readonly bloomCompositePipeline: RhiRenderPipeline | null;
  readonly bloomHorizontalBindGroupLayout: BindGroupLayout | null;
  readonly bloomVerticalBindGroupLayout: BindGroupLayout | null;
  readonly bloomCompositeBindGroupLayout: BindGroupLayout | null;
  readonly bloomSampler: Sampler | null;
  readonly bloomHorizontalParamsBuffer: Buffer | null;
  readonly bloomVerticalParamsBuffer: Buffer | null;
  readonly bloomCompositeParamsBuffer: Buffer | null;
}

export interface PipelineState {
  /** Device that owns every opaque handle in this pipeline state. */
  readonly device: RhiDevice;
  readonly format: TextureFormat;
  readonly colorAttachmentFormat: TextureFormat;
  /** Surface route committed by configureSurface for inspection provenance. */
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  readonly viewBindGroupLayout: BindGroupLayout;
  /** Device capability gate for the optional SpotLight projector binding. */
  readonly projectorAvailable?: boolean;
  readonly materialBindGroupLayout: BindGroupLayout;
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly viewUniformBuffer: Buffer;
  readonly pointsLinesViewBuffer?: Buffer;
  readonly ensurePointsLinesViewCapacity?: (slots: number) => void;
  readonly shadowCasterCascadeBuffer: Buffer;
  readonly materialUniformBuffer: MeshSsboBufferWrapper;
  readonly meshStorageBuffer: MeshSsboBufferWrapper;
  readonly instancesBindGroupLayout: BindGroupLayout;
  /** Probe-enabled slot-3 layout; omitted from no-probe bind groups. */
  readonly probeInstancesBindGroupLayout?: BindGroupLayout;
  readonly identityInstanceBuffer: Buffer;
  readonly defaultSampler: Sampler;
  /** Nearest/clamp sampler required by r32float Surface depth input. */
  readonly surfaceMediumDepthSampler?: Sampler;
  readonly fallbackTextureView: TextureView;
  readonly unlitPipeline: RhiRenderPipeline | null;
  /** Producer-resolved Standard PBR UV ABI count for geometry projection. */
  readonly standardPbrShaderUvSetCount: number;
  readonly unlitPipelineMsaa: RhiRenderPipeline | null;
  readonly unlitPipelineHdrMsaa: RhiRenderPipeline | null;
  readonly pbrPipelineLayout: PipelineLayout | null;
  /** Dedicated slot-3 layout for scene-index GPU-driven Standard PBR draws. */
  readonly gpuDrivenInstancesBindGroupLayout?: BindGroupLayout | null;
  /** Direct Surface slot-3 ABI: instances + retained medium frame resources. */
  readonly surfaceDirectInstancesBindGroupLayout?: BindGroupLayout | null;
  readonly gpuDrivenPbrPipelineLayout?: PipelineLayout | null;
  /** Device-owned shader modules paired with their exact Standard PBR receipts. */
  readonly gpuDrivenPbrPrograms?: ReadonlyMap<string, GpuDrivenPbrProgram>;
  readonly gpuDrivenPbrSkinPipelineLayout?: PipelineLayout | null;
  /** Clustered group(2) layouts paired with the scene-index slot(3). */
  readonly gpuDrivenClusterPbrPipelineLayout?: PipelineLayout | null;
  readonly gpuDrivenClusterPbrSkinPipelineLayout?: PipelineLayout | null;
  readonly gpuDrivenClusterMeshBindGroupLayout?: BindGroupLayout | null;
  readonly pbrProbePipelineLayout?: PipelineLayout | null;
  readonly hdrpPbrPipelineLayout: PipelineLayout | null;
  readonly hdrpMeshBindGroupLayout?: BindGroupLayout | null;
  readonly hdrpProbePbrPipelineLayout?: PipelineLayout | null;
  readonly hdrpClusterMembershipPipeline: ComputePipeline | null;
  readonly hdrpClusterMembershipBindGroupLayout: BindGroupLayout | null;
  readonly pbrSkinPipelineLayout: PipelineLayout | null;
  readonly pbrSkinProbePipelineLayout?: PipelineLayout | null;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpSkinPipelineLayout: PipelineLayout | null;
  readonly hdrpSkinProbePipelineLayout?: PipelineLayout | null;
  readonly hdrpSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly defaultWhiteTextureView: TextureView;
  readonly defaultNormalTextureView: TextureView;
  /** White volume for `texture_3d` material params before their source promotes. */
  readonly defaultWhite3dTextureView?: TextureView;
  /** White array for `texture_2d_array` material params before their source promotes. */
  readonly defaultWhite2dArrayTextureView?: TextureView;
  /** Missing anisotropy maps encode a neutral direction and unit strength. */
  readonly defaultAnisotropyTextureView?: TextureView;
  readonly unlitPipelineHdr: RhiRenderPipeline | null;
  readonly shadowFallbackTextureView: TextureView;
  /** Two-layer depth array cleared to 0 (Reverse-Z far) for unshadowed directional/spot bindings. */
  readonly shadowArrayFallbackTextureView: TextureView;
  readonly shadowAtlasFallbackTextureView: TextureView;
  readonly extendedLightingAvailable?: boolean;
  readonly atmosphereAvailable?: boolean;
  readonly viewLinearSampler?: Sampler;
  readonly atmosphereFallbackView?: TextureView | undefined;
  readonly iesProfileTexture?: Texture;
  readonly cookieTexture?: Texture;
  readonly cookieMatrixBuffer?: Buffer;
  spotModifierUploadState?: {
    readonly ies: Map<number, number>;
    readonly cookie: Map<number, number>;
    readonly cookieMatrix: Map<number, number>;
  };
  readonly iesProfileTextureView?: TextureView;
  readonly cookieTextureView?: TextureView;
  readonly ltcLambertTextureView?: TextureView;
  readonly ltcGgxTextureView?: TextureView;
  readonly shadowParamsBuffer: Buffer;
  readonly skylightFallback: SkylightFallback | null;
  readonly perPassResources: PerPassResources;
}

export interface RenderSystemInternals extends RenderSystemRuntime {
  /** Renderer-owned screen UI is encoded after all views, before the one submit. */
  encodePresentation?: (encoder: RhiCommandEncoder) => void;
  /** Optional final display target; private camera selection remains with viewOutput. */
  readonly presentationOutput?: Texture | undefined;
  featureSceneInputs?: ReturnType<
    typeof import('../assembly/feature-scene-inputs').createFeatureSceneInputs
  >;
  framePassNames?: string[];
  submittedPassNames?: readonly string[];
  readonly canvas: Pick<HTMLCanvasElement, 'width' | 'height'>;
  readonly viewOutput?:
    | {
        readonly texture: Texture;
        readonly width: number;
        readonly height: number;
        readonly eye?: import('../components/stereo-camera').StereoEye;
      }
    | undefined;
  /** Build identity injected by the host's build-tool adapter. */
  readonly build?: string | undefined;
  /** Host identity binding for the renderer-owned SSR dependency seam. */
  readonly ssrIdentity?: SsrAdmissionIdentity | undefined;
  readonly captureReflectionFallbackReadback?: boolean | undefined;
  readonly shadowWorkload?: boolean | undefined;
  readonly standardProfile?: StandardProfile | undefined;
  readonly standardPipeline: RenderFrameState['activePipeline'];
  readonly featureHost?: RenderFeatureHost | undefined;
  readonly sharedFeatureGpuWork?: import('../features/prepared-gpu-work').RenderFeatureGpuWorkOwner;
  /** Install a detached feature host only at the recovery publication boundary. */
  readonly setFeatureHost?: ((host: RenderFeatureHost) => void) | undefined;
  readonly shaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly createShaderModule?: (
    device: import('@forgeax/engine-rhi').RhiDevice,
    descriptor: { readonly code: string; readonly label?: string },
  ) => Promise<
    Result<import('@forgeax/engine-rhi').ShaderModule, import('@forgeax/engine-rhi').RhiError>
  >;
  /** Optional handle-first factory for feature-owned generated shader programs. */
  readonly immediateShaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly profiler?: Profiler | undefined;
  readonly context: RhiCanvasContext | null;
  readonly getPipelineState: () => PipelineState | null;
  readonly assets: AssetRegistry;
  readonly gpuStore: import('../device/gpu-residency').GpuResidencyCache;
  readonly buildPostProcessPipeline?:
    | ((
        entry: import('../fullscreen-post-process-pass').PostProcessShaderEntry,
        bgl: BindGroupLayout,
        colorFormats: readonly GPUTextureFormat[],
        label: string,
      ) => RhiRenderPipeline | null)
    | undefined;
  rendererFrameNumber?: number | undefined;
  /** Renderer-owned diffuse GI budget split shared by every CameraView's field. */
  giBudget?: import('../raytracing/diffuse-gi-budget').DiffuseGiBudget | undefined;
  rendererCaptureOwner?: import('../capture/renderer-captures').RendererCaptureOwner | undefined;
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingViewId?: number | undefined;
  gpuPassTimingSubmittedWork?: Promise<void> | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
  readonly getRenderTargetPhysical?: (target: RenderTarget) => RenderTargetPhysical | undefined;
  readonly markRenderTargetSubmitted?: (
    target: RenderTarget,
    physical: RenderTargetPhysical,
  ) => void;
  readonly encodeRenderTargetReadbacks?: (
    encoder: RhiCommandEncoder,
    written?: readonly import('../assembly/render-target-host').RenderTargetLayerWrite[],
  ) => void;
  readonly encodeFramebufferSnapshots?:
    | ((
        encoder: RhiCommandEncoder,
        source: import('../targets/framebuffer-snapshot').FramebufferSnapshotSource,
      ) => void)
    | undefined;
  /** Composed renderer utility sources installed atomically at build-ready. */
  volumetricFogShaders?: VolumetricFogShaderSources | undefined;
  /** Composed renderer utility sources installed atomically at build-ready. */
  ssrShaders?: SsrShaderSources | undefined;
  depthPyramidShaders?: DepthPyramidShaderSources | undefined;
  /** Composed renderer utility sources installed atomically at build-ready. */
  atmosphereShaders?: AtmosphereShaderSources | undefined;
}

export interface _StandardForwardSceneView {
  readonly cameraVisible?: (
    source: import('../render-system-extract').RenderableSnapshot,
  ) => boolean;
  readonly capturedAtmosphere?: import('../environment/storage').AtmosphereStorage | undefined;
  readonly visibleSurface?: import('../raytracing/visible-surface').VisibleSurfaceProjection;
  readonly environmentIbl?: { readonly irradiance: TextureView; readonly prefilter: TextureView };
  readonly captureDispatch?: DispatchList;
  readonly assets: AssetRegistry;
  readonly store: import('../device/gpu-residency').GpuResidencyCache;
  readonly planarReflectionView?: TextureView;
  readonly pipelineState: PipelineState;
  readonly bloomResources?: BloomPersistentBundle | null;
  readonly runtime: RenderSystemRuntime;
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly scenePassWork?: ReadonlyMap<
    import('./scene-pass-work').ScenePassRequest,
    import('./scene-pass-work').ScenePassDraws
  >;
  /** Residency-validated explicit preparation rows, including hidden meshes. */
  readonly pipelinePreparationEntries?: readonly ValidatedRenderable[];
  /** Existing scene owner policy, also available before its first GPU batch. */
  readonly gpuDrivenGeometryLane?: 'automatic' | 'direct';
  readonly gpuDrivenShadowPreparationArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  readonly viewBindGroup: BindGroup | null;
  /** Dynamic View-UBO slot used by auxiliary cube/probe face cameras. */
  readonly viewBindGroupDynamicOffset?: number;
  /** Bind the translucent View copy matching each blended draw's composition. */
  readonly translucentFog?: boolean;
  readonly meshBindGroup: BindGroup | null;
  readonly frameState: RenderFrameState;
  readonly dispatchCounts: DispatchCounts;
  readonly bindGroupCounts: BindGroupCounts;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly profilePhase?: <T>(phase: RenderRecordPhase, action: () => T) => T;
  /** Why the CPU directional cache cannot reuse its layers; undefined on reuse. */
  readonly shadowUpdatePolicy?: (
    identity: import('../gpu-driven/shadow-views').ShadowViewIdentity,
  ) =>
    | {
        readonly blur?: { readonly radius: number; readonly samples: number };
        readonly channels?: number;
        readonly auto: boolean;
        readonly revision: import('./shadow-raster-ledger').ShadowUpdateRevision;
        readonly viewport?: readonly [number, number];
      }
    | undefined;
  readonly directionalShadowCacheMiss: ShadowViewInvalidationReason | undefined;
  /** Authored CPU cascade decision; absent preserves the whole-map policy. */
  readonly directionalShadowCascadeMiss?:
    | readonly (ShadowViewInvalidationReason | undefined)[]
    | undefined;
  readonly world: RenderResourceScope;
  readonly resourceScopes?: readonly RenderResourceScope[];
  readonly tonemapActive: boolean;
  readonly geometryDepthKey: string | null;
  readonly skyboxActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly transparentColorFormat?: GPUTextureFormat;
  /** Second Standard main-pass attachment used by the fallback producer. */
  readonly reflectionFallbackColorFormat?: GPUTextureFormat;
  readonly dispatch: DispatchList;
  readonly hdrpClusterBindGroup: BindGroup | null;
  readonly hdrpClusterMembershipBindGroup: BindGroup | null;
  /** Prepared Standard lighting declaration accepted by this graph frame. */
  readonly standardLighting?: StandardTopologyInputValue;
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly materialSlotIndices: readonly (readonly number[])[];
  readonly materialSlots: readonly MaterialSnapshot[];
  readonly materialBindings: readonly import('./fold-buckets').MaterialBinding[];
  readonly materialSlotCount: number;
  /** Filled by main-pass material producers before the GPU-driven raster tail. */
  readonly gpuDrivenStandardPbrFrameResources?: GpuDrivenStandardPbrFrameResources;
  /** Scene table retained by the renderer even when no draw is GPU-admitted. */
  readonly gpuDrivenSceneMaterialBuffer?: Buffer;
  /** Accepted main-pass ownership shared with the post-submit draw receipts. */
  readonly gpuDrivenSelection?: import('../gpu-driven/draw-selection').GpuDrawSelection;
  readonly gpuDrivenShadowViews?: ShadowViewStatePool;
  readonly shadowDirectRequired?: boolean;
  readonly gpuDrivenShadowBatchProjections?: ReadonlyMap<
    string,
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>
  >;
  readonly materialFrame?: import('../scene/material-dispatch').MaterialFrame;
  readonly shadowSlotForEntity?: (
    worldId: number,
    entityKey: number,
  ) => { readonly slot: number; readonly generation: number } | undefined;
  /** Per-shadow-view frusta shared by GPU compaction and CPU draw routing. */
  readonly shadowViewPlanesByView?: ReadonlyMap<string, Float32Array>;
  /** Capsule-ready casters leave the directional cascades (Deferred lane only). */
  readonly capsuleShadowDirectional?: boolean;
  /** Shading light for capsule shadows; present when admitted casters left the cascades. */
  readonly capsuleShadowLight?: {
    readonly direction: ArrayLike<number>;
    readonly coneHalfAngle: number;
    /** Accepted source roster, including camera-culled casters, independent of draw passes. */
    readonly renderables: FrameList<import('../render-system-extract').RenderableSnapshot>;
  };
  /** Record-owned finalized dispatch facts shared by capture and shadow graph views. */
  /** Same-frame stock material admission shared by graph predicates and record passes. */
  readonly mainPassMaterialSelection?: import('./main-pass').MainPassMaterialSelectionOwner;
  /** Complete retained ShadowCaster rows, including camera-culled casters. */
  readonly shadowValidatedOrdered?: readonly ValidatedRenderable[];
  /** Dispatch entries remapped to the complete retained ShadowCaster rows. */
  readonly shadowDispatch?: DispatchList;
  /** Shadow row base in materialSlotIndices; physical mesh addresses live on each draw. */
  readonly shadowMaterialRowBase?: number;
  /** Renderer-stable world keys used by ShadowCaster ownership identities. */
  readonly shadowCasterWorldKeys?: readonly number[];
  readonly shadowCasterBounds?: PersistentShadowCasterProjection['worldBoundsOf'];
  readonly pointsLines: PointsLinesRecordOwner | undefined;
  readonly materialBgAssemblyCache: MaterialBgAssemblyCache;
  /** Record-stage proof callback; invoked only after a real draw command is encoded. */
  readonly onRenderableDraw?: (
    entry: Pick<ValidatedRenderable, 'source'>,
    submeshIndex?: number,
    receipt?: import('./gpu-draw-receipts').RenderableDrawReceipt,
  ) => void;
  readonly reflectionProbes?: ReflectionProbeRecordState;
  hdrpSsaoBlurredView?: TextureView;
}

export type _InternalRenderPipelineContext = RenderPipelineContext & _StandardForwardSceneView;

export type RecordProfileRunner = <T>(phase: RenderRecordPhase, action: () => T) => T;

/** Runs `action` inside `phase` when a profiler runner is attached; otherwise calls it directly. */
export function runRecordProfilePhase<T>(
  runner: RecordProfileRunner | undefined,
  phase: RenderRecordPhase,
  action: () => T,
): T {
  return runner === undefined ? action() : runner(phase, action);
}

export const STANDARD_PBR_UBO_SIZE = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA).uboLayout.totalBytes;
export const MATERIAL_UNIFORM_BYTES = STANDARD_PBR_UBO_SIZE + (MAX_CLIPPING_PLANES + 1) * 16;
export const MATERIAL_PER_ENTITY_STRIDE = Math.ceil(MATERIAL_UNIFORM_BYTES / 256) * 256;

export type SwapChainFormatPair = {
  readonly storage: GPUTextureFormat;
  readonly view: GPUTextureFormat;
  readonly fallbackReason?: 'preferred-canvas-format-missing';
};

/** Internal closed projection of the concrete surface route. */
export type SurfaceProfile =
  | {
      readonly kind: 'dual-view';
      readonly storageFormat: GPUTextureFormat;
      readonly viewFormat: GPUTextureFormat;
      readonly viewFormats: readonly [GPUTextureFormat];
      readonly hasDisplayEndpoint: true;
    }
  | {
      readonly kind: 'raw-only';
      readonly storageFormat: GPUTextureFormat;
      readonly viewFormat: GPUTextureFormat;
      readonly viewFormats: readonly [];
      readonly hasDisplayEndpoint: false;
    };

export interface SurfaceCapabilityFacts {
  /** Concrete wgpu downlevel `SURFACE_VIEW_FORMATS` flag. */
  readonly surfaceViewFormats: boolean;
  readonly rawAttachment: boolean;
  readonly floatRenderAttachment: boolean;
}

export function resolveSurfaceProfile(
  storageFormat: GPUTextureFormat,
  viewFormat: GPUTextureFormat,
  facts: SurfaceCapabilityFacts,
): Result<SurfaceProfile, RhiError> {
  if (facts.surfaceViewFormats) {
    return ok({
      kind: 'dual-view',
      storageFormat,
      viewFormat,
      viewFormats: [viewFormat],
      hasDisplayEndpoint: true,
    });
  }
  if (!facts.rawAttachment || !facts.floatRenderAttachment) {
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'raw surface attachment and rgba16float render attachment capabilities',
        hint: 'surface profile cannot establish a raw-only linear output route',
        detail: {
          error: {
            code: 'surface-raw-endpoint-failed',
            message: 'raw-only surface capabilities are incomplete',
          },
        },
      }),
    );
  }
  return ok({
    kind: 'raw-only',
    storageFormat,
    viewFormat: storageFormat,
    viewFormats: [],
    hasDisplayEndpoint: false,
  });
}

function surfaceCapabilityFacts(
  device: RhiDevice,
  storageFormat: GPUTextureFormat,
): SurfaceCapabilityFacts {
  const internal = device as unknown as { readonly surfaceViewFormats?: boolean };
  return {
    surfaceViewFormats: internal.surfaceViewFormats ?? device.caps?.backendKind !== 'wgpu-webgl2',
    rawAttachment: storageFormat === 'rgba8unorm' || storageFormat === 'bgra8unorm',
    floatRenderAttachment: device.caps?.rgba16floatRenderable ?? true,
  };
}

/**
 * Configure the canvas surface and negotiate its presentation colour space.
 * sRGB keeps the spec default (no `colorSpace` member). Display P3 is
 * requested explicitly and verified through `getConfiguration()`; any
 * rejection or absence reconfigures the default sRGB surface and returns a
 * structured fallback so the Output Transform never encodes a gamut the
 * surface does not present.
 */
export function configureSurface(
  context: RhiCanvasContext,
  device: RhiDevice,
  format: TextureFormat,
  colorAttachmentFormat: TextureFormat,
  colorSpace: OutputColorSpace = 'srgb',
): Result<OutputColorSpaceReport, RhiError> {
  const backendKind = device.caps?.backendKind ?? 'webgpu';
  const isWebGl2 = backendKind === 'wgpu-webgl2';
  const surfaceFormats: SwapChainFormatPair = { storage: format, view: colorAttachmentFormat };
  const profile = resolveSurfaceProfile(
    surfaceFormats.storage,
    surfaceFormats.view,
    surfaceCapabilityFacts(device, surfaceFormats.storage),
  );
  if (!profile.ok) return profile;
  // WebGL2 surface pixels are proven by the compositor fixture, so it has no
  // surface consumer for optional TEXTURE_BINDING/COPY_SRC usage. The concrete
  // wgpu surface derives supported usages from SurfaceCapabilities and rejects
  // unsupported requests; this path requests only the guaranteed attachment
  // usage. Raw-only deliberately has no alternate view.
  const supportsTextureBinding =
    backendKind !== 'wgpu-webgl2' && (device.caps?.storageBuffer ?? true);
  const modes = context.supportedAlphaModes;
  const alphaMode =
    modes === undefined
      ? isWebGl2
        ? 'opaque'
        : 'premultiplied'
      : modes.includes('premultiplied')
        ? 'premultiplied'
        : modes.includes('opaque')
          ? 'opaque'
          : undefined;
  if (alphaMode === undefined)
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the concrete surface supports a canvas composition mode',
        hint: 'the surface advertised no supported alpha modes; recreate a usable presentation target',
      }),
    );
  const descriptor = {
    device,
    format: surfaceFormats.storage,
    alphaMode,
    usage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      (supportsTextureBinding ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
      (isWebGl2 ? 0 : GPU_TEXTURE_USAGE_COPY_SRC),
    viewFormats: [...profile.value.viewFormats],
  } satisfies CanvasConfiguration;
  let colorSpaceReport: OutputColorSpaceReport = appliedOutputColorSpace('srgb');
  if (colorSpace === 'display-p3') {
    const wide = context.configure({ ...descriptor, colorSpace: 'display-p3' });
    colorSpaceReport = wide.ok
      ? observeDisplayP3Configuration(context.getConfiguration())
      : outputColorSpaceFallback('configure-rejected', wide.error.code);
  }
  if (colorSpaceReport.effective === 'srgb') {
    const configured = context.configure(descriptor);
    if (!configured.ok) return configured;
  }
  if (
    isWebGl2 &&
    (context.presentationProof === undefined ||
      !context.presentationProof.descriptor ||
      !context.presentationProof.acquisition ||
      !context.presentationProof.validation ||
      typeof context.presentationProof.surfaceIdentity !== 'string' ||
      context.presentationProof.surfaceIdentity.length === 0 ||
      context.presentationProof.requested === undefined ||
      context.presentationProof.validated === undefined ||
      JSON.stringify(context.presentationProof.requested) !==
        JSON.stringify(context.presentationProof.validated))
  ) {
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'WebGL2 surface storage has descriptor, acquisition, and validation proof',
        hint: 'run the concrete presentation probe and retain the last-known-good graph when proof is absent',
        detail: {
          error: {
            code: 'surface-raw-endpoint-failed',
            message: 'surface storage raw endpoint proof is incomplete',
          },
        },
      }),
    );
  }
  return ok(colorSpaceReport);
}

/**
 * Configure the surface for `state` and commit what a successful configure
 * proves: the pipeline's configured flag, the negotiated colour-space report,
 * and the swap-chain format probe.
 */
export function configurePipelineSurface(
  context: RhiCanvasContext,
  device: RhiDevice,
  state: PipelineState,
  outputColorSpace: OutputColorSpaceState | undefined,
): Result<void, RhiError> {
  const configured = configureSurface(
    context,
    device,
    state.format,
    state.colorAttachmentFormat,
    outputColorSpace?.requested,
  );
  if (!configured.ok) return configured;
  state.perPassResources.configured = true;
  if (outputColorSpace !== undefined) outputColorSpace.report = configured.value;
  (globalThis as { __forgeaxSwapChainFormat?: TextureFormat }).__forgeaxSwapChainFormat =
    state.format;
  return ok(undefined);
}

export function selectSwapChainFormat(
  storageBufferCapable: boolean,
  surfaceViewFormats = true,
): SwapChainFormatPair {
  if (!storageBufferCapable) {
    return {
      storage: 'rgba8unorm',
      view: surfaceViewFormats ? 'rgba8unorm-srgb' : 'rgba8unorm',
    };
  }
  const nav = (
    globalThis as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }
  ).navigator;
  const gpu = nav?.gpu;
  const getPreferred = gpu?.getPreferredCanvasFormat;
  if (gpu !== undefined && typeof getPreferred === 'function') {
    const storage = getPreferred.call(gpu);
    const view =
      storage === 'rgba8unorm'
        ? 'rgba8unorm-srgb'
        : storage === 'bgra8unorm'
          ? 'bgra8unorm-srgb'
          : storage;
    return {
      storage,
      view: surfaceViewFormats ? view : storage,
    };
  }
  return {
    storage: 'rgba8unorm',
    view: surfaceViewFormats ? 'rgba8unorm-srgb' : 'rgba8unorm',
    fallbackReason: 'preferred-canvas-format-missing',
  };
}
