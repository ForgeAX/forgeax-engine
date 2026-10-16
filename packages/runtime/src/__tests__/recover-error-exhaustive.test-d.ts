// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): recover cluster
// exhaustive type-level regression guard (see render-error-exhaustive.test-d.ts
// header for the shared pattern rationale). RecoverError carries no .detail
// field, so this guard covers the RecoverErrorCode exhaustiveness only.

import type { RecoverError, RecoverErrorCode } from '../../../render/src/errors/recover';

function exhaustiveSwitchOnRecoverCode(code: RecoverErrorCode): string {
  switch (code) {
    case 'recover-not-needed':
      return code;
    case 'recover-not-implemented':
      return code;
    case 'recover-adapter-unavailable':
      return code;
    case 'recover-device-unavailable':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

// RecoverError is a single concrete class; assert its .code is a RecoverErrorCode.
function narrowRecoverError(err: RecoverError): RecoverErrorCode {
  return err.code;
}

export type _RecoverExhaustiveChecks = {
  /** @internal forces tsc to type-check the exhaustive switch on RecoverErrorCode. */
  _check: ReturnType<typeof exhaustiveSwitchOnRecoverCode>;
  /** @internal forces tsc to type-check the RecoverError .code accessor. */
  _narrow: typeof narrowRecoverError;
};
