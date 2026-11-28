import type { Result } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { brepFail } from './types';

/** Floor of every tolerance: below this f64 geometry carries no information. */
export const TOL_FLOOR = 1e-9;

export interface ToleranceOptions {
  /** Shape tolerance; default `1e-6 * max(1, diag)`, never below 1e-9. */
  readonly tol?: number;
  /** Largest tolerance an operation may grow to; default `1e-4 * max(1, diag)`. */
  readonly maxTol?: number;
}

export interface ToleranceModel {
  readonly tol: number;
  readonly maxTol: number;
}

export function defaultTolerance(diag: number): ToleranceModel {
  const scale = Math.max(1, diag);
  return { tol: Math.max(TOL_FLOOR, 1e-6 * scale), maxTol: 1e-4 * scale };
}

export function resolveTolerance(
  diag: number,
  options: ToleranceOptions = {},
): Result<ToleranceModel, ModelingError> {
  const base = defaultTolerance(diag);
  const tol = options.tol ?? base.tol;
  const maxTol = options.maxTol ?? base.maxTol;
  if (!Number.isFinite(tol) || !Number.isFinite(maxTol) || tol < TOL_FLOOR || maxTol < tol) {
    return brepFail('brep-bad-argument', 'finite tol >= 1e-9 and maxTol >= tol', { tol, maxTol });
  }
  return ok({ tol, maxTol });
}
