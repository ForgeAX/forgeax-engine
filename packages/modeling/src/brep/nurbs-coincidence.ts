import type { P3 } from './vec';

/** Axis-aligned box as `[lo, hi]` corners. */
export type Box3 = readonly [P3, P3];

/**
 * Coincidence threshold for an approximate NURBS boundary against an analytic surface. The SSI
 * branch `bound` is the measured fit error (already widened by 1.25), so a contact is accepted only
 * when it is within four times that error. `tol` is the floor: an exact configuration never gets a
 * looser test than the analytic path.
 */
export function coincidenceThreshold(tol: number, branchBound: number): number {
  return Math.max(tol, 4 * branchBound);
}

/** Box that encloses every point of the list; `undefined` for an empty list. */
export function boxOf(points: readonly P3[]): Box3 | undefined {
  const [first, ...rest] = points;
  if (first === undefined) return undefined;
  let lo: P3 = [first[0], first[1], first[2]];
  let hi: P3 = [first[0], first[1], first[2]];
  for (const p of rest) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  return [lo, hi];
}

/** Box grown by `pad` on every side. */
export function inflate(box: Box3, pad: number): Box3 {
  const [lo, hi] = box;
  return [
    [lo[0] - pad, lo[1] - pad, lo[2] - pad],
    [hi[0] + pad, hi[1] + pad, hi[2] + pad],
  ];
}

/** True when the two boxes share a point (touching counts). */
export function boxesOverlap(a: Box3, b: Box3): boolean {
  const [alo, ahi] = a;
  const [blo, bhi] = b;
  return (
    alo[0] <= bhi[0] &&
    blo[0] <= ahi[0] &&
    alo[1] <= bhi[1] &&
    blo[1] <= ahi[1] &&
    alo[2] <= bhi[2] &&
    blo[2] <= ahi[2]
  );
}

/**
 * Prefilter for NURBS x cylinder: a pair whose inflated control-net box misses the cylinder's
 * finite box cannot meet, so SSI is not called. Necessary, not sufficient: an overlap still needs
 * the march and the coincidence test.
 */
export function mayCoincide(nurbsNet: Box3, cylinderBox: Box3, marchTol: number): boolean {
  return boxesOverlap(inflate(nurbsNet, marchTol / 100), cylinderBox);
}
