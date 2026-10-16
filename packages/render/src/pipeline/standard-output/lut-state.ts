import { err, ok, type Result } from '@forgeax/engine-types';

export type StandardLutResetReason = 'device-recovered' | 'resource-removed' | 'validation-failed';

export type StandardLutStateErrorCode =
  | 'standard-lut-stale-generation'
  | 'standard-lut-invalid-resident';

export interface StandardLutStateError {
  readonly code: StandardLutStateErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, number | string>>;
}

/** Bounded preparation failure retained for recovery and detached inspection. */
export interface StandardLutFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

export interface StandardLutState {
  readonly resident: string | null;
  readonly lastKnownGood: string | null;
  readonly sourceKey: string | null;
  readonly targetGeneration: number;
  readonly deviceEpoch: number;
  readonly recentFailure?: StandardLutFailure;
  readonly reset: readonly StandardLutResetReason[];
  readonly receipt: Readonly<{ frameId: number; committed: boolean }>;
}

export interface StandardLutCandidate {
  readonly resident: string;
  readonly sourceKey?: string;
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly frameId: number;
}

export function createStandardLutState(
  input: {
    readonly resident?: string | null;
    readonly targetGeneration?: number;
    readonly deviceEpoch?: number;
    readonly frameId?: number;
  } = {},
): StandardLutState {
  const resident = input.resident ?? null;
  const targetGeneration = input.targetGeneration ?? 0;
  const deviceEpoch = input.deviceEpoch ?? 0;
  return Object.freeze({
    resident,
    lastKnownGood: resident,
    sourceKey: resident,
    targetGeneration,
    deviceEpoch,
    reset: Object.freeze([]),
    receipt: Object.freeze({ frameId: input.frameId ?? 0, committed: false }),
  });
}

export function prepareStandardLutCandidate(
  state: StandardLutState,
  candidate: StandardLutCandidate,
): Result<StandardLutCandidate, StandardLutStateError> {
  if (candidate.resident.length === 0) {
    return err({
      code: 'standard-lut-invalid-resident',
      expected: 'a non-empty resident LUT identity',
      hint: 'retain the existing compatible LUT and rebuild the candidate',
      detail: { resident: candidate.resident },
    });
  }
  if (
    candidate.generation !== state.targetGeneration ||
    candidate.deviceEpoch !== state.deviceEpoch
  ) {
    return err({
      code: 'standard-lut-stale-generation',
      expected: `generation ${state.targetGeneration} at device epoch ${state.deviceEpoch}`,
      hint: 'discard the late candidate and rebuild from the active device scope',
      detail: {
        expectedGeneration: state.targetGeneration,
        actualGeneration: candidate.generation,
        expectedDeviceEpoch: state.deviceEpoch,
        actualDeviceEpoch: candidate.deviceEpoch,
      },
    });
  }
  return ok(Object.freeze({ ...candidate }));
}

/** Publish LUT residency only after the owning frame has submitted. */
export function commitStandardLutCandidate(
  state: StandardLutState,
  candidate: StandardLutCandidate,
): StandardLutState {
  const { recentFailure: _recentFailure, ...withoutFailure } = state;
  return Object.freeze({
    ...withoutFailure,
    resident: candidate.resident,
    lastKnownGood: candidate.resident,
    sourceKey: candidate.sourceKey ?? candidate.resident,
    receipt: Object.freeze({ frameId: candidate.frameId, committed: true }),
  });
}

/** Keep the accepted/LKG resource while recording a failed replacement. */
export function recordStandardLutFailure(
  state: StandardLutState,
  failure: StandardLutFailure,
): StandardLutState {
  return Object.freeze({
    ...state,
    recentFailure: Object.freeze({
      ...failure,
      detail: Object.freeze({ ...failure.detail }),
    }),
  });
}

/** Detached, bounded LUT facts for renderer inspection: a frozen copy of the state. */
export type StandardLutInspection = StandardLutState;

export function inspectStandardLutState(state: StandardLutState): Readonly<StandardLutInspection> {
  return Object.freeze({
    resident: state.resident,
    lastKnownGood: state.lastKnownGood,
    sourceKey: state.sourceKey,
    targetGeneration: state.targetGeneration,
    deviceEpoch: state.deviceEpoch,
    ...(state.recentFailure === undefined
      ? {}
      : {
          recentFailure: Object.freeze({
            ...state.recentFailure,
            detail: Object.freeze({ ...state.recentFailure.detail }),
          }),
        }),
    reset: Object.freeze([...state.reset]),
    receipt: Object.freeze({ ...state.receipt }),
  });
}

/** Retire device-bound residency while retaining the compatible LKG identity. */
export function resetStandardLutState(
  state: StandardLutState,
  reason: StandardLutResetReason,
  input: { readonly targetGeneration: number; readonly deviceEpoch: number },
): StandardLutState {
  const recentFailure = state.recentFailure;
  return Object.freeze({
    ...state,
    resident: null,
    sourceKey: null,
    targetGeneration: input.targetGeneration,
    deviceEpoch: input.deviceEpoch,
    // A failed replacement remains actionable after device recovery until a
    // same-GUID/sourceKey candidate is admitted and submitted successfully.
    ...(recentFailure === undefined ? {} : { recentFailure }),
    reset: Object.freeze([...state.reset, reason]),
    receipt: Object.freeze({ ...state.receipt, committed: false }),
  });
}
