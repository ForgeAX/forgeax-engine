import type {
  ReflectionFallbackFailureStage,
  ReflectionFallbackInspection,
  ReflectionFallbackReceipt,
  ReflectionFallbackRecoveryAction,
} from '../inspection-types';

export interface ReflectionFallbackFailureInput {
  readonly stage: ReflectionFallbackFailureStage;
  readonly code: string;
  readonly expected: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

function recoveryFor(
  receipt: ReflectionFallbackReceipt,
  failure?: ReflectionFallbackFailureInput,
): ReflectionFallbackRecoveryAction {
  if (failure !== undefined) {
    const code = failure.code.toLowerCase();
    if (code.includes('device') || code.includes('format') || code.includes('capability')) {
      return 'rebuild';
    }
    if (failure.stage === 'prepare' || failure.stage === 'filter') return 'recapture';
    if (failure.stage === 'build' || failure.stage === 'encode') return 'rebuild';
    if (failure.stage === 'finish' || failure.stage === 'submit') return 'retry';
    // Completion failures may still retain a source-identical committed row;
    // use it as LKG, otherwise retry the producer completion.
    if (failure.stage === 'completion') {
      if (receipt.source === 'probe' && (receipt.state === 'active' || receipt.state === 'lkg')) {
        return 'use-LKG';
      }
      if (
        receipt.source === 'skylight' &&
        (receipt.state === 'active' || receipt.state === 'lkg')
      ) {
        return 'use-Skylight';
      }
      if (receipt.source === 'neutral' && receipt.state === 'neutral') return 'use-neutral';
      return 'retry';
    }
  }
  if (receipt.source === 'probe' && (receipt.state === 'active' || receipt.state === 'lkg')) {
    return 'use-LKG';
  }
  if (receipt.source === 'skylight' || receipt.state === 'lkg') return 'use-Skylight';
  return 'use-neutral';
}

/** Projects producer state and the latest closed failure into detached facts. */
export function inspectReflectionFallback(
  receipt: ReflectionFallbackReceipt,
  failure?: ReflectionFallbackFailureInput,
): ReflectionFallbackInspection {
  return {
    receipt,
    recoveryAction: recoveryFor(receipt, failure),
    ...(failure === undefined
      ? {}
      : {
          failureStage: failure.stage,
          failureCode: failure.code,
          expected: failure.expected,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        }),
  };
}
