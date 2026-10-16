import type { CloudDensityCache } from './density';
import type { CloudShadowProjection } from './shadow';
import { type CloudHistory, cloudHistoryExtent } from './temporal';

/** Evidence level for bytes owned by the prepared GPU path. */
export type CloudGpuResourceEvidence = 'unavailable' | 'declared' | 'measured';

/** rgba16float is four 16-bit channels (8 bytes per texel). */
export const CLOUD_RGBA16FLOAT_BYTES_PER_TEXEL = 8;
/** Two ping-pong surfaces for each of radiance/transmittance/depth. */
export const CLOUD_HISTORY_SURFACE_COUNT = 6;

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

export interface CloudLayerResourceInputs {
  readonly generation: number;
  readonly cache?: CloudDensityCache;
  readonly shadow?: CloudShadowProjection;
  readonly history?: CloudHistory;
  /** Bytes reported by the prepared GPU owner; absent means unavailable. */
  readonly shadowBytes?: number;
  readonly historyBytes?: number;
  readonly inFlightBytes?: number;
}

/** Derive one inspection receipt from the resources owned by the current generation. */
export function inspectCloudLayerResources(
  input: CloudLayerResourceInputs,
): CloudLayerResourceFacts {
  const cacheBytes = input.cache?.byteLength ?? 0;
  const shadowResolution = input.shadow?.resolution ?? 0;
  const declaredShadowBytes =
    shadowResolution * shadowResolution * CLOUD_RGBA16FLOAT_BYTES_PER_TEXEL;
  const historyExtent =
    input.history === undefined
      ? { width: 0, height: 0 }
      : cloudHistoryExtent(input.history.width, input.history.height);
  const declaredHistoryBytes =
    historyExtent.width *
    historyExtent.height *
    CLOUD_HISTORY_SURFACE_COUNT *
    CLOUD_RGBA16FLOAT_BYTES_PER_TEXEL;
  const shadowBytes = input.shadowBytes ?? 0;
  const historyBytes = input.historyBytes ?? 0;
  const inFlightBytes = Math.max(0, input.inFlightBytes ?? 0);
  const residentBytes = cacheBytes + shadowBytes + historyBytes;
  const measuredGpuResourceCount =
    Number(input.shadowBytes !== undefined) + Number(input.historyBytes !== undefined);
  const gpuEvidence: CloudGpuResourceEvidence =
    measuredGpuResourceCount > 0 || input.inFlightBytes !== undefined
      ? 'measured'
      : input.shadow !== undefined || input.history !== undefined
        ? 'declared'
        : 'unavailable';
  const resourceCount =
    Number(input.cache !== undefined) +
    Number(input.shadow !== undefined) +
    Number(input.history !== undefined);
  return Object.freeze({
    generation: input.generation,
    cacheBytes,
    shadowBytes,
    historyBytes,
    inFlightBytes,
    residentBytes,
    resourceCount,
    gpuEvidence,
    declaredShadowBytes,
    declaredHistoryBytes,
    declaredResidentBytes: cacheBytes + declaredShadowBytes + declaredHistoryBytes,
    declaredResourceCount: resourceCount,
    measuredGpuResourceCount,
    cacheResolution: input.cache?.resolution ?? 0,
    shadowResolution,
  });
}

export interface CloudLayerGeneration {
  readonly generation: number;
  readonly sourceKey: string;
  readonly resourceFacts: CloudLayerResourceFacts;
  readonly status: 'candidate' | 'active' | 'lkg' | 'retiring';
}

/** Candidate -> active transition used by the renderer's existing graph owner. */
export function acceptCloudLayerGeneration(
  candidate: CloudLayerGeneration,
  previous: CloudLayerGeneration | undefined,
): { readonly active: CloudLayerGeneration; readonly lkg: CloudLayerGeneration | undefined } {
  return Object.freeze({
    active: Object.freeze({ ...candidate, status: 'active' as const }),
    lkg:
      previous === undefined ? undefined : Object.freeze({ ...previous, status: 'lkg' as const }),
  });
}

/** A failed candidate never replaces the LKG; retirement is fence-owned by Render. */
export function retainCloudLayerAfterFailure(
  active: CloudLayerGeneration | undefined,
  candidate: CloudLayerGeneration,
): { readonly active: CloudLayerGeneration | undefined; readonly retiring: CloudLayerGeneration } {
  return Object.freeze({
    active,
    retiring: Object.freeze({ ...candidate, status: 'retiring' as const }),
  });
}
