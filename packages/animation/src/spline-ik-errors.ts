export type SplineIKErrorCode =
  | 'spline-ik-invalid'
  | 'spline-ik-stale'
  | 'spline-ik-length-unreachable'
  | 'spline-ik-conflict';

/** Closed expected failures; no chain is committed after failed evaluation. */
export class SplineIKError extends Error {
  override readonly name = 'SplineIKError';
  readonly expected = 'live explicit contiguous chain, finite controls and supported uniform scale';
  readonly hint = 'repair the named binding or curve; rebind after topology changes';
  constructor(
    readonly code: SplineIKErrorCode,
    readonly detail: { readonly reason: string; readonly entity?: number; readonly joint?: number },
  ) {
    super(`[${code}] ${detail.reason}`);
  }
}
