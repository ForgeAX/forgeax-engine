import type { RhiCaps } from '@forgeax/engine-rhi';
import type { CloudLayerResourceFacts } from './resources';
import type { CloudTemporalResetReason } from './temporal';

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

export interface CloudLayerInspection {
  readonly status: CloudLayerInspectionStatus;
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
    capability.compute && capability.storageBuffer && capability.rgba16floatRenderable;
  return Object.freeze({
    status: !input.authored
      ? 'off'
      : !available
        ? 'unavailable'
        : input.degraded === true
          ? 'degraded'
          : 'available',
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
