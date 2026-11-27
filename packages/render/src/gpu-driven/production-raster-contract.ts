import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroupLayout, Buffer, Result, RhiError, TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenStructureMetrics } from '../inspection-types';
import type {
  PipelineState,
  RecordProfileRunner,
  RenderSystemInternals,
} from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type {
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineGpuDrivenTarget,
} from '../render-pipeline';
import type { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import type { SurfaceGpuSubmissionAdmission } from '../surface/gpu-driven';
import type { SurfaceSubmissionCandidate } from '../surface/submission-observation';
import type { GpuDrivenBatchBinding } from './batch-topology';
import type { GpuDrawSelection } from './draw-selection';
import type { GBufferOrderDiagnosticConfig } from './gbuffer-order-diagnostic';
import type { BatchExecutions } from './material-artifacts';
import type { GpuDrivenShadowBatchProjection } from './production-raster-shadow';
import type {
  ShadowCameraCullDilation,
  ShadowViewGraphProjection,
  ShadowViewIdentity,
  ShadowViewStatePool,
  ShadowViewUpdateInput,
} from './shadow-views';
import type { GpuDrivenLodSubmitIdentity, GpuDrivenView } from './view-gpu';

/**
 * A shadow view the frame asks for. Its camera cull names only the receiver
 * dilation; the main camera it tests against is the one the pyramid was built
 * from, attached here so the two cannot diverge.
 */
export type ShadowViewRequest = Omit<
  ShadowViewUpdateInput,
  'sourcePlan' | 'scene' | 'cameraCull' | 'inputReads' | 'skin' | 'capsuleDirectional'
> & {
  readonly cameraCull?: ShadowCameraCullDilation;
  /**
   * `false` projects a final view once with every caster and retains no
   * static layer for it. Absent keeps the cached static layer.
   */
  readonly staticLayer?: false;
};

export type MaterialPipelineFactory = NonNullable<
  RenderSystemInternals['getMaterialShaderPipelineEntry']
>;

/** The GPU-driven bridge to the existing four-group Standard PBR pipeline. */
export interface GpuDrivenMaterialBinding {
  readonly material: import('../material-resource').MaterialResource;
  readonly resourceClass: string;
}

export interface CurrentCameraRaster extends RenderPipelineGpuDrivenProjection {
  /** Retire class records when their last camera draw leaves the actual roster. */
  readonly stageCameraClasses?: () => void;
}

export interface PreparedGpuDrivenFrame {
  /** Shared resource requirements from the accepted geometry/probe partitions. */
  readonly materialBindings: readonly GpuDrivenMaterialBinding[];
  readonly shadowDirectRequired: boolean;
  /** Read after current shadow preparation; this is not a captured signature value. */
  readonly topologySignature: () => string;
  /** @internal Private stock-recorder identity; borrowed graph projections keep topologySignature. */
  readonly _recordingTopologySignature?: () => string;
  /** Physical camera ABI and scene identity, independent of the shadow view roster. */
  readonly cameraRasterIdentity?: string;
  /** Current ordinary camera kernels and its producer-owned physical draw inputs. */
  readonly cameraView?: GpuDrivenView;
  readonly captureCameraMeshes?: () => void;
  readonly projectCamera?: (
    target: RenderPipelineGpuDrivenTarget,
  ) => Result<CurrentCameraRaster, RenderGraphError | RhiError>;
  /** Shared execution queried by each actual draw consumer. */
  readonly selection: GpuDrawSelection;
  /** Actual GPU Shadow executions; direct residual casters do not erase this coverage. */
  readonly shadowSelection?: GpuDrawSelection | undefined;
  readonly standardPbrFrameResources: GpuDrivenStandardPbrFrameResources;
  /** Published Surface admission and its pass lane decision. */
  readonly surfaceSubmission?: SurfaceGpuSubmissionAdmission;
  /** @internal Pins physical work independently of accepted frame publication. */
  readonly _trackSubmittedWork: (completed: Promise<void>) => void;
  /** @internal Close actual main/shadow demands before independent submission. */
  readonly _sealResourceReads: () => Result<void, RhiError>;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: (submittedGraphGeneration?: number) => void;
  /** @internal Retires superseded view buffers when graph compilation promotes them. */
  readonly _commitGpuResourceReplacement?: () => void;
  /** @internal Discards staged shadow cache publication after a failed frame. */
  readonly _abortResourceReplacement?: () => void;
  /** @internal Marks validated dynamic ranges consumed only after queue submit. */
  readonly _consumeSurfaceDynamicInput?: (frameNumber: number) => Result<void, RhiError>;
  /** `cameraPyramid` is the main camera's late HZB; eligible views cull against it. */
  readonly projectShadow?: (
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    identity: ShadowViewIdentity,
    forceCompute?: boolean,
    cameraPyramid?: GraphTextureView,
  ) => Result<ShadowViewGraphProjection | undefined, RenderGraphError>;
  readonly updateShadowViews?: (
    views: readonly ShadowViewRequest[],
    /** @internal Transfer fresh recorder requests; borrowed callers omit this. */
    ownedRequests?: true,
  ) => Result<void, RhiError>;
  readonly shadowViewPool?: ShadowViewStatePool;
  readonly shadowBatchProjections?: () => ReadonlyMap<
    string,
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>
  >;
  project(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    additionalColorFormats?: readonly TextureFormat[],
    lateOcclusion?: boolean,
    /** @internal Only the private stock Renderer recording closure supplies this. */
    rendererRecording?: boolean,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError>;
}

/** Graph construction consumes physical owners and demand, never a frame read lease. */
export type GpuDrivenGraphProjection = Pick<
  PreparedGpuDrivenFrame,
  | 'topologySignature'
  | '_recordingTopologySignature'
  | 'cameraRasterIdentity'
  | 'cameraView'
  | 'projectCamera'
  | 'captureCameraMeshes'
  | 'project'
  | 'projectShadow'
  | 'shadowViewPool'
>;

export interface GpuDrivenPrepareInput {
  readonly materialArtifactResolver?: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly materialShaderRegistry?: RenderSystemInternals['shaderRegistry'];
  readonly materialFrame?: import('../scene/material-dispatch').MaterialFrame;
  readonly shadowMaterials?: ShadowMaterialContent;
  readonly shadowViews?: boolean;
  readonly scene: PersistentGpuDrivenState | undefined;
  readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
  /** The already selected frame lane; Surface still shares its retained resource owner. */
  readonly geometryLane?: 'automatic' | 'direct';
  readonly gbufferBatchOrderDiagnostic?: GBufferOrderDiagnosticConfig | undefined;
  readonly visibleSurface?: import('../raytracing/visible-surface').VisibleSurfaceProjection;
  readonly camera: CameraSnapshot;
  /** Shared mesh residency, independent of the number of bound scene members. */
  readonly meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly viewBindGroupLayout: BindGroupLayout;
  /** Optional for legacy Standard callers; omitted means non-HDRP. */
  readonly hdrp?: boolean;
  /** Explicit Standard topology; cluster resources are bound by main-pass. */
  readonly clustered?: boolean;
  readonly materialBindingClasses?: ReadonlyMap<string, string>;
  /** Cooked producer artifact selected from the frame material catalog. */
  readonly materialArtifact?: MaterialShaderArtifact;
  /** Cooked producer artifact for the GPU skinning variant. */
  readonly materialSkinArtifact?: MaterialShaderArtifact;
  /** Per-draw producer artifacts keyed by prepared identity and receipt. */
  readonly materialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  /** Per-draw shadow-pass artifacts keyed by the same prepared identity. */
  readonly shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  /** Retained ProbeBlend record page; slot N is addressed at aligned lane N+1. */
  readonly probeBlendRecordBuffer?: Buffer;
  readonly materialPipelineState?: PipelineState;
  /** Existing renderer owner that builds the selected artifact PSO/BGL. */
  readonly materialPipelineFactory?: MaterialPipelineFactory;
  readonly materialPipelinePreparationFactory?: MaterialPipelineFactory;
  /** Capsule-ready casters leave the directional cascades (Deferred lane only). */
  readonly capsuleShadowDirectional?: boolean;
  /** One-cascade Vogel receiver: forward colour pipelines take the simple Standard variant. */
  readonly directionalShadowSimple?: boolean;
  readonly leanLighting?: boolean;
  readonly forwardInlineSsr?: boolean;
  /** Entity keys admitted by the persistent visibility facet for this view. */
  readonly activeEntityKeys?: ReadonlySet<number>;
  /** Collision-free renderer-owned revision for the active visibility set. */
  readonly activeEntityRevision?: number;
  /** Total extracted candidates, including facet-suppressed rows. */
  readonly telemetryCandidateCount?: number;
  /** Public receipt identity for the GPU telemetry copy encoded this frame. */
  readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
  /** Per-frame deltas from the existing RenderScene/GPU Scene/palette owners. */
  readonly structureMetrics?: GpuDrivenStructureMetrics;
  /** World/App frame-time snapshot consumed by authored Surface code. */
  readonly frameTime?: number;
  /** Current RHI device generation used for Surface admission. */
  readonly deviceGeneration?: number;
  /** Renderer-owned generic read-only Surface page and instance ranges. */
  readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
  /** Direct GPU-vertex draws borrowing the same renderer-owned Surface page. */
  readonly directSurface?: {
    readonly artifact: MaterialShaderArtifact;
    readonly ranges: NonNullable<SurfaceDynamicInputFrame['ranges']>;
  };
  /** Optional profiler seam for the `record/gpu-driven-prepare/*` phases. */
  readonly profilePhase?: RecordProfileRunner;
}

/** The main and shadow filtered plans of one prepared plan, with their admission. */
export interface FilteredFrame {
  readonly preparedPlan: PreparedProductionPlan;
  readonly filtered: FilteredProductionPlan;
  readonly admission: SubmissionAdmission;
  readonly shadowFiltered: FilteredProductionPlan | undefined;
}

import type { FilteredProductionPlan, PreparedProductionPlan } from './production-raster-prepare';
import type { SubmissionAdmission } from './submission-admission';
