// Must-fail registry: each row proves a judging check can turn red. `pass` must return a passing
// verdict, `fail` must return a failing verdict whose codes include `expect`. Rows name the check by
// its derived export name (see surface.ts): `checkLayout`, `brep.validate`, or `Model.validate`.

export interface Verdict {
  readonly pass: boolean;
  /** Issue or failure codes the check reported, for example "shut-line-gap". */
  readonly codes: readonly string[];
}

export interface FalsifierRow {
  readonly check: string;
  /**
   * Distinguishes several rows of one check (for example the same `Model.validate` judging a
   * second input). Rows are unique by check + variant; a row without a variant is the check's only
   * row without one.
   */
  readonly variant?: string;
  readonly pass: () => Verdict;
  readonly fail: () => Verdict;
  readonly expect: string;
}

/** A judging check without a row yet. The reason is one line and names what blocks it. */
export interface PendingCheck {
  readonly check: string;
  readonly reason: string;
}

import { ASSEMBLY_PENDING, ASSEMBLY_ROWS } from './rows-assembly';
import { MESH_PENDING, MESH_ROWS } from './rows-mesh';
import { SURFACE_PENDING, SURFACE_ROWS } from './rows-surface';

export const ROWS: readonly FalsifierRow[] = [...MESH_ROWS, ...SURFACE_ROWS, ...ASSEMBLY_ROWS];

export const PENDING: readonly PendingCheck[] = [
  ...MESH_PENDING,
  ...SURFACE_PENDING,
  ...ASSEMBLY_PENDING,
];
