import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';

/** ISO 286 clearance fits, hole basis: locating, sliding, precision running, loose running. */
export type FitClass = 'H7/h6' | 'H7/g6' | 'H8/f7' | 'H11/c11';

export const FIT_CLASSES: readonly FitClass[] = ['H7/h6', 'H7/g6', 'H8/f7', 'H11/c11'];

/** One ISO 286 fit at a nominal size, in meters: diameters as [min, max], clearance diametral. */
export interface IsoFit {
  readonly fit: FitClass;
  readonly nominal: number;
  readonly hole: readonly [number, number];
  readonly shaft: readonly [number, number];
  readonly clearance: readonly [number, number];
  /** Diameters at the middle of each tolerance band, and their clearance. */
  readonly holeMid: number;
  readonly shaftMid: number;
  readonly clearanceMid: number;
}

// Nominal size steps (upper bound, mm), standard tolerance grades IT6/IT7/IT8/IT11 and the
// shaft fundamental deviations c/f/g (es, micrometres) of ISO 286-1/-2 up to 180 mm.
const STEPS = [3, 6, 10, 18, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180] as const;
const IT6 = [6, 8, 9, 11, 13, 16, 16, 19, 19, 22, 22, 25, 25, 25] as const;
const IT7 = [10, 12, 15, 18, 21, 25, 25, 30, 30, 35, 35, 40, 40, 40] as const;
const IT8 = [14, 18, 22, 27, 33, 39, 39, 46, 46, 54, 54, 63, 63, 63] as const;
const IT11 = [60, 75, 90, 110, 130, 160, 160, 190, 190, 220, 220, 250, 250, 250] as const;
const C = [-60, -70, -80, -95, -110, -120, -130, -140, -150, -170, -180, -200, -210, -230] as const;
const F = [-6, -10, -13, -16, -20, -25, -25, -30, -30, -36, -36, -43, -43, -43] as const;
const G = [-2, -4, -5, -6, -7, -9, -9, -10, -10, -12, -12, -14, -14, -14] as const;

/** The ISO 286 limits of `fit` at nominal diameter `d` (meters, 1 mm to 180 mm). */
export function isoFit(d: number, fit: FitClass): Result<IsoFit, ModelingError> {
  const mm = d * 1000;
  if (!Number.isFinite(mm) || mm < 1 || mm > 180) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a nominal diameter within the ISO 286 table, 0.001 to 0.18 m',
        { d },
      ),
    );
  }
  if (!FIT_CLASSES.includes(fit)) {
    return err(
      modelingError('model-invalid-argument', `a fit class ${FIT_CLASSES.join(' | ')}`, { fit }),
    );
  }
  const step = STEPS.findIndex((upper) => mm <= upper);
  const at = (row: readonly number[]) => (row[step] as number) / 1e6;
  const [holeGrade, shaftGrade, es] =
    fit === 'H7/h6'
      ? [at(IT7), at(IT6), 0]
      : fit === 'H7/g6'
        ? [at(IT7), at(IT6), at(G)]
        : fit === 'H8/f7'
          ? [at(IT8), at(IT7), at(F)]
          : [at(IT11), at(IT11), at(C)];
  const hole = [d, d + holeGrade] as const;
  const shaft = [d + es - shaftGrade, d + es] as const;
  const holeMid = (hole[0] + hole[1]) / 2;
  const shaftMid = (shaft[0] + shaft[1]) / 2;
  return ok({
    fit,
    nominal: d,
    hole,
    shaft,
    clearance: [hole[0] - shaft[1], hole[1] - shaft[0]],
    holeMid,
    shaftMid,
    clearanceMid: holeMid - shaftMid,
  });
}
