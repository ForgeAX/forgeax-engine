// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { curvePoint } from '../../curves';
import {
  type IntersectionBranch,
  intersectSurfaces,
  type SurfaceIntersection,
} from '../../intersect';
import { dist3, madd3, type P3 } from '../../vec';
import { implicit } from './check';
import { type AnalyticSurface, E1_TOL, type E1Pair, type RefBranch } from './corpus';

export function run(p: E1Pair, tol = E1_TOL): SurfaceIntersection {
  const r = intersectSurfaces(p.a, p.b, tol, { window: p.window, ids: [3, 7] });
  if (!r.ok) throw new Error(`${p.id}: ${JSON.stringify(r.error)}`);
  return r.value;
}

export function polyline(b: IntersectionBranch, n: number): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= n; i++) out.push(curvePoint(b.curve, b.t0 + ((b.t1 - b.t0) * i) / n));
  return out;
}

export function refPoints(b: RefBranch, n: number): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= n; i++) out.push(b.at(b.t0 + ((b.t1 - b.t0) * i) / n));
  return out;
}

export function nearest(p: P3, lines: readonly P3[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k]!;
      const ab: P3 = [line[k + 1]![0] - a[0], line[k + 1]![1] - a[1], line[k + 1]![2] - a[2]];
      const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const t =
        l2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2,
              ),
            );
      best = Math.min(best, dist3(p, madd3(a, ab, t)));
    }
  }
  return best;
}

/** Independent residual of a returned branch against the implicit equations of both surfaces. */
export function residual(
  b: IntersectionBranch,
  a: AnalyticSurface,
  c: AnalyticSurface,
  n: number,
): number {
  let worst = 0;
  for (const p of polyline(b, n)) {
    worst = Math.max(worst, Math.abs(implicit(a, p)), Math.abs(implicit(c, p)));
  }
  return worst;
}

/** Whether a branch's receipt covers the independently measured residual; the number is the measured one. */
export function receiptHolds(
  b: IntersectionBranch,
  a: AnalyticSurface,
  c: AnalyticSurface,
): boolean {
  const measured = residual(b, a, c, 20011);
  return b.receipt === 'closed-form' ? measured <= 1e-12 : measured <= b.receipt.bound;
}
