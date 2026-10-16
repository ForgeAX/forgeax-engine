// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): environment
// cluster type-level regression guard. EngineEnvironmentError predates the
// closed-union error model: it has NO `.code` field and is never fanned out
// through onError (it throws at construction), so the cluster has no
// *ErrorCode code union. This guard instead pins the class's structured
// `.detail` shape (EngineEnvironmentErrorDetail) so a future edit that drops or
// re-types the two optional error carriers is caught at typecheck.
//
// See render-error-exhaustive.test-d.ts header for the shared *.test-d.ts
// pattern rationale.

import type { RhiError } from '@forgeax/engine-rhi';
import type { EngineEnvironmentError, EngineEnvironmentErrorDetail } from '../errors/environment';

function narrowEnvironmentError(err: EngineEnvironmentError): void {
  void err.reason; // string
  const detail: EngineEnvironmentErrorDetail = err.detail;
  // Both carriers are optional RhiError | Error and read via property access.
  const webgpu: RhiError | Error | undefined = detail.webgpuError;
  const wgpu: RhiError | Error | undefined = detail.wgpuError;
  void webgpu;
  void wgpu;
}

export type _EnvironmentChecks = {
  /** @internal forces tsc to type-check the EngineEnvironmentError detail shape. */
  _narrow: typeof narrowEnvironmentError;
};
