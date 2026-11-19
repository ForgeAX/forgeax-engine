import type { DeviceResourceKind } from '../../device/resource-types';
import {
  createRecoveryFailedError,
  type RecoverFailure,
  type RecoveryFailureDetail,
} from '../../errors/recover';
import type { RecoveryGuidance, RecoveryPhase } from '../renderer-lifecycle';

export interface RecoveryFailureLocation {
  readonly phase: RecoveryPhase;
  readonly retryable: boolean;
  readonly guidance: RecoveryGuidance;
  readonly owner: string;
  readonly resourceKind: DeviceResourceKind;
  readonly cause: unknown;
}

function recoveryCauseCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const directCode = (cause as { readonly code?: unknown }).code;
  if (typeof directCode === 'string') return directCode;
  const detail = (cause as { readonly detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const detailCode = (detail as { readonly code?: unknown }).code;
  if (typeof detailCode === 'string') return detailCode;
  return recoveryCauseCode((detail as { readonly cause?: unknown }).cause);
}

export function createRecoveryFailureLocation(
  phase: RecoveryPhase,
  cause: unknown,
  overrides: Partial<Omit<RecoveryFailureLocation, 'phase' | 'cause'>> = {},
): RecoveryFailureLocation {
  const code = recoveryCauseCode(cause) ?? '';
  const resourceKind: DeviceResourceKind = code.includes('shader')
    ? 'shader'
    : code.includes('buffer')
      ? 'buffer'
      : code.includes('texture')
        ? 'texture'
        : code.includes('binding')
          ? 'binding'
          : phase === 'rehydrate'
            ? 'shader'
            : phase === 'acquire-adapter' || phase === 'acquire-device'
              ? 'surface'
              : phase === 'publish' || phase === 'cleanup'
                ? 'surface'
                : 'pipeline';
  const owner =
    code.includes('shader') || phase === 'rehydrate'
      ? 'shader'
      : phase === 'acquire-adapter' || phase === 'acquire-device'
        ? 'backend'
        : phase === 'compile-graph'
          ? 'pipeline'
          : 'renderer';
  return {
    phase,
    retryable: false,
    guidance: 'repair-owner',
    owner,
    resourceKind,
    cause,
    ...overrides,
  };
}

export function recoveryAttemptFailure(options: {
  outcome: 'disposed' | 'failed';
  failureLocation: RecoveryFailureLocation | undefined;
  failurePhase: RecoveryPhase;
  fromGeneration: number;
  candidateGeneration: number;
  attempt: number;
  elapsedMs: number;
  rehydratedRoots: number;
  staleLossEvents: number;
  error: RecoverFailure;
  receipt: RecoveryFailureDetail['receipt'];
}) {
  const {
    outcome,
    failureLocation,
    failurePhase,
    fromGeneration,
    candidateGeneration,
    attempt,
    elapsedMs,
    rehydratedRoots,
    staleLossEvents,
    error,
    receipt,
  } = options;
  const isAcquisitionPhase = (phase: RecoveryPhase): boolean =>
    phase === 'acquire-adapter' || phase === 'acquire-device';
  const retryable =
    outcome === 'failed' && (failureLocation?.retryable ?? isAcquisitionPhase(failurePhase));
  return createRecoveryFailedError({
    phase: failurePhase,
    oldGeneration: fromGeneration,
    candidateGeneration,
    attempt,
    elapsedMs,
    retryable,
    guidance:
      outcome === 'disposed'
        ? 'rebuild-renderer'
        : (failureLocation?.guidance ?? (retryable ? 'retry' : 'repair-owner')),
    owner: outcome === 'disposed' ? 'renderer' : (failureLocation?.owner ?? 'renderer'),
    resourceKind:
      outcome === 'disposed' ? 'surface' : (failureLocation?.resourceKind ?? 'pipeline'),
    lastOutcome: outcome,
    rehydratedRoots,
    staleLossEvents,
    cause: outcome === 'disposed' ? error : (failureLocation?.cause ?? error),
    cleanupFailures: [],
    receipt,
  });
}
