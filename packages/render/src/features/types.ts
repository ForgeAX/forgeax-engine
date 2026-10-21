/** Public RenderFeature lifecycle, diagnostics, and host-context declarations. */
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { Asset, Result } from '@forgeax/engine-types';
import type { RenderError, RenderFeatureErrorDescriptor } from '../errors/render';
import type { VisibilitySnapshot } from '../extract/visibility';
import type { CameraSnapshot } from '../render-contract';
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

/** Closed lifecycle states exposed by the feature host. */
export type RenderFeatureStatus = 'active' | 'failed' | 'disabled' | 'disposed';

/**
 * Graph placement for a producer-owned feature.
 *
 * `scene` is admitted after the opaque scene and before transmission,
 * ordinary transparency, and volumetric composition. `post` is admitted at
 * the existing post-TAA extension point. Keeping this as one closed value
 * lets the Standard owner place atmospheric transport without adding a
 * second renderer or a feature-specific side channel.
 */
export type RenderFeaturePlacement = 'scene' | 'post';

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

/** One World-local visibility snapshot prepared for the current frame batch. */
export interface RenderFeatureWorldVisibilitySnapshot {
  readonly world: World;
  readonly snapshot: VisibilitySnapshot;
}

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
  readonly view?: RenderFeatureViewContext;
}

/** A producer's structured report for one hidden render candidate. */
export interface RenderFeatureHiddenEntityReport {
  readonly world: World;
  readonly entity: EntityHandle;
}

export interface RenderFeatureExtractView {
  readonly identity: string;
  readonly render: boolean;
  readonly frameSize?: { readonly width: number; readonly height: number };
  readonly frame?: RenderFeatureFrameContext;
  readonly motionBlur?: import('./motion-blur/motion-blur-feature').MotionBlurFeatureInput;
  /**
   * Renderer-selected display camera for this frame. Features that affect the
   * display must derive their active plan from this snapshot instead of
   * scanning every Camera in the composed worlds.
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

export interface RenderFeatureExtractContext {
  readonly worlds: readonly World[];
  readonly owner: number;
  readonly frameNumber: number;
  readonly views: readonly RenderFeatureExtractView[];
  readonly caps?: Readonly<RhiCaps>;
  /** Exact receiving renderer domain, when extraction runs after device admission. */
  readonly materialContext?: RenderFeaturePlanContext['materialContext'];
  readonly visibilitySnapshots?: readonly RenderFeatureWorldVisibilitySnapshot[];
  readonly reportHiddenEntity?: (report: RenderFeatureHiddenEntityReport) => void;
  /**
   * A publication producer may replace an exactly matching captured payload
   * with its existing asset handle. An undefined result keeps the feature's
   * inline value authoritative (for example a custom provider's mesh).
   * Declare accepted handles through assetDependencies and resolve them in plan.
   */
  /** Capture a held exact version for in-flight work. The source asset identity stays unchanged. */
  readonly referenceAssetVersion?: (
    sourceWorldIndex: number,
    version: { readonly handle: number; readonly revision: number; readonly value: Asset },
  ) => void;
  readonly referenceAsset?: (
    sourceWorldIndex: number,
    identity: string | number,
    captured: Asset,
  ) => number | undefined;
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
      /** Resolved commands exclude validated zero-work direct dispatches. */
      readonly resolvedGpuCompute?: { readonly dispatches: readonly unknown[] };
    }[];
  }[];
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
  /**
   * Consume source-owned intents after submission; feedback must be structured-cloneable.
   * A sealed successor may have been extracted before this acknowledgment. Ordered
   * intent producers must identify already-submitted work instead of replaying it.
   */
  onSourceFrameSubmitted?(data: FrameData, feedback: unknown): void;
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
