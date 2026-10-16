import type { CatalogDiagnostic } from '@forgeax/engine-types';
import { projectFailureCause } from './errors.js';

type RuntimeDiagnosticInput = Omit<CatalogDiagnostic, 'severity' | 'cause'> & {
  readonly message: string;
  readonly cause?: unknown;
};

export function projectRuntimeDiagnostics(
  diagnostics: readonly RuntimeDiagnosticInput[],
): readonly CatalogDiagnostic[] {
  return diagnostics.map(({ code, message, expected, actual, hint, cause }) => {
    const projectedCause = projectFailureCause(cause);
    return {
      code,
      ...(projectedCause === undefined ? {} : { cause: projectedCause }),
      severity: 'blocking' as const,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
      ...(hint === undefined ? {} : { hint }),
    };
  });
}
