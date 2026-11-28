import { cross3, dist3, dot3, len3, scale3, sub3 } from '../vec';
import { bezierPieces, clipToBox, type HullNode, hullNode, splitNode } from './hull';
import { tangentParams } from './implicit-problem';
import { solveSmall } from './linalg';
import type { Constraint, Kink, Local, Problem } from './problem';
import type { NurbsSide } from './side';

const NEWTON_ITERATIONS = 40;
const MAX_PAIRS = 2_000_000;

/**
 * Two NURBS faces in the 4-dimensional state (u1, v1, u2, v2). The three equations `S1 - S2 = 0`
 * leave a one-dimensional solution set, so the marcher, fitter and seeding see the same problem
 * shape as the NURBS x analytic case, with state indices 2 and 3 naming face B.
 */
export function nurbsNurbsProblem(a: NurbsSide, b: NurbsSide, ptTol: number): Problem {
  const ja = (x: readonly number[]) => a.jet(x[0] as number, x[1] as number);
  const jb = (x: readonly number[]) => b.jet(x[2] as number, x[3] as number);
  const kinks: Kink[] = [
    ...a.kinks.map((k) => ({ index: k.dir, value: k.value })),
    ...b.kinks.map((k) => ({ index: k.dir + 2, value: k.value })),
  ];
  return {
    dim: 4,
    ptTol,
    period: [a.period[0], a.period[1], b.period[0], b.period[1]],
    kinks,
    uvPeriod: [a.period, b.period],
    point: (x) => ja(x).p,
    local(x): Local | undefined {
      const A = ja(x);
      const B = jb(x);
      const n1 = cross3(A.du, A.dv);
      const n2 = cross3(B.du, B.dv);
      const l1 = len3(n1);
      const l2 = len3(n2);
      if (!(l1 > 0) || !(l2 > 0)) return undefined;
      const t0 = cross3(n1, n2);
      const lt = len3(t0);
      if (!(lt > 0)) return { p: A.p, t: [0, 0, 0], sin: 0, dxds: [0, 0, 0, 0] };
      const t = scale3(t0, 1 / lt);
      const da = tangentParams(A.du, A.dv, t);
      const db = tangentParams(B.du, B.dv, t);
      if (da === undefined || db === undefined) return undefined;
      return { p: A.p, t, sin: lt / (l1 * l2), dxds: [...da, ...db] };
    },
    correct(x0, c) {
      const x = [x0[0] as number, x0[1] as number, x0[2] as number, x0[3] as number];
      for (let it = 0; it < NEWTON_ITERATIONS; it++) {
        const dx = step(x, c);
        if (dx === undefined || !dx.every(Number.isFinite)) return undefined;
        let moved = 0;
        for (let i = 0; i < 4; i++) {
          x[i] = (x[i] as number) + (dx[i] as number);
          moved = Math.max(moved, Math.abs(dx[i] as number));
        }
        if (moved <= 1e-12) break;
      }
      const pa = ja(x).p;
      const pb = jb(x).p;
      if (!(dist3(pa, pb) <= ptTol)) return undefined;
      if (c.kind === 'plane' && !(Math.abs(dot3(sub3(pa, c.anchor), c.t)) <= ptTol))
        return undefined;
      if (c.kind === 'param' && !(Math.abs((x[c.index] as number) - c.value) <= 1e-9))
        return undefined;
      return x;
    },
    inside(x) {
      return a.inside(x[0] as number, x[1] as number) && b.inside(x[2] as number, x[3] as number);
    },
    exitPin(x) {
      const ea = a.exit(x[0] as number, x[1] as number);
      if (ea !== undefined) return { index: ea.dir, value: ea.value };
      const eb = b.exit(x[2] as number, x[3] as number);
      return eb === undefined ? undefined : { index: eb.dir + 2, value: eb.value };
    },
    uv(x) {
      return [
        [x[0] as number, x[1] as number],
        [x[2] as number, x[3] as number],
      ];
    },
    imageA(uv) {
      return a.jet(uv[0], uv[1]).p;
    },
    imageB(uv) {
      return b.jet(uv[0], uv[1]).p;
    },
  };

  /** One Newton step: the 3 surface equations plus the constraint row, square or minimum-norm. */
  function step(x: number[], c: Constraint): number[] | undefined {
    const A = ja(x);
    const B = jb(x);
    const F = sub3(A.p, B.p);
    // Columns d/du1, d/dv1, d/du2, d/dv2 of S1 - S2.
    const J = [0, 1, 2].map((r) => [
      A.du[r] as number,
      A.dv[r] as number,
      -(B.du[r] as number),
      -(B.dv[r] as number),
    ]);
    if (c.kind === 'none') {
      const G = J.map((row) => J.map((other) => dot4(row, other)));
      const y = solveSmall(G, [-(F[0] as number), -(F[1] as number), -(F[2] as number)]);
      if (y === undefined) return undefined;
      return [0, 1, 2, 3].map((i) =>
        J.reduce((s, row, r) => s + (row[i] as number) * (y[r] as number), 0),
      );
    }
    const extra =
      c.kind === 'plane'
        ? { row: [dot3(c.t, A.du), dot3(c.t, A.dv), 0, 0], rhs: dot3(sub3(A.p, c.anchor), c.t) }
        : {
            row: [0, 1, 2, 3].map((i) => (i === c.index ? 1 : 0)),
            rhs: (x[c.index] as number) - c.value,
          };
    return solveSmall(
      [...J, extra.row],
      [-(F[0] as number), -(F[1] as number), -(F[2] as number), -extra.rhs],
    );
  }
}

function dot4(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function overlaps(x: HullNode, y: HullNode, margin: number): boolean {
  return dist3(x.c, y.c) <= x.r + y.r + margin;
}

/**
 * Subdivide the pair of Bezier pieces while their control balls overlap; a pair whose two leaves
 * are both at most `resolution` gives one minimum-norm Newton seed from the leaf centres.
 */
export function nurbsNurbsSeeds(
  a: NurbsSide,
  b: NurbsSide,
  problem: Problem,
  resolution: number,
): { seeds: number[][]; leaves: number; truncated: boolean } {
  const ca = clipToBox(a.surface, a.box);
  const cb = clipToBox(b.surface, b.box);
  const seeds: number[][] = [];
  if (ca === undefined || cb === undefined) return { seeds, leaves: 0, truncated: true };
  const margin = 10 * problem.ptTol;
  const pa = bezierPieces(ca).map(hullNode);
  const pb = bezierPieces(cb).map(hullNode);
  const stack: [HullNode, HullNode][] = [];
  for (const x of pa) for (const y of pb) if (overlaps(x, y, margin)) stack.push([x, y]);
  let leaves = 0;
  let visited = 0;
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [HullNode, HullNode];
    if (++visited > MAX_PAIRS) return { seeds, leaves, truncated: true };
    if (!overlaps(x, y, margin)) continue;
    const order: ('a' | 'b')[] = x.r >= y.r ? ['a', 'b'] : ['b', 'a'];
    let split = false;
    for (const side of order) {
      const n = side === 'a' ? x : y;
      if (!(n.r > resolution)) continue;
      const parts = splitNode(n);
      if (parts === undefined) continue;
      for (const part of parts) stack.push(side === 'a' ? [part, y] : [x, part]);
      split = true;
      break;
    }
    if (split) continue;
    leaves++;
    const guess = [...centre(x), ...centre(y)];
    const seed = problem.correct(guess, { kind: 'none' });
    if (seed !== undefined && problem.inside(seed)) seeds.push(seed);
  }
  return { seeds, leaves, truncated: false };
}

function centre(n: HullNode): [number, number] {
  return [0.5 * (n.box[0][0] + n.box[0][1]), 0.5 * (n.box[1][0] + n.box[1][1])];
}
