/** Public RenderFeature lifecycle, diagnostics, and host-context declarations. */
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { Asset, Result } from '@forgeax/engine-types';
import type { RenderError, RenderFeatureErrorDescriptor } from '../errors/render';
import type { VisibilitySnapshot } from '../extract/visibility';
import type {
  CameraSnapshot,
  FeatureTextureReadbackResult,
  FrameDomainObservation,
  FrameReceipt,
  RenderResult,
} from '../render-contract';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from './plan';
import type { RenderFeatureCapabilityKey } from './vocabulary';

export type {
  RenderFeatureCapabilityMissingDetail,
  RenderFeatureCleanupFailure,
  RenderFeatureDrawRecordingFailedDetail,
  RenderFeatureErrorCode,
  RenderFeatureErrorDescriptor,
  RenderFeaturePassOrderConflictDetail,
  RenderFeaturePreparationFailedDetail,
  RenderFeaturePreparedStateMismatchDetail,
  RenderFeatureRegistrationConflictDetail,
  RenderFeatureStageFailedDetail,
} from '../errors/render';
export type {
  RenderFeatureDispatch,
  RenderFeatureDraw,
  RenderFeatureDrawDeclaration,
  RenderFeatureFullscreenProgramDeclaration,
  RenderFeatureLogicalTarget,
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
  RenderFeatureResourceDeclaration,
  RenderFeatureResourceUsage,
  RenderFeatureWork,
  RenderFeatureWorkPlan,
  RenderFeatureWorkScope,
} from './plan';
export type { RenderFeatureTargetHandle } from './targets';
export type {
  PreparedKind,
  RenderFeatureCapabilityKey,
  RenderFeatureRecovery,
  RenderFeatureStage,
} from './vocabulary';

/** Opaque static bytes seeded by the physical owner once per allocation version. */
export interface RenderFeatureGpuBufferInitialization {
  readonly version: string;
  readonly byteLength: number;
  /** Fill a host-owned byte view for one physical buffer initialization. */
  copyInto(target: Uint8Array): boolean;
}

/** Closed lifecycle states exposed by the feature host. */
export type RenderFeatureStatus = 'active' | 'failed' | 'disabled' | 'disposed';

/** Actual Renderer receipt facts delivered after the published frame completes. */
export type RenderFeatureCompletion = Pick<
  FrameReceipt,
  'frameId' | 'deviceGeneration' | 'graphGeneration'
>;

/**
 * Graph placement for a producer-owned feature.
 *
 * `scene` is admitted after the opaque scene and before transmission,
 * ordinary transparency, and volumetric composition. `post` is admitted at
 * the existing post-TAA extension point. Keeping this as one closed value
 * lets the Standard owner place atmospheric transport without adding a
 * second renderer or a feature-specific side channel.
 */
export type RenderFeaturePlacement = 'scene' | 'after-depth' | 'after-tonemap' | 'post';

/**
 * Shader preparation policy for feature-owned GPU programs.
 *
 * `validated` waits for the backend's diagnostic-rich shader preparation before
 * exposing a module to the render graph. `immediate` is reserved for generated
 * feature programs that must hand a WebGPU module to pipeline creation without
 * serialising first-use on `getCompilationInfo()`; pipeline creation remains
 * the validation boundary for that mode.
 */
export type RenderFeatureShaderModuleMode = 'validated' | 'immediate';
/** Renderer-owned view facts shared by feature extraction and temporal owners. */
export interface RenderFeatureViewContext {
  readonly identity: string;
  readonly width: number;
  readonly height: number;
  readonly cameraRevision: number;
  readonly deviceGeneration: number;
  readonly cameraPosition: readonly [number, number, number];
  /** Stable world anchor for light-space cloud coverage (never screen-space). */
  readonly shadowAnchor?: readonly [number, number, number];
  readonly cameraCut?: boolean;
  readonly recovery?: boolean;
  readonly sceneDepthVersion?: number;
}

/** Normal frame projection consumed by feature owners at extract time. */
export interface RenderFeatureFrameContext {
  readonly cloudLayer?: import('../cloud/extract').ExtractedCloudLayer;
  /** Selected sun facts from the same View owner that writes the cloud View binding. */
  readonly cloudSun?: Pick<
    import('../render-system-extract').DirectionalLightSnapshot,
    'direction' | 'intensity'
  > &
    Partial<Pick<import('../render-system-extract').DirectionalLightSnapshot, 'color'>>;
  readonly view?: RenderFeatureViewContext;
  /** Captured selected atmosphere parameters; excludes continuous camera/sun motion. */
  readonly aerialPerspectiveIdentity?: string;
  readonly waterFoamMaterials?: readonly import('../water/fluid-foam').WaterFluidFoamMaterial[];
}

/** A producer's structured report for one hidden render candidate. */
export interface RenderFeatureHiddenEntityReport {
  readonly entity: EntityHandle;
}

export interface RenderFeatureExtractView {
  readonly identity: string;
  readonly render: boolean;
  /** Recorder allocation domain and whether its graph resources can be retained. */
  readonly graphResources?: RenderFeatureGraphResourceState;
  readonly frameSize?: { readonly width: number; readonly height: number };
  readonly frame?: RenderFeatureFrameContext;
  /**
   * Renderer-selected display camera for this frame. Features that affect the
   * display must derive their active plan from this snapshot instead of
   * scanning every Camera in the source World.
   */
  readonly selectedCamera?: CameraSnapshot;
  /** Derived matrices and basis for the selected view; never rescan World camera state. */
  readonly selectedView?: {
    readonly position: Float32Array;
    readonly right: Float32Array;
    readonly up: Float32Array;
    readonly viewProjection: Float32Array;
  };
}

export interface RenderFeatureGraphResourceState {
  /** Equality-only identity; ordinary graph recompilation preserves this owner. */
  readonly owner: object;
  readonly retained: boolean;
}

export interface RenderFeatureExtractContext {
  readonly world: World;
  readonly frameNumber: number;
  /**
   * Identity of the receiving render session for a cross-worker publication. It
   * changes when a new receiver (publication epoch) starts with empty caches, so a
   * producer that sends state once must send it again.
   */
  readonly receiverSession?: string;
  readonly views: readonly RenderFeatureExtractView[];
  readonly caps?: Readonly<RhiCaps>;
  /** Exact receiving renderer domain, when extraction runs after device admission. */
  readonly materialContext?: RenderFeaturePlanContext['materialContext'];
  readonly visibilitySnapshot?: VisibilitySnapshot | undefined;
  readonly reportHiddenEntity?: (report: RenderFeatureHiddenEntityReport) => void;
  /** Record a recoverable source retry while allowing a retained frame to proceed. */
  readonly reportError?: (error: RenderError) => void;
  /** @internal Open a producer-declared nested CPU work scope on the active Render World. */
  readonly beginProfileWork?: (
    work: string,
  ) => import('@forgeax/engine-ecs').ScheduleWorkScope | undefined;
  /**
   * A publication producer may replace an exactly matching captured payload
   * with its existing asset handle. An undefined result keeps the feature's
   * inline value authoritative (for example a custom provider's mesh).
   * Declare accepted handles through assetDependencies and resolve them in plan.
   */
  /** Capture a held exact version for in-flight work. The source asset identity stays unchanged. */
  readonly referenceAssetVersion?: (version: {
    readonly handle: number;
    readonly revision: number;
    readonly value: Asset;
  }) => void;
  readonly referenceAsset?: (identity: string | number, captured: Asset) => number | undefined;
}

/**
 * Renderer-owned projection that reached graph admission for one feature.
 * Producers may use this bounded receipt to distinguish declared plan work
 * from passes omitted during prepared-resource resolution.
 */
export interface RenderFeatureSubmission {
  readonly works: readonly {
    readonly scope: import('./plan').RenderFeatureWorkScope;
    readonly passes: readonly {
      readonly name: string;
      readonly shadowCaster?: true;
      readonly graphics?: { readonly draws: readonly { readonly kind: string }[] };
      /** Clone-safe count of resolved GPU dispatches for source acknowledgments. */
      readonly resolvedGpuComputeDispatchCount?: number;
      /** Resolved commands exclude validated zero-work direct dispatches. */
      readonly resolvedGpuCompute?: { readonly dispatches: readonly unknown[] };
    }[];
  }[];
}

/** Exact compiled graph-pass identities a feature may admit for one current view scope. */
export interface RenderFeatureProfileGraphPass {
  readonly view: string;
  /** Physical compiled name, including any feature-scope prefix. */
  readonly name: string;
  readonly kind: 'raster' | 'compute' | 'copy';
}

/**
 * Producer-owned extension seam for one render frame.
 *
 * `FrameData` is the single value that crosses extract into the mandatory
 * declarative plan. The host derives preparation, graph access, recording,
 * recovery, and retirement from that plan; no producer callback receives GPU
 * authority or maintains a parallel lifecycle.
 */
export interface RenderFeature<FrameData> {
  readonly identity: string;
  /** Canonical immutable idle value. Source extract returns this exact value to omit its wire row. */
  readonly inactiveSourceData?: FrameData;
  /**
   * Which capture faces (planar reflection, reflection probe, cube capture)
   * this Feature records into. Omitted means `display-only`; scene-content
   * Features such as GPU particles declare `all`. Cost scales with the number
   * of captured faces, so opt out when a Feature is not visible in reflections.
   */
  readonly capture?: import('../capture/feature-policy').RenderFeatureCapturePolicy;
  /** @internal Nested work names emitted through `beginProfileWork` during producer callbacks. */
  readonly profileWorkNames?: readonly string[];
  /** @internal Exact physical shared-graph identities that remain reachable but may not execute this frame. */
  readonly profileGraphPasses?: (
    viewScopes: readonly string[],
  ) => readonly RenderFeatureProfileGraphPass[];
  /** Optional graph placement; omitted features retain the historical post stage. */
  readonly placement?: RenderFeaturePlacement;
  /**
   * Opt into a separately validated view-local graph at the same pipeline stage.
   * The renderer retains the monolithic path for cross-stage or unsupported work.
   */
  readonly viewGraph?: 'transient';
  readonly requiredCapabilities?: readonly RenderFeatureCapabilityKey[];
  /** Optional feature-owned shader preparation policy; defaults to `validated`. */
  readonly shaderModuleMode?: RenderFeatureShaderModuleMode;
  /**
   * Material shader identifiers whose modules must be ready before the first
   * frame. The renderer resolves these against the loaded manifest and seeds
   * the same lazy module cache used by prepared graphics.
   */
  readonly requiredMaterialShaders?: readonly string[];
  /**
   * Fullscreen program sources that must be module-ready before the first
   * frame. The renderer seeds the same lazy post-process module cache used by
   * the typed graph, so a synchronous frame driver cannot observe a cleared
   * target while a boot-installed effect is compiling.
   */
  readonly requiredFullscreenPostProcesses?: readonly {
    readonly identity: string;
    readonly source: string;
  }[];
  extract(context: RenderFeatureExtractContext): Result<FrameData, RenderError>;
  /** Detached publication codec and source acknowledgments for a renderer-owned producer. */
  readonly source?: RenderFeature<unknown>;
  /** GUID closures or exact immutable handles consumed by the declarative plan. */
  assetDependencies?(data: FrameData): readonly (string | number)[];
  /**
   * Explicit source resource intent that must survive a failed plan. Returning
   * true keeps presentation pending when this frame cannot be planned/prepared.
   * This observes the detached extract value only; it grants no GPU authority.
   * Omitted/false preserves the ordinary optional-feature failure behavior.
   */
  requiresPreparation?(data: FrameData): boolean;
  plan(data: FrameData, context: RenderFeaturePlanContext): Result<RenderFeaturePlan, RenderError>;
  /**
   * Consume frame-owned producer state only after the compiled graph reached
   * queue submission.  The host invokes this callback at most once for the
   * extracted frame and never during declarative planning.
   */
  onFrameSubmitted?(data: FrameData, submission?: RenderFeatureSubmission): void;
  /** The existing receipt owner maps declared copies once, after GPU completion. */
  onFrameReceipt?(
    receipt: FrameReceipt,
    observations: Promise<RenderResult<readonly FrameDomainObservation[], RenderError>>,
  ): void;
  /**
   * Consume source-owned intents after submission; feedback must be structured-cloneable.
   * A sealed successor may have been extracted before this acknowledgment. Ordered
   * intent producers must identify already-submitted work instead of replaying it.
   */
  onSourceFrameSubmitted?(
    data: FrameData,
    feedback: unknown,
    submission?: RenderFeatureSubmission,
  ): void;
  /** Complete the exact submitted source publication before its storage is recycled. */
  onSourceFrameCompleted?(
    data: FrameData,
    completion: RenderFeatureCompletion,
    feedback: unknown,
    submission?: RenderFeatureSubmission,
    readbacks?: FeatureTextureReadbackResult,
  ): void;
  /**
   * The source publication that carried this extracted frame was discarded before
   * it was sent; producers that publish state once can mark it unsent again.
   */
  onSourceFrameDiscarded?(data: FrameData): void;
  /**
   * Discard frame-owned producer state when graph admission or submission is
   * rejected.  This is the symmetric recovery path for onFrameSubmitted.
   */
  onFrameAborted?(data: FrameData): void;
}

export interface RenderFeatureRecoverInput {
  readonly caps: Readonly<RhiCaps>;
  readonly frameNumber: number;
}

/** Read-only, machine-readable lifecycle state for one registered feature. */
export interface RenderFeatureDiagnostics {
  readonly identity: string;
  readonly order: number;
  readonly status: RenderFeatureStatus;
  readonly latestError: RenderFeatureErrorDescriptor | undefined;
  /** Optional producer-owned detached inspection snapshot from the latest extract. */
  readonly inspection?: unknown;
}
