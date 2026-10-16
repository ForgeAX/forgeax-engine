// @forgeax/engine-render - bounded SSR spatial inspection projection.

import type { ScreenSpaceReflectionData } from '../components/screen-space-reflection';
import type { ReflectionFallbackSource } from '../inspection-types';
import type { SsrAdmissionWork, SsrSpatialAdmission, SsrSpatialLane } from './admission';
import type { SsrConfigInvalidError, SsrUnavailableError } from './errors';
import type { SsrHistoryState } from './history';

export type SsrSpatialInspectionFailure = SsrConfigInvalidError | SsrUnavailableError;

export interface SsrSpatialHistoryInspection {
  readonly state: 'not-owned' | SsrHistoryState;
  readonly bytes: number;
  readonly resetCount: number;
}

export interface SsrSpatialInspectionProjection {
  readonly status?: SsrSpatialInspection['status'];
  readonly coverage?: Partial<SsrSpatialInspection['coverage']>;
  readonly history?: SsrSpatialHistoryInspection;
  readonly passRoster?: readonly string[];
  readonly fallbackSource?: ReflectionFallbackSource;
  readonly failure?: SsrSpatialInspectionFailure;
}

/** Keep the public projection bounded even if a graph owner supplies a bad list. */
export const SSR_INSPECTION_MAX_PASSES = 64 as const;

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function copyHistory(history: SsrSpatialHistoryInspection): SsrSpatialHistoryInspection {
  nonNegativeSafeInteger('SSR inspection history.bytes', history.bytes);
  nonNegativeSafeInteger('SSR inspection history.resetCount', history.resetCount);
  return Object.freeze({
    state: history.state,
    bytes: history.bytes,
    resetCount: history.resetCount,
  });
}

function copyCoverage(
  coverage: Partial<SsrSpatialInspection['coverage']> | undefined,
): SsrSpatialInspection['coverage'] {
  const result = {
    hitCount: coverage?.hitCount ?? null,
    fallbackCount: coverage?.fallbackCount ?? null,
    excludedCount: coverage?.excludedCount ?? null,
  };
  for (const [key, value] of Object.entries(result)) {
    if (value !== null) nonNegativeSafeInteger(`SSR inspection coverage.${key}`, value);
  }
  return Object.freeze(result);
}

function copyPassRoster(passRoster: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...(passRoster ?? [])].slice(0, SSR_INSPECTION_MAX_PASSES).map((name, index) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`SSR inspection passRoster[${index}] must be a non-empty string`);
      }
      return name;
    }),
  );
}

export interface SsrSpatialInspection {
  readonly status: 'not-requested' | 'requested' | 'admitted' | 'fallback-only' | 'structural-only';
  readonly lane: SsrSpatialLane;
  readonly config: ScreenSpaceReflectionData | undefined;
  readonly viewRange: number;
  readonly coverage: {
    /** Null means no GPU coverage measurement is available for this frame. */
    readonly hitCount: number | null;
    readonly fallbackCount: number | null;
    readonly excludedCount: number | null;
  };
  readonly history: SsrSpatialHistoryInspection;
  readonly work: SsrAdmissionWork;
  readonly passRoster: readonly string[];
  readonly fallbackSource: ReflectionFallbackSource | undefined;
  readonly failure: SsrSpatialInspectionFailure | undefined;
}

/** Project only detached, bounded facts from the spatial admission result. */
export function projectSsrSpatialInspection(
  admission: SsrSpatialAdmission,
  projection: SsrSpatialInspectionProjection = {},
): SsrSpatialInspection {
  const config = admission.config;
  return Object.freeze({
    status: projection.status ?? admission.status,
    lane: admission.lane,
    config:
      config === undefined
        ? undefined
        : Object.freeze({
            maxDistance: config.maxDistance,
            thickness: config.thickness,
            maxRoughness: config.maxRoughness,
          }),
    viewRange: admission.viewRange,
    coverage: copyCoverage(projection.coverage),
    history: copyHistory(
      projection.history ?? {
        state: 'not-owned' as const,
        bytes: 0,
        resetCount: 0,
      },
    ),
    work: Object.freeze({ ...admission.work }),
    passRoster: copyPassRoster(projection.passRoster),
    fallbackSource: projection.fallbackSource,
    failure: projection.failure ?? admission.failure,
  });
}

export function serializeSsrSpatialInspection(inspection: SsrSpatialInspection): string {
  return JSON.stringify(inspection);
}
