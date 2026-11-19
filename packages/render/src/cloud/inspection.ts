import type { RhiCaps } from '@forgeax/engine-rhi';
import type { CloudParameterValue } from './contracts';
/** Evidence level for bytes owned by the prepared GPU path. */
export type CloudGpuResourceEvidence = 'unavailable' | 'declared' | 'measured';

export interface CloudLayerResourceFacts {
  readonly generation: number;
  /** CPU-side packed formation payload; this is not GPU residency. */
  readonly cacheBytes: number;
  /** Measured GPU bytes, or zero when no prepared-owner receipt was supplied. */
  readonly shadowBytes: number;
  readonly historyBytes: number;
  readonly inFlightBytes: number;
  readonly residentBytes: number;
  readonly resourceCount: number;
  /** Whether the GPU byte fields are measured, only graph-declared, or unknown. */
  readonly gpuEvidence: CloudGpuResourceEvidence;
  /** Descriptor-derived allocation sizes, independent from physical residency. */
  readonly declaredShadowBytes: number;
  readonly declaredHistoryBytes: number;
  readonly declaredResidentBytes: number;
  readonly declaredResourceCount: number;
  /** Measured GPU resource count, kept separate from logical declarations. */
  readonly measuredGpuResourceCount: number;
  readonly cacheResolution: number;
  readonly shadowResolution: number;
}

export type CloudTemporalResetReason =
  | 'authoring-generation'
  | 'camera-cut'
  | 'resize'
  | 'recovery'
  | 'time-discontinuity'
  | 'cloud-shadow-revision'
  | 'device-generation'
  | 'history-missing'
  | 'reprojection-outside'
  | 'scene-depth-disocclusion';

export type CloudLayerInspectionStatus = 'off' | 'available' | 'unavailable' | 'degraded';
export type CloudLayerResourceStage = 'none' | 'candidate' | 'accepted' | 'lkg' | 'recovering';
/** Physical-adapter evidence is explicit; RHI backend labels cannot prove it. */
export type CloudPhysicalGpuEvidence = 'unknown' | 'available' | 'unavailable';

export interface CloudLayerBudgetObservation {
  readonly measured: boolean;
  readonly physicalGpu: CloudPhysicalGpuEvidence;
  readonly gpuTimestamp: boolean;
  readonly quality: 'low' | 'medium' | 'high' | undefined;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly p50GpuMs: number | undefined;
  readonly p95GpuMs: number | undefined;
  readonly coldGenerationMs: number | undefined;
  readonly frameBudgetMs: number | undefined;
  readonly reason?: string;
}

/**
 * Detached effective inputs of cloud work recorded for this view and confirmed
 * by the exact ready Renderer receipt. Missing keys carry no claim.
 */
export interface CloudCompletedAdoption {
  readonly requestRevision: number;
  readonly worldIdentity: string;
  readonly entity: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  /** Submitted FrameReceipt graph identity; the compositor for camera-view output. */
  readonly graphGeneration: number;
  readonly path: 'analytic' | 'sampled' | 'program';
  readonly materialGuid?: string;
  readonly instanceGuid?: string;
  readonly cookIdentity: string;
  readonly programIdentity?: string;
  readonly values: Readonly<Record<string, CloudParameterValue>>;
  /** Custom material uniforms and static switches, separate from engine layer fields. */
  readonly materialValues?: Readonly<Record<string, CloudParameterValue>>;
  readonly unavailableFields: Readonly<Record<string, 'inactive' | 'unsupported'>>;
}

export interface CloudLayerInspection {
  readonly completedAdoption?: CloudCompletedAdoption;
  readonly mode0?: {
    readonly viewId: string;
    readonly deviceGeneration: number;
    readonly materialIdentity: string;
    readonly historyValid: boolean;
    readonly preparedPhase: number;
    readonly acceptedFrame: number | undefined;
    readonly acceptedPhase: number | undefined;
    readonly resetReasons: readonly string[];
    readonly diagnostic?: {
      readonly mode: number;
      readonly status: 'inactive' | 'display' | 'probe' | 'unsupported';
      readonly reason?: string;
    };
  };
  readonly status: CloudLayerInspectionStatus;
  /** Renderer requirement that the selected view or device cannot satisfy. */
  readonly unavailableReason?: string;
  readonly resourceStage: CloudLayerResourceStage;
  readonly sourceKey: string | undefined;
  readonly generation: number | undefined;
  readonly candidateGeneration: number | undefined;
  readonly lkgGeneration: number | undefined;
  readonly shadowRevision: number | undefined;
  readonly temporalResets: number;
  readonly lastTemporalReset: CloudTemporalResetReason | undefined;
  readonly resourceFacts: CloudLayerResourceFacts | undefined;
  readonly capability: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly rgba16floatRenderable: boolean;
    readonly physicalGpu: CloudPhysicalGpuEvidence;
    readonly timestampQuery: boolean;
  };
  readonly budget: CloudLayerBudgetObservation;
}

export interface CloudLayerInspectionInput {
  readonly authored: boolean;
  readonly sourceKey?: string;
  readonly generation?: number;
  readonly candidateGeneration?: number;
  readonly lkgGeneration?: number;
  readonly shadowRevision?: number;
  readonly temporalResets?: number;
  readonly lastTemporalReset?: CloudTemporalResetReason;
  readonly resourceFacts?: CloudLayerResourceFacts;
  readonly capability?: Partial<CloudLayerInspection['capability']>;
  readonly degraded?: boolean;
  readonly unavailableReason?: string;
  readonly budget?: Partial<CloudLayerBudgetObservation>;
}

function resourceStage(input: CloudLayerInspectionInput): CloudLayerResourceStage {
  if (!input.authored || input.generation === undefined) return 'none';
  if (input.candidateGeneration !== undefined) return 'candidate';
  if (input.degraded === true || input.lkgGeneration !== undefined) return 'lkg';
  return 'accepted';
}

/** Capability and lifecycle facts are inspectable even when the lane is unavailable. */
export function inspectCloudLayer(input: CloudLayerInspectionInput): CloudLayerInspection {
  const capability = {
    compute: input.capability?.compute ?? false,
    storageBuffer: input.capability?.storageBuffer ?? false,
    rgba16floatRenderable: input.capability?.rgba16floatRenderable ?? false,
    physicalGpu: input.capability?.physicalGpu ?? 'unknown',
    timestampQuery: input.capability?.timestampQuery ?? false,
  };
  const budget: CloudLayerBudgetObservation = {
    measured: input.budget?.measured ?? false,
    physicalGpu: input.budget?.physicalGpu ?? capability.physicalGpu,
    gpuTimestamp: input.budget?.gpuTimestamp ?? capability.timestampQuery,
    quality: input.budget?.quality,
    warmupFrames: input.budget?.warmupFrames ?? 0,
    sampleFrames: input.budget?.sampleFrames ?? 0,
    p50GpuMs: input.budget?.p50GpuMs,
    p95GpuMs: input.budget?.p95GpuMs,
    coldGenerationMs: input.budget?.coldGenerationMs,
    frameBudgetMs: input.budget?.frameBudgetMs,
    ...(input.budget?.reason === undefined ? {} : { reason: input.budget.reason }),
  };
  // CloudLayer's production plan allocates an HDR shadow/composite target and
  // therefore requires the complete feature capability tuple. Reporting
  // `available` from compute/storage alone lets inspection lie while the graph
  // admission correctly disables the feature on LDR-only adapters.
  const available =
    input.unavailableReason === undefined &&
    capability.compute &&
    capability.storageBuffer &&
    capability.rgba16floatRenderable;
  return Object.freeze({
    status: !input.authored
      ? 'off'
      : !available
        ? 'unavailable'
        : input.degraded === true
          ? 'degraded'
          : 'available',
    ...(input.unavailableReason === undefined
      ? {}
      : { unavailableReason: input.unavailableReason }),
    resourceStage: resourceStage(input),
    sourceKey: input.sourceKey,
    generation: input.generation,
    candidateGeneration: input.candidateGeneration,
    lkgGeneration: input.lkgGeneration,
    shadowRevision: input.shadowRevision,
    temporalResets: input.temporalResets ?? 0,
    lastTemporalReset: input.lastTemporalReset,
    resourceFacts: input.resourceFacts,
    capability,
    budget,
  });
}

/** Convert RHI facts without letting inspection invent physical measurements. */
export function cloudCapabilitiesFromRhi(
  caps: Readonly<RhiCaps>,
): CloudLayerInspection['capability'] {
  return Object.freeze({
    compute: caps.compute === true,
    storageBuffer: caps.storageBuffer === true,
    rgba16floatRenderable: caps.rgba16floatRenderable === true,
    // RHI caps intentionally do not claim a physical adapter. A browser or
    // Dawn receipt must promote this fact to available/unavailable.
    physicalGpu: 'unknown',
    timestampQuery: caps.timestampQuery === true,
  });
}
