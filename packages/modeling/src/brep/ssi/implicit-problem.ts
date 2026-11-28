import { surfaceDomain, surfacePoint } from '../surfaces';
import { cross3, dot3, len3, type P3, scale3, sub3 } from '../vec';
import { solveSmall } from './linalg';
import type { Constraint, Local, Problem } from './problem';
import type { AnalyticSide, NurbsSide } from './side';

const NEWTON_ITERATIONS = 40;

/** Least-squares (du, dv) with `du Su + dv Sv = t`; undefined at a degenerate parametrization. */
export function tangentParams(su: P3, sv: P3, t: P3): number[] | undefined {
  const a = dot3(su, su);
  const b = dot3(su, sv);
  const c = dot3(sv, sv);
  const det = a * c - b * b;
  if (!(det > 1e-24 * a * c)) return undefined;
  const r0 = dot3(su, t);
  const r1 = dot3(sv, t);
  return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
}

function combine(du: P3, dv: P3, a: number, b: number): P3 {
  return [du[0] * a + dv[0] * b, du[1] * a + dv[1] * b, du[2] * a + dv[2] * b];
}

/**
 * NURBS face A against analytic face B in the state (u, v) of A: the curve is the zero set of
 * `g(u, v) = F(S(u, v))` with `F` the 1-Lipschitz implicit of B, so `|g|` is the distance from B.
 */
export function implicitProblem(a: NurbsSide, b: AnalyticSide, ptTol: number): Problem {
  const domB = surfaceDomain(b.surface);
  const evalAt = (x: readonly number[]) => {
    const j = a.jet(x[0] as number, x[1] as number);
    const G = b.grad(j.p);
    return { j, f: b.f(j.p), G, gu: dot3(G, j.du), gv: dot3(G, j.dv) };
  };
  const point = (x: readonly number[]) => a.jet(x[0] as number, x[1] as number).p;
  const step = (e: ReturnType<typeof evalAt>, x: number[], c: Constraint): number[] | undefined => {
    switch (c.kind) {
      case 'none': {
        const n2 = e.gu * e.gu + e.gv * e.gv;
        return n2 > 0 ? [(-e.f * e.gu) / n2, (-e.f * e.gv) / n2] : undefined;
      }
      case 'plane':
        return solveSmall(
          [
            [e.gu, e.gv],
            [dot3(c.t, e.j.du), dot3(c.t, e.j.dv)],
          ],
          [-e.f, -dot3(sub3(e.j.p, c.anchor), c.t)],
        );
      case 'param': {
        const pin = c.value - (x[c.index] as number);
        const d = c.index === 0 ? e.gv : e.gu;
        if (d === 0) return undefined;
        const lin = e.f + (c.index === 0 ? e.gu : e.gv) * pin;
        return c.index === 0 ? [pin, -lin / d] : [-lin / d, pin];
      }
    }
  };
  return {
    dim: 2,
    ptTol,
    period: a.period,
    kinks: a.kinks.map((k) => ({ index: k.dir, value: k.value })),
    uvPeriod: [a.period, [domB.uPeriod, domB.vPeriod]],
    point,
    local(x): Local | undefined {
      const { j, G } = evalAt(x);
      const n = cross3(j.du, j.dv);
      const ln = len3(n);
      const lg = len3(G);
      if (!(ln > 0) || !(lg > 0)) return undefined;
      const t0 = cross3(n, G);
      const lt = len3(t0);
      const sin = lt / (ln * lg);
      if (!(lt > 0)) return { p: j.p, t: [0, 0, 0], sin: 0, dxds: [0, 0] };
      const t = scale3(t0, 1 / lt);
      const d = tangentParams(j.du, j.dv, t);
      return d === undefined ? undefined : { p: j.p, t, sin, dxds: d };
    },
    correct(x0, c) {
      const x = [x0[0] as number, x0[1] as number];
      for (let it = 0; it < NEWTON_ITERATIONS; it++) {
        const e = evalAt(x);
        const dx = step(e, x, c);
        if (dx === undefined || !dx.every(Number.isFinite)) return undefined;
        x[0] = (x[0] as number) + (dx[0] as number);
        x[1] = (x[1] as number) + (dx[1] as number);
        if (len3(combine(e.j.du, e.j.dv, dx[0] as number, dx[1] as number)) <= 1e-3 * ptTol) break;
      }
      const p = point(x);
      if (!(Math.abs(b.f(p)) <= ptTol)) return undefined;
      if (c.kind === 'plane' && !(Math.abs(dot3(sub3(p, c.anchor), c.t)) <= ptTol))
        return undefined;
      return x;
    },
    inside(x) {
      return a.inside(x[0] as number, x[1] as number) && b.inside(point(x));
    },
    exitPin(x) {
      const e = a.exit(x[0] as number, x[1] as number);
      return e === undefined ? undefined : { index: e.dir, value: e.value };
    },
    uv(x) {
      return [[x[0] as number, x[1] as number], b.uv(point(x))];
    },
    imageA(uv) {
      return a.jet(uv[0], uv[1]).p;
    },
    imageB(uv) {
      return surfacePoint(b.surface, uv[0], uv[1]);
    },
  };
}
