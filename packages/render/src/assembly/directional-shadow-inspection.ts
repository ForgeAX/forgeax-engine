import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import type {
  DirectionalShadowInspection,
  DirectionalShadowInspectionError,
  DirectionalShadowProfile,
} from '../inspection-types';
import type { DirectionalShadowBackendAdmission } from '../render-pipeline';

export interface DirectionalShadowInspectionSource {
  readonly requested: DirectionalShadowProfile;
  readonly candidate: 'accepted' | 'failed';
  readonly lastKnownGood?: DirectionalShadowProfile | undefined;
  readonly cascadeCount: number;
  readonly mapSize: number;
  readonly shadowMapBytes: number;
  readonly writerPasses: number;
  readonly shadowAngularRadius?: number | undefined;
  readonly maxPenumbraTexels?: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly shadowReady: boolean;
  readonly error?: DirectionalShadowInspectionError | undefined;
}

export interface DirectionalShadowInspectionInput {
  readonly admission: DirectionalShadowBackendAdmission;
  readonly cascadeCount: number;
  readonly mapSize: number;
  readonly shadowMapBytes: number;
  readonly writerPasses: number;
  readonly blockerTaps: number;
  readonly filterTapUpperBound: number;
  readonly seamTapUpperBound: number;
  readonly shadowAngularRadius?: number | undefined;
  readonly maxPenumbraTexels?: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly error?: DirectionalShadowInspectionError | undefined;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Project the single bounded Directional inspection POD; no live handles leak. */
export function projectDirectionalShadowInspection(
  input: DirectionalShadowInspectionInput,
): DirectionalShadowInspection {
  const projection: DirectionalShadowInspection = {
    requested: input.admission.requested,
    effective: input.admission.effective,
    status: input.admission.status,
    ...(input.admission.fallbackReason === undefined
      ? {}
      : { fallbackReason: input.admission.fallbackReason }),
    lastKnownGood: input.admission.lastKnownGood,
    pixelEvidence: input.admission.pixelEvidence,
    cascadeCount: input.cascadeCount,
    mapSize: input.mapSize,
    shadowMapBytes: input.shadowMapBytes,
    writerPasses: input.writerPasses,
    blockerTaps: input.blockerTaps,
    filterTapUpperBound: input.filterTapUpperBound,
    seamTapUpperBound: input.seamTapUpperBound,
    deviceGeneration: input.deviceGeneration,
    graphGeneration: input.graphGeneration,
    shadowAngularRadius: input.shadowAngularRadius,
    maxPenumbraTexels: input.maxPenumbraTexels,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  return deepFreeze(projection);
}

export function directionalShadowProfileFromQuality(
  quality: DirectionalShadowQuality | undefined,
): DirectionalShadowProfile {
  if (quality === undefined) return 'off';
  if (quality.kind === 'pcf-vogel') return 'pcfVogel';
  if (quality.kind === 'pcf') return `pcf${quality.kernel}` as 'pcf1' | 'pcf3' | 'pcf5';
  return quality.preset === 'medium' ? 'pcssMedium' : 'pcssHigh';
}

export function projectDirectionalShadowInspectionSource(
  input: DirectionalShadowInspectionSource,
): DirectionalShadowInspection {
  const filter =
    input.requested === 'pcssMedium'
      ? { blockerTaps: 8, filterTapUpperBound: 16, seamTapUpperBound: 48 }
      : input.requested === 'pcssHigh'
        ? { blockerTaps: 16, filterTapUpperBound: 32, seamTapUpperBound: 96 }
        : input.requested === 'pcfVogel'
          ? { blockerTaps: 0, filterTapUpperBound: 5, seamTapUpperBound: 5 }
          : input.requested === 'pcf5'
            ? { blockerTaps: 0, filterTapUpperBound: 25, seamTapUpperBound: 25 }
            : input.requested === 'pcf3'
              ? { blockerTaps: 0, filterTapUpperBound: 9, seamTapUpperBound: 9 }
              : { blockerTaps: 0, filterTapUpperBound: 1, seamTapUpperBound: 1 };
  const admission: DirectionalShadowBackendAdmission = {
    requested: input.requested,
    effective:
      input.candidate === 'accepted' ? input.requested : (input.lastKnownGood ?? input.requested),
    status: input.candidate === 'accepted' ? 'accepted' : 'rejected',
    ...(input.candidate === 'failed' ? { fallbackReason: 'candidate-failed' as const } : {}),
    lastKnownGood: input.candidate === 'failed' && input.lastKnownGood !== undefined,
    pixelEvidence: input.shadowReady ? 'available' : 'not-available',
  };
  return projectDirectionalShadowInspection({
    admission,
    cascadeCount: input.cascadeCount,
    mapSize: input.mapSize,
    shadowMapBytes: input.shadowMapBytes,
    writerPasses: input.writerPasses,
    ...filter,
    shadowAngularRadius: input.shadowAngularRadius,
    maxPenumbraTexels: input.maxPenumbraTexels,
    deviceGeneration: input.deviceGeneration,
    graphGeneration: input.graphGeneration,
    ...(input.error === undefined ? {} : { error: input.error }),
  });
}
