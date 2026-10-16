import type { Result } from '@forgeax/engine-types';

/** The exact owning ECS World and complete generation-bearing entity handles. */
export interface PairIsolationInput {
  readonly worldIdentity: object;
  readonly entityA: number;
  readonly entityB: number;
}

/** One bounded reference to an exact body pair; repeated release is harmless. */
export interface PairIsolationLease {
  release(): Result<void, PairIsolationError>;
}

export type PairIsolationErrorCode =
  | 'pair-isolation-world-mismatch'
  | 'pair-isolation-entity-invalid'
  | 'pair-isolation-body-unavailable'
  | 'pair-isolation-backend-unavailable'
  | 'pair-isolation-busy'
  | 'pair-isolation-budget-exceeded';

export class PairIsolationError extends Error {
  constructor(
    readonly code: PairIsolationErrorCode,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<{
      entityA: number;
      entityB: number;
      reason?: string;
      used?: number;
      limit?: number;
    }>,
  ) {
    super(`${code}: ${expected}`);
    this.name = 'PairIsolationError';
    Object.freeze(detail);
  }
}
