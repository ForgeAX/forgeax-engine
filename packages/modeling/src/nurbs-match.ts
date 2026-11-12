import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkSurface,
  clampH,
  type NurbsSurface,
  surfaceDomain,
  surfacePoint,
  transpose,
} from './nurbs';
import { mapLines, type PatchSide, surfaceCompatible, surfaceReverse } from './nurbs-surface';
import { type EdgeResidual, measureEdge } from './surface-quality';

/**
 * Boundary matching (G0 to G3 matching): move the control rows of patch `a`
 * next to `sideA` so it meets `b`'s `sideB` with G0 to G3 continuity. Both sides are made
 * compatible along the edge first (same degree and knots, exact); then rows 0..level
 * of `a` (counted from the edge) are set from `b`'s cross-edge derivatives under a
 * constant reparametrization chosen to move `a` least. No other control point changes.
 */
export type MatchLevel = 'G0' | 'G1' | 'G2' | 'G3';

export interface MatchOptions {
  readonly level: MatchLevel;
  /** 'a' (default) moves only `a`; 'both' moves both patches toward a common edge. */
  readonly modify?: 'a' | 'both';
  /** Keep `a`'s edge row (and `b`'s, with 'both') where it is; match only the derivatives. */
  readonly lockPosition?: boolean;
  /**
   * Continuity `a`'s opposite side must keep (its rows stay fixed): default 'G0', the
   * opposite edge does not move; 'none' lets the match move it.
   */
  readonly opposite?: MatchLevel | 'none';
  /**
   * Spread the last matched row's displacement over the free rows behind it, fading
   * linearly to zero (0, the default: only the matched rows move; 1: across all free rows).
   */
  readonly influence?: number;
  /** Residual samples along the edge (default 32). */
  readonly samples?: number;
  /**
   * Where the constant reparametrization is fit: 'fit' (default) to every control column,
   * 'ends' to the two end columns only, so a side whose ends lie on fixed curves (pieces of
   * the same feature lines as the master's adjacent sides) keeps them exactly.
   */
  readonly scale?: 'fit' | 'ends';
}

export interface MatchResult {
  readonly a: NurbsSurface;
  readonly b: NurbsSurface;
  /** Measured on the result along the edge. */
  readonly residual: EdgeResidual;
  /** Control rows of `a` that changed, counted from the edge. */
  readonly rows: number;
}

const LEVELS: Readonly<Record<MatchLevel, number>> = { G0: 0, G1: 1, G2: 2, G3: 3 };
const SIDES: readonly PatchSide[] = ['u0', 'u1', 'v0', 'v1'];

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/** Reorient so `side` becomes u = u-min (row 0, running along v). */
function toFrame(s: NurbsSurface, side: PatchSide): NurbsSurface {
  switch (side) {
    case 'u0':
      return s;
    case 'u1':
      return surfaceReverse(s, 'u');
    case 'v0':
      return transpose(s);
    case 'v1':
      return surfaceReverse(transpose(s), 'u');
  }
}

function fromFrame(s: NurbsSurface, side: PatchSide): NurbsSurface {
  switch (side) {
    case 'u0':
      return s;
    case 'u1':
      return surfaceReverse(s, 'u');
    case 'v0':
      return transpose(s);
    case 'v1':
      return transpose(surfaceReverse(s, 'u'));
  }
}

/**
 * Coefficients of the derivatives at the start of a clamped curve: row k holds the
 * weights of control points 0..k in C^(k)(start) (derivative control points, A3.3).
 */
function startDerivatives(p: number, knots: readonly number[], order: number): number[][] {
  let level: number[][] = Array.from({ length: order + 1 }, (_, i) =>
    Array.from({ length: order + 1 }, (__, j) => (i === j ? 1 : 0)),
  );
  const out: number[][] = [(level[0] as number[]).slice()];
  for (let k = 1; k <= order; k++) {
    const next: number[][] = [];
    for (let i = 0; i + 1 < level.length; i++) {
      const den = (knots[i + p + 1] as number) - (knots[i + k] as number);
      const f = den > 0 ? (p - k + 1) / den : 0;
      next.push(
        (level[i + 1] as number[]).map((x, c) => f * (x - ((level[i] as number[])[c] as number))),
      );
    }
    level = next;
    out.push((level[0] as number[]).slice());
  }
  return out;
}

const add = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Tuple3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** C^(k) at the edge for each column, from rows 0..k. */
function derivative(rows: readonly (readonly Tuple3[])[], w: readonly number[]): Tuple3[] {
  const nv = (rows[0] as readonly Tuple3[]).length;
  return Array.from({ length: nv }, (_, j) => {
    let acc: Tuple3 = [0, 0, 0];
    for (const [i, c] of w.entries())
      if (c !== 0) acc = add(acc, scale((rows[i] as readonly Tuple3[])[j] as Tuple3, c));
    return acc;
  });
}

/** The scalar s minimizing sum |base + s dir - goal|^2 over the columns (0 when dir vanishes). */
function leastScalar(
  base: readonly Tuple3[],
  dir: readonly Tuple3[],
  goal: readonly Tuple3[],
  ends = false,
): number {
  let num = 0;
  let den = 0;
  for (const [j, d] of dir.entries()) {
    if (ends && j !== 0 && j !== dir.length - 1) continue;
    num += dot(d, sub(goal[j] as Tuple3, base[j] as Tuple3));
    den += dot(d, d);
  }
  return den > 0 ? num / den : 0;
}

/** Row k from its target derivative: solve C^(k) = sum_i w[i] P_i for P_k. */
function rowFrom(
  rows: Tuple3[][],
  w: readonly number[],
  k: number,
  target: readonly Tuple3[],
): Tuple3[] {
  return target.map((t, j) => {
    let rest: Tuple3 = [0, 0, 0];
    for (let i = 0; i < k; i++)
      rest = add(rest, scale((rows[i] as Tuple3[])[j] as Tuple3, w[i] as number));
    return scale(sub(t, rest), 1 / (w[k] as number));
  });
}

/**
 * Match `a`'s `sideA` to `b`'s `sideB` (see the module comment). Fails with
 * `model-precondition` when `a` lacks the rows or degree the level needs, when the
 * patches fold over at the edge, or for rational patches.
 */
export function matchSurfaces(
  a: NurbsSurface,
  sideA: PatchSide,
  b: NurbsSurface,
  sideB: PatchSide,
  options: MatchOptions,
): Result<MatchResult, ModelingError> {
  // Weights within an ulp-scale of 1 (refits, homogeneous round trips) are polynomial.
  const polynomial = (s: NurbsSurface): NurbsSurface =>
    s.weights?.every((row) => row.every((w) => Math.abs(w - 1) <= 1e-12)) === true
      ? {
          degreeU: s.degreeU,
          degreeV: s.degreeV,
          points: s.points,
          knotsU: s.knotsU,
          knotsV: s.knotsV,
        }
      : s;
  a = polynomial(a);
  b = polynomial(b);
  for (const s of [a, b]) {
    const c = checkSurface(s);
    if (!c.ok) return c;
    if (s.weights !== undefined)
      return err(
        modelingError(
          'model-precondition',
          'matched patches are non-rational',
          {},
          'refit the patch with nurbs.fitSurface',
        ),
      );
  }
  if (!SIDES.includes(sideA) || !SIDES.includes(sideB))
    return err(invalid("sides are 'u0', 'u1', 'v0' or 'v1'", { sideA, sideB }));
  const level = LEVELS[options.level];
  if (level === undefined)
    return err(invalid("level is 'G0', 'G1', 'G2' or 'G3'", { level: options.level }));
  const modify = options.modify ?? 'a';
  if (modify !== 'a' && modify !== 'both')
    return err(invalid("modify is 'a' or 'both'", { modify }));
  const opposite = options.opposite ?? 'G0';
  const held = opposite === 'none' ? -1 : LEVELS[opposite];
  if (held === undefined) return err(invalid("opposite is 'none' or 'G0' to 'G3'", { opposite }));
  const influence = options.influence ?? 0;
  if (!(Number.isFinite(influence) && influence >= 0 && influence <= 1))
    return err(invalid('influence is a number from 0 to 1', { influence }));
  const lock = options.lockPosition === true;
  const fitAt = options.scale ?? 'fit';
  if (fitAt !== 'fit' && fitAt !== 'ends')
    return err(invalid("scale is 'fit' or 'ends'", { scale: fitAt }));
  const ends = fitAt === 'ends';

  // Canonical frames: each edge is row 0 (u = u-min), running along v.
  let A = clampU(toFrame(a, sideA));
  let B = clampU(toFrame(b, sideB));
  const [[ua0], [va0]] = surfaceDomain(A);
  const [[ub0], [vb0, vb1]] = surfaceDomain(B);
  const startA = surfacePoint(A, ua0, va0);
  const distance = (x: Tuple3) => Math.sqrt(dot(x, x));
  const reversedB =
    distance(sub(startA, surfacePoint(B, ub0, vb1))) <
    distance(sub(startA, surfacePoint(B, ub0, vb0)));
  if (reversedB) B = surfaceReverse(B, 'v');
  const compatible = surfaceCompatible([A, B], 'v');
  if (!compatible.ok) return compatible;
  [A, B] = compatible.value as [NurbsSurface, NurbsSurface];

  const na = A.points.length;
  const nb = B.points.length;
  const needed = level + 1;
  const keep = held + 1;
  if (A.degreeU < level || needed + keep > na)
    return err(
      modelingError(
        'model-precondition',
        `patch a has ${needed} free control rows (degree >= ${level}) at the edge, besides the ${keep} the opposite side keeps`,
        { level: options.level, rows: na, degree: A.degreeU, opposite },
        'add spans across the edge (nurbs.surface.insertKnot) or raise the degree (nurbs.surface.elevate)',
      ),
    );
  if (modify === 'both' && (B.degreeU < level || needed > nb))
    return err(
      modelingError(
        'model-precondition',
        `patch b has ${needed} control rows (degree >= ${level}) at the edge`,
        { level: options.level, rows: nb, degree: B.degreeU },
        'add spans across the edge or raise the degree of b',
      ),
    );
  const wA = startDerivatives(A.degreeU, A.knotsU, level);
  const wB = startDerivatives(B.degreeU, B.knotsU, Math.min(level, B.degreeU));
  const rowsA = A.points.map((row) => [...row]) as Tuple3[][];
  const rowsB = B.points.map((row) => [...row]) as Tuple3[][];
  const zero = () => (rowsA[0] as Tuple3[]).map((): Tuple3 => [0, 0, 0]);
  const dB = (k: number) => (k < wB.length ? derivative(rowsB, wB[k] as number[]) : zero());
  const oldA = Array.from({ length: needed }, (_, k) => derivative(rowsA, wA[k] as number[]));

  // Position.
  if (!lock) {
    const edge =
      modify === 'a'
        ? dB(0)
        : dB(0).map((p, j) => scale(add(p, (oldA[0] as Tuple3[])[j] as Tuple3), 0.5));
    rowsA[0] = edge.map((p) => [...p] as Tuple3);
    if (modify === 'both') rowsB[0] = edge.map((p) => [...p] as Tuple3);
  }
  // Derivatives: C_a^(k) = alpha_k C_b^(k) + beta_k with scalars mu, eta, zeta fit to a.
  let mu = 1;
  let eta = 0;
  const targets: Tuple3[][] = [];
  for (let k = 1; k <= level; k++) {
    const Db = dB(k);
    const Db1 = dB(1);
    let alpha: number;
    let beta: Tuple3[];
    const goal = oldA[k] as Tuple3[];
    if (k === 1) {
      mu = -leastScalar(zero(), Db1, goal, ends);
      if (!(mu > 0))
        return err(
          modelingError(
            'model-precondition',
            "a's cross-edge tangent points away from b (the patches fold over at the edge)",
            { mu },
            'flip or reorder the patches so they lie on opposite sides of the edge',
          ),
        );
      alpha = -mu;
      beta = zero();
    } else if (k === 2) {
      alpha = mu * mu;
      const base = Db.map((d) => scale(d, alpha));
      eta = leastScalar(base, Db1, goal, ends);
      beta = Db1.map((d) => scale(d, eta));
    } else {
      alpha = -mu * mu * mu;
      const base = Db.map((d, j) =>
        sub(scale(d, alpha), scale((targets[1] as Tuple3[])[j] as Tuple3, (3 * eta) / mu)),
      );
      const zeta = leastScalar(base, Db1, goal, ends);
      beta = base.map((x, j) =>
        sub(add(x, scale(Db1[j] as Tuple3, zeta)), scale(Db[j] as Tuple3, alpha)),
      );
    }
    let target = Db.map((d, j) => add(scale(d, alpha), beta[j] as Tuple3));
    if (modify === 'both') {
      // Split the difference: b's derivative moves toward what a had, a follows the relation.
      const newB = Db.map((d, j) =>
        scale(
          add(d, scale(sub(goal[j] as Tuple3, beta[j] as Tuple3), alpha)),
          1 / (1 + alpha * alpha),
        ),
      );
      target = newB.map((d, j) => add(scale(d, alpha), beta[j] as Tuple3));
      rowsB[k] = rowFrom(rowsB, wB[k] as number[], k, newB);
    }
    targets.push(target);
    rowsA[k] = rowFrom(rowsA, wA[k] as number[], k, target);
  }
  if (influence > 0) {
    const last = level;
    const free = na - keep - 1;
    const reach = influence * (free - last);
    const delta = (rowsA[last] as Tuple3[]).map((p, j) =>
      sub(p, (A.points[last] as readonly Tuple3[])[j] as Tuple3),
    );
    for (let r = last + 1; r <= free; r++) {
      const f = reach > 0 ? Math.max(0, 1 - (r - last) / (reach + 1)) : 0;
      if (f > 0)
        rowsA[r] = (rowsA[r] as Tuple3[]).map((p, j) => add(p, scale(delta[j] as Tuple3, f)));
    }
  }
  let outA: NurbsSurface = { ...A, points: rowsA };
  let outB: NurbsSurface = modify === 'both' ? { ...B, points: rowsB } : B;
  if (reversedB) outB = surfaceReverse(outB, 'v');
  outA = fromFrame(outA, sideA);
  outB = modify === 'both' ? fromFrame(outB, sideB) : b;
  const residual = measureEdge(outA, sideA, outB, sideB, options.samples ?? 32);
  if (!residual.ok) return residual;
  return ok({ a: outA, b: outB, residual: residual.value, rows: lock ? level : level + 1 });
}

/** Clamp the u knots (no shape change) so the edge row is the first control row. */
function clampU(s: NurbsSurface): NurbsSurface {
  return mapLines(s, 'u', s.degreeU, (p, knots, h) => clampH(p, knots, h));
}
