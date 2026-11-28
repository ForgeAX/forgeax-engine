import { curvePoint } from './curves';
import type { Curve } from './types';
import { dist3 } from './vec';

const CHORDS = 64;

/** Arc length of an edge parameter span, by a fixed chord polyline. Depends only on the edge, so both faces agree. */
export function curveSpanLength(curve: Curve, t0: number, t1: number): number {
  let length = 0;
  let prev = curvePoint(curve, t0);
  for (let k = 1; k <= CHORDS; k++) {
    const next = curvePoint(curve, t0 + ((t1 - t0) * k) / CHORDS);
    length += dist3(prev, next);
    prev = next;
  }
  return length;
}
