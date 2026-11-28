import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { inRange, type Range } from './common';

/**
 * Song-dynasty cai (timber section) grades, Yingzao Fashi vol. 4. Each grade gives the cai
 * width (guang) and depth (hou) in cun. The grade table is secondary (zh.wikipedia, cai-fen
 * system); the 15 / 10 fen division of the cai is verified against vol. 4.
 */
export const CAI_GRADES = {
  1: { width: 9, depth: 6 },
  2: { width: 8.25, depth: 5.5 },
  3: { width: 7.5, depth: 5 },
  4: { width: 7.2, depth: 4.8 },
  5: { width: 6.6, depth: 4.4 },
  6: { width: 6, depth: 4 },
  7: { width: 5.25, depth: 3.5 },
  8: { width: 4.5, depth: 3 },
} as const satisfies Record<number, { readonly width: number; readonly depth: number }>;

export type CaiGrade = keyof typeof CAI_GRADES;

export const CAI_GRADE_RANGE = [1, 8] as const satisfies Range;

/**
 * One cun in meters. Secondary: taken from a Song foot of about 0.316 m, which no checked
 * source in this repository states. Every fen ratio below is exact; only the metric scale
 * depends on it.
 */
export const CUN_METERS = 0.0316;

/** Cai width is 15 fen and depth 10 fen (verified, vol. 4). */
export const CAI_WIDTH_FEN = 15;
export const CAI_DEPTH_FEN = 10;
/**
 * Xie (the layer above the cai) is 6 fen wide and 4 fen thick; zu-cai (cai plus xie) is
 * 21 fen tall (derived).
 */
export const XIE_WIDTH_FEN = 6;
export const XIE_DEPTH_FEN = 4;
export const ZU_CAI_HEIGHT_FEN = CAI_WIDTH_FEN + XIE_WIDTH_FEN;

export interface CaiFen {
  readonly grade: CaiGrade;
  /** Length of one fen in meters (the cai width divided by 15). */
  readonly fen: number;
  /** Cai width (guang), the member height in meters, 15 fen. */
  readonly width: number;
  /** Cai depth (hou), the member thickness in meters, 10 fen. */
  readonly depth: number;
  /** Xie height and thickness in meters, 6 by 4 fen. */
  readonly xieWidth: number;
  readonly xieDepth: number;
  /** Zu-cai height in meters, cai plus xie. */
  readonly zuCai: number;
}

/**
 * Fen length and member sizes of one cai grade in meters. Refuses a grade outside 1..8 with a
 * structured `model-invalid-argument`, since the grade table has no other row.
 */
export function caiFen(grade: number): Result<CaiFen, ModelingError> {
  const checked = inRange('grade', grade, CAI_GRADE_RANGE, true);
  if (!checked.ok) return checked;
  const row = CAI_GRADES[checked.value as CaiGrade];
  const fen = (row.width * CUN_METERS) / CAI_WIDTH_FEN;
  return ok({
    grade: checked.value as CaiGrade,
    fen,
    width: CAI_WIDTH_FEN * fen,
    depth: CAI_DEPTH_FEN * fen,
    xieWidth: XIE_WIDTH_FEN * fen,
    xieDepth: XIE_DEPTH_FEN * fen,
    zuCai: ZU_CAI_HEIGHT_FEN * fen,
  });
}
