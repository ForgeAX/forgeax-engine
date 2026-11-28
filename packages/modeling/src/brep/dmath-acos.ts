import { atan2 } from '../dmath';

/**
 * Deterministic arccosine of `x` in [-1, 1] (NaN outside): `2 atan2(sqrt(1 - x), sqrt(1 + x))`. `1 - x` is exact for
 * x in [0.5, 1] and `1 + x` for x in [-1, -0.5] (Sterbenz), so the half angle keeps full relative accuracy where
 * acos is steepest. Built only from IEEE sqrt and the fdlibm `atan2` of `../dmath`, so every host agrees on the bits;
 * it stays within a few ulps of the host `Math.acos`.
 */
export function acos(x: number): number {
  if (!(x >= -1 && x <= 1)) return Number.NaN;
  return 2 * atan2(Math.sqrt(1 - x), Math.sqrt(1 + x));
}
