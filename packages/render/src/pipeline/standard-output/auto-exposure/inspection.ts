import type { CameraExposure } from '../../../components/camera';

export type AutoExposureErrorCode =
  | 'auto-exposure-invalid-parameter'
  | 'auto-exposure-capability-unavailable'
  | 'auto-exposure-stale-generation'
  | 'auto-exposure-stage-failed';

export interface AutoExposureInvalidParameterDetail {
  readonly field: string;
  readonly value: number;
  readonly expected: string;
}

export interface AutoExposureCapabilityUnavailableDetail {
  readonly capability: 'compute' | 'storage-buffer';
  readonly generation: number;
}

export interface AutoExposureStaleGenerationDetail {
  readonly expectedGeneration: number;
  readonly actualGeneration: number;
}

export interface AutoExposureStageFailedDetail {
  readonly stage: 'prepare' | 'record';
  readonly operation: string;
  readonly cause: unknown;
}

export type AutoExposureErrorDetailByCode = {
  'auto-exposure-invalid-parameter': AutoExposureInvalidParameterDetail;
  'auto-exposure-capability-unavailable': AutoExposureCapabilityUnavailableDetail;
  'auto-exposure-stale-generation': AutoExposureStaleGenerationDetail;
  'auto-exposure-stage-failed': AutoExposureStageFailedDetail;
};

export type AutoExposureErrorDetail = AutoExposureErrorDetailByCode[AutoExposureErrorCode];

export class AutoExposureInvalidParameterError extends Error {
  readonly code = 'auto-exposure-invalid-parameter' as const;
  readonly expected = ERROR_POLICY[this.code].expected;
  readonly hint = ERROR_POLICY[this.code].hint;
  constructor(readonly detail: AutoExposureInvalidParameterDetail) {
    super(`auto-exposure-invalid-parameter: ${detail.field}`);
    this.name = 'AutoExposureInvalidParameterError';
  }
}

export class AutoExposureCapabilityUnavailableError extends Error {
  readonly code = 'auto-exposure-capability-unavailable' as const;
  readonly expected = ERROR_POLICY[this.code].expected;
  readonly hint = ERROR_POLICY[this.code].hint;
  constructor(readonly detail: AutoExposureCapabilityUnavailableDetail) {
    super(`auto-exposure-capability-unavailable: ${detail.capability}`);
    this.name = 'AutoExposureCapabilityUnavailableError';
  }
}

export class AutoExposureStaleGenerationError extends Error {
  readonly code = 'auto-exposure-stale-generation' as const;
  readonly expected = ERROR_POLICY[this.code].expected;
  readonly hint = ERROR_POLICY[this.code].hint;
  constructor(readonly detail: AutoExposureStaleGenerationDetail) {
    super(
      `auto-exposure-stale-generation: ${detail.actualGeneration} != ${detail.expectedGeneration}`,
    );
    this.name = 'AutoExposureStaleGenerationError';
  }
}

export class AutoExposureStageFailedError extends Error {
  readonly code = 'auto-exposure-stage-failed' as const;
  readonly expected = ERROR_POLICY[this.code].expected;
  readonly hint = ERROR_POLICY[this.code].hint;
  constructor(readonly detail: AutoExposureStageFailedDetail) {
    super(`auto-exposure-stage-failed: ${detail.operation}`);
    this.name = 'AutoExposureStageFailedError';
  }
}

export type AutoExposureError =
  | AutoExposureInvalidParameterError
  | AutoExposureCapabilityUnavailableError
  | AutoExposureStaleGenerationError
  | AutoExposureStageFailedError;

type AutoExposureErrorInput = {
  [C in AutoExposureErrorCode]: {
    readonly code: C;
    readonly detail: AutoExposureErrorDetailByCode[C];
  };
}[AutoExposureErrorCode];

export type AutoExposureErrorRecord = {
  [C in AutoExposureErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: AutoExposureErrorDetailByCode[C];
  };
}[AutoExposureErrorCode];

export type AutoExposureResetReason =
  | 'camera-change'
  | 'manual-mode'
  | 'device-lost'
  | 'stale-generation';

export interface AutoExposureCost {
  readonly histogramBytes: number;
  /** Logical stages retained for the inspect contract: clear, histogram, adapt. */
  readonly passCount: number;
  /** The logical stages share one real timestamped compute pass. */
  readonly physicalPassCount: number;
}

export interface AutoExposureReceipt {
  readonly frameId: number;
  readonly committed: boolean;
}

/**
 * Describes where the detached `actual` value came from.  A successful live
 * GPU submission is intentionally not a CPU observation: its numeric result
 * remains resident in the GPU state buffer until an explicit readback owner
 * is requested.  Keeping that state distinct prevents fallback from being
 * presented as the measured exposure.
 */
export type AutoExposureActualState = 'accepted' | 'fallback' | 'gpu-resident';

export interface AutoExposureInspection {
  readonly requested: CameraExposure;
  readonly actual: number | null;
  readonly actualState: AutoExposureActualState;
  readonly fallback: number;
  readonly lastKnownGood: number;
  readonly targetGeneration: number;
  readonly recentFailure?: AutoExposureError;
  readonly reset: readonly AutoExposureResetReason[];
  readonly cost: AutoExposureCost;
  readonly receipt: AutoExposureReceipt;
}

export interface AutoExposureInspectionInput
  extends Omit<AutoExposureInspection, 'actualState' | 'recentFailure'> {
  readonly actualState?: AutoExposureActualState;
  readonly recentFailure?: AutoExposureError | AutoExposureErrorRecord;
}

const ERROR_POLICY: Readonly<
  Record<AutoExposureErrorCode, { readonly expected: string; readonly hint: string }>
> = {
  'auto-exposure-invalid-parameter': {
    expected: 'camera auto-exposure parameters are finite and within their declared ranges',
    hint: 'inspect the field and provide a finite value before rebuilding the camera output',
  },
  'auto-exposure-capability-unavailable': {
    expected: 'the auto-exposure stage has the required device capability',
    hint: 'inspect live capabilities and retry the same camera generation',
  },
  'auto-exposure-stale-generation': {
    expected: 'the prepared auto-exposure state matches the camera target generation',
    hint: 'discard stale prepared state and rebuild from the latest camera snapshot',
  },
  'auto-exposure-stage-failed': {
    expected: 'the auto-exposure stage completes its declared operation',
    hint: 'inspect the structured cause, preserve lastKnownGood, and retry the stage',
  },
};

export function createAutoExposureError(
  input: AutoExposureErrorInput | AutoExposureErrorRecord,
): AutoExposureError {
  if (
    input instanceof AutoExposureInvalidParameterError ||
    input instanceof AutoExposureCapabilityUnavailableError ||
    input instanceof AutoExposureStaleGenerationError ||
    input instanceof AutoExposureStageFailedError
  ) {
    return input;
  }
  switch (input.code) {
    case 'auto-exposure-invalid-parameter':
      return new AutoExposureInvalidParameterError(input.detail);
    case 'auto-exposure-capability-unavailable':
      return new AutoExposureCapabilityUnavailableError(input.detail);
    case 'auto-exposure-stale-generation':
      return new AutoExposureStaleGenerationError(input.detail);
    case 'auto-exposure-stage-failed':
      return new AutoExposureStageFailedError(input.detail);
  }
}

function cloneExposure(exposure: CameraExposure): CameraExposure {
  if (exposure.kind === 'manual') return { ...exposure };
  return {
    ...exposure,
    rangeEv: [exposure.rangeEv[0], exposure.rangeEv[1]],
    rates: [exposure.rates[0], exposure.rates[1]],
  };
}

function cloneFailure(error: AutoExposureError | undefined): AutoExposureError | undefined {
  if (error === undefined) return undefined;
  return Object.freeze({
    ...error,
    detail: Object.freeze({ ...error.detail }),
  }) as AutoExposureError;
}

/** Project detached bounded facts; GPU handles and histogram buckets never cross this boundary. */
export function createAutoExposureInspection(
  input: AutoExposureInspectionInput,
): Readonly<AutoExposureInspection> {
  const base = {
    requested: cloneExposure(input.requested),
    actual: input.actual,
    actualState: input.actualState ?? (input.actual === null ? 'gpu-resident' : 'accepted'),
    fallback: input.fallback,
    lastKnownGood: input.lastKnownGood,
    targetGeneration: input.targetGeneration,
    reset: Object.freeze([...input.reset]),
    cost: Object.freeze({ ...input.cost }),
    receipt: Object.freeze({ ...input.receipt }),
  };
  if (input.recentFailure === undefined) return Object.freeze(base);
  const recentFailure = cloneFailure(createAutoExposureError(input.recentFailure));
  if (recentFailure === undefined) return Object.freeze(base);
  return Object.freeze({ ...base, recentFailure });
}
