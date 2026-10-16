import type { DeviceResourceKind } from '../../device/resource-types';
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
