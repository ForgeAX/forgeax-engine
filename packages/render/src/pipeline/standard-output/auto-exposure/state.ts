import { err, ok, type Result } from '@forgeax/engine-types';
import {
  AutoExposureInvalidParameterError,
  type AutoExposureReceipt,
  type AutoExposureResetReason,
  AutoExposureStaleGenerationError,
} from './inspection';

/** CPU-side ownership record for the two GPU state slots and accepted candidate. */
export interface AutoExposureState {
  readonly acceptedEv: number;
  readonly fallback: number;
  readonly lastKnownGood: number;
  readonly targetGeneration: number;
  readonly deviceEpoch: number;
  readonly reset: readonly AutoExposureResetReason[];
  readonly receipt: AutoExposureReceipt;
}

export interface AutoExposureCandidate {
  readonly ev: number;
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly frameId: number;
}

export interface AutoExposureSubmissionMetadata {
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly frameId: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function createAutoExposureState(input: {
  readonly fallback: number;
  readonly targetGeneration?: number;
  readonly deviceEpoch?: number;
  readonly frameId?: number;
}): Result<AutoExposureState, AutoExposureInvalidParameterError> {
  if (!finite(input.fallback) || input.fallback <= 0) {
    return err(
      new AutoExposureInvalidParameterError({
        field: 'fallback',
        value: input.fallback,
        expected: 'a finite positive multiplier',
      }),
    );
  }
  const targetGeneration = input.targetGeneration ?? 0;
  const deviceEpoch = input.deviceEpoch ?? 0;
  const frameId = input.frameId ?? 0;
  if (!Number.isInteger(targetGeneration) || targetGeneration < 0) {
    return err(
      new AutoExposureInvalidParameterError({
        field: 'targetGeneration',
        value: targetGeneration,
        expected: 'a non-negative integer',
      }),
    );
  }
  return ok(
    Object.freeze({
      acceptedEv: 0,
      fallback: input.fallback,
      lastKnownGood: input.fallback,
      targetGeneration,
      deviceEpoch,
      reset: Object.freeze([]),
      receipt: Object.freeze({ frameId, committed: false }),
    }),
  );
}

export function prepareAutoExposureCandidate(
  state: AutoExposureState,
  candidate: AutoExposureCandidate,
): Result<
  AutoExposureCandidate,
  AutoExposureStaleGenerationError | AutoExposureInvalidParameterError
> {
  if (!finite(candidate.ev) || candidate.ev <= 0) {
    return err(
      new AutoExposureInvalidParameterError({
        field: 'candidate.ev',
        value: candidate.ev,
        expected: 'a finite positive multiplier',
      }),
    );
  }
  if (
    candidate.generation !== state.targetGeneration ||
    candidate.deviceEpoch !== state.deviceEpoch
  ) {
    return err(
      new AutoExposureStaleGenerationError({
        expectedGeneration: state.targetGeneration,
        actualGeneration: candidate.generation,
      }),
    );
  }
  return ok(Object.freeze({ ...candidate }));
}

/** Publish a candidate only after the owning frame transaction has submitted. */
export function commitAutoExposureCandidate(
  state: AutoExposureState,
  candidate: AutoExposureCandidate,
): AutoExposureState {
  return Object.freeze({
    ...state,
    acceptedEv: candidate.ev,
    lastKnownGood: candidate.ev,
    receipt: Object.freeze({ frameId: candidate.frameId, committed: true }),
  });
}

/**
 * Publish only the successful-submit receipt for the live GPU path.
 *
 * The numeric candidate is produced and retained by the GPU state buffer. No
 * CPU readback is permitted on the frame path, so this transaction helper must
 * not manufacture an accepted exposure from fallback/LKG data.
 */
export function commitAutoExposureSubmission(
  state: AutoExposureState,
  metadata: AutoExposureSubmissionMetadata,
): AutoExposureState {
  if (
    metadata.generation !== state.targetGeneration ||
    metadata.deviceEpoch !== state.deviceEpoch
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    receipt: Object.freeze({ frameId: metadata.frameId, committed: true }),
  });
}

/** Reset GPU state ownership while retaining the accepted EV as the fallback. */
export function resetAutoExposureState(
  state: AutoExposureState,
  reason: AutoExposureResetReason,
  input: { readonly targetGeneration: number; readonly deviceEpoch: number },
): AutoExposureState {
  return Object.freeze({
    ...state,
    targetGeneration: input.targetGeneration,
    deviceEpoch: input.deviceEpoch,
    reset: Object.freeze([...state.reset, reason]),
    receipt: Object.freeze({ ...state.receipt, committed: false }),
  });
}
