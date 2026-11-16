import type {
  WaterBuoyancyCandidateTrace,
  WaterBuoyancyFailure,
  WaterBuoyancyStep,
  WaterPontoonTrace,
  WaterQueryField,
  WaterQueryResult,
} from '@forgeax/engine/water';

type WaterQueryResultForTrace = Omit<WaterQueryResult, 'valid'> & {
  readonly valid: readonly WaterQueryField[];
};
type WaterQueryResultForTraceOutcome =
  | Readonly<{ ok: true; value: WaterQueryResultForTrace }>
  | Readonly<{ ok: false; error: WaterBuoyancyFailure }>;
type WaterBuoyancyCandidateTraceForTrace = Omit<WaterBuoyancyCandidateTrace, 'result'> & {
  readonly result: WaterQueryResultForTraceOutcome;
};
type WaterPontoonTraceForTrace = Omit<WaterPontoonTrace, 'candidateRoster'> & {
  readonly candidateRoster: readonly WaterBuoyancyCandidateTraceForTrace[];
};
export type WaterBuoyancyStepForTrace = Omit<WaterBuoyancyStep, 'pontoons'> & {
  readonly pontoons: readonly WaterPontoonTraceForTrace[];
};

/** Copy the immutable field contract to an owned array for the saved trace. */
export function snapshotWaterQueryResultForTrace(
  result: WaterQueryResult,
): WaterQueryResultForTrace {
  return { ...result, valid: [...result.valid] };
}

/** Preserve the full step and candidate evidence while detaching query field sets. */
export function snapshotWaterBuoyancyStepForTrace(
  step: WaterBuoyancyStep,
): WaterBuoyancyStepForTrace {
  return {
    ...step,
    pontoons: step.pontoons.map((pontoon) => ({
      ...pontoon,
      candidateRoster: pontoon.candidateRoster.map((candidate) => ({
        ...candidate,
        result: candidate.result.ok
          ? { ok: true, value: snapshotWaterQueryResultForTrace(candidate.result.value) }
          : candidate.result,
      })),
    })),
  };
}
