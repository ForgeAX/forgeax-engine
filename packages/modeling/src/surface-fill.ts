import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  basisDerivatives,
  basisFunctions,
  checkCurve,
  checkSurface,
  curvePoint,
  domain,
  findSpan,
  type NurbsCurve,
  type NurbsSurface,
  normalCurvature,
  type SurfaceCurvature,
  solve,
  surfaceCurvature,
  surfaceDerivatives,
} from './nurbs';
import { forEachFairing } from './nurbs-fit';
import type { PatchSide } from './nurbs-surface';
import { type EdgeResidual, measureEdge, measureEdgeTo, sideParameters } from './surface-quality';

/**
 * N-sided hole filling by the midpoint scheme, solved as one plate: the
 * center O sits on the boundary's normal, n quads [O, e(k-1), c(k), e(k)] join the side
 * midpoints e and hole corners c, and all quads are faired together under penalty
 * continuity rows, outer `n . S_cross = 0` and spoke `X_l + X_r = 2 cos(2 pi / n)(1 - t) T`.
 */
export type FillBoundary =
  | {
      readonly surface: NurbsSurface;
      readonly side: PatchSide;
      /** Normalized sub-range of the side (default [0, 1]). */
      readonly range?: readonly [number, number];
    }
  /** A bare curve bounds the fill with G0 only. */
  | { readonly curve: NurbsCurve };

export interface FillOptions {
  /**
   * The hole sides in loop order (3 to 8). A side is one boundary, or an array of
   * consecutive boundaries joined G1 (face isoparm + blend end + face isoparm). A piece may
   * run either way; each must end where the next begins.
   */
  readonly boundaries: readonly (FillBoundary | readonly FillBoundary[])[];
  /** 'G1' (default) everywhere; 'G2' to the neighbours along the outer sides (spokes stay G1). */
  readonly continuity?: 'G0' | 'G1' | 'G2';
  /** Loop closure tolerance, meters (default 1e-6). */
  readonly tolerance?: number;
}

/** Residual of one outer side (against its neighbours) or spoke (between two quads). */
export interface FillResidual extends EdgeResidual {
  readonly edge: 'side' | 'spoke';
  /** Index of the side in `boundaries`; spoke k ends at the midpoint of side k. */
  readonly index: number;
}

export interface FillResult {
  /** One quad per hole corner, normals oriented with the neighbour surfaces. */
  readonly patches: readonly NurbsSurface[];
  readonly residual: readonly FillResidual[];
  /**
   * Largest angle between a quad normal and the boundary-oriented reference (the bilinear
   * blend of the normals at the quad corners), degrees, over a 41 x 41 grid per quad; a fold
   * exceeds 90 and fails with `model-degenerate`.
   */
  readonly normalSpread: number;
}

type Continuity = 'G0' | 'G1' | 'G2';

const DEGREES = 180 / Math.PI;
const PIECE_SAMPLES = 128;
const G1_TARGET = 0.1;
const FAIR = { stretch: 1e-2, bend: 1, rate: 0 };
const PULL = 1e-5;
const PENALTY = 1e6;

const add = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Tuple3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));
const unit = (a: Tuple3): Tuple3 => {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const flat = (a: Tuple3, n: Tuple3): Tuple3 => sub(a, scale(n, dot(a, n)));
const angle = (a: Tuple3, b: Tuple3) => atan2(norm(cross(a, b)), dot(a, b)) * DEGREES;

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

interface Piece {
  readonly boundary: FillBoundary;
  readonly reversed: boolean;
}

/** A boundary point with the neighbour's unit normal and unit cross tangent into the hole. */
interface Sample {
  readonly point: Tuple3;
  readonly curvature?: SurfaceCurvature;
  readonly inward?: Tuple3;
}

function evalPiece(piece: Piece, t: number): Sample {
  const x = piece.reversed ? 1 - t : t;
  const b = piece.boundary;
  if ('curve' in b) {
    const [t0, t1] = domain(b.curve);
    return { point: curvePoint(b.curve, t0 + (t1 - t0) * x) };
  }
  const [a0, a1] = b.range ?? [0, 1];
  const [u, v] = sideParameters(b.surface, b.side, a0 + (a1 - a0) * x);
  const c = surfaceCurvature(b.surface, u, v);
  if (c === undefined) {
    const point = (surfaceDerivatives(b.surface, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
    return { point };
  }
  const along = b.side === 'u0' || b.side === 'u1' ? c.sv : c.su;
  const toward =
    b.side === 'u0'
      ? c.su
      : b.side === 'u1'
        ? scale(c.su, -1)
        : b.side === 'v0'
          ? c.sv
          : scale(c.sv, -1);
  const T = unit(along);
  return { point: c.point, curvature: c, inward: scale(unit(flat(toward, T)), -1) };
}

/**
 * One hole side: consecutive pieces under one parameter from 0 to 1, affine in each
 * piece's own parameter (so a polynomial piece stays exact) with the piece intervals sized
 * so the speed is continuous at the joins.
 */
interface Side {
  readonly pieces: readonly Piece[];
  /** Parameter where each piece starts, plus 1. */
  readonly starts: readonly number[];
  /** Parameter of the arc-length midpoint. */
  readonly mid: number;
  readonly points: readonly Tuple3[];
  readonly length: number;
  /** Original index in `boundaries`. */
  readonly index: number;
  readonly bare: boolean;
}

function makeSide(pieces: readonly Piece[], index: number): Side {
  const step = 1e-4;
  const speed = (piece: Piece, t: number) =>
    norm(sub(evalPiece(piece, t + step).point, evalPiece(piece, t).point)) / step;
  const spans = [1];
  for (let j = 1; j < pieces.length; j++) {
    const before = speed(pieces[j - 1] as Piece, 1 - step);
    const after = speed(pieces[j] as Piece, 0);
    const ratio = before > 0 && after > 0 ? after / before : 1;
    spans.push((spans[j - 1] as number) * Math.min(1e3, Math.max(1e-3, ratio)));
  }
  const total = spans.reduce((a, b) => a + b, 0);
  const starts = [0];
  for (const span of spans) starts.push((starts[starts.length - 1] as number) + span / total);
  starts[pieces.length] = 1;
  const table: { s: number; g: number }[] = [];
  const points: Tuple3[] = [];
  let s = 0;
  for (const [j, piece] of pieces.entries())
    for (let i = 0; i <= PIECE_SAMPLES; i++) {
      const t = i / PIECE_SAMPLES;
      const p = evalPiece(piece, t).point;
      if (points.length > 0) s += norm(sub(p, points[points.length - 1] as Tuple3));
      const g0 = starts[j] as number;
      table.push({ s, g: g0 + ((starts[j + 1] as number) - g0) * t });
      points.push(p);
    }
  let k = 1;
  while (k < table.length - 1 && (table[k] as { s: number }).s < s / 2) k++;
  const a = table[k - 1] as { s: number; g: number };
  const b = table[k] as { s: number; g: number };
  const mid = b.s > a.s ? a.g + ((b.g - a.g) * (s / 2 - a.s)) / (b.s - a.s) : a.g;
  return {
    pieces,
    starts,
    mid,
    points,
    length: s,
    index,
    bare: pieces.some((p) => 'curve' in p.boundary),
  };
}

function sideAt(side: Side, g: number): Sample {
  const x = Math.min(1, Math.max(0, g));
  let j = 0;
  while (j < side.pieces.length - 1 && x > (side.starts[j + 1] as number)) j++;
  const g0 = side.starts[j] as number;
  const g1 = side.starts[j + 1] as number;
  return evalPiece(side.pieces[j] as Piece, Math.min(1, Math.max(0, (x - g0) / (g1 - g0))));
}

function reverseSide(side: Side): Side {
  return makeSide(
    [...side.pieces].reverse().map((p) => ({ boundary: p.boundary, reversed: !p.reversed })),
    side.index,
  );
}

/** Least-squares control row of `f` over the knots, interpolating both ends. */
function fitRow(
  f: (t: number) => Tuple3,
  K: readonly number[],
  p: number,
): Result<Tuple3[], ModelingError> {
  const n = K.length - p - 1;
  const first = f(0);
  const last = f(1);
  const free = n - 2;
  const A = new Float64Array(free * free);
  const B = new Float64Array(free * 3);
  const params: number[] = [];
  for (let k = p; k < n; k++) {
    const a = K[k] as number;
    const b = K[k + 1] as number;
    if (b > a) for (let q = 0; q <= p + 2; q++) params.push(a + ((b - a) * q) / (p + 2));
  }
  for (const t of params) {
    const span = findSpan(n, p, t, K);
    const N = basisFunctions(span, t, p, K);
    const Q = f(t);
    const rhs: Tuple3 = [Q[0], Q[1], Q[2]];
    for (let r = 0; r <= p; r++) {
      const i = span - p + r;
      const w = N[r] as number;
      if (i === 0)
        for (let c = 0; c < 3; c++) rhs[c] = (rhs[c] as number) - w * (first[c] as number);
      if (i === n - 1)
        for (let c = 0; c < 3; c++) rhs[c] = (rhs[c] as number) - w * (last[c] as number);
    }
    for (let r = 0; r <= p; r++) {
      const i = span - p + r - 1;
      if (i < 0 || i >= free) continue;
      const wi = N[r] as number;
      for (let c = 0; c < 3; c++) B[3 * i + c] = (B[3 * i + c] as number) + wi * (rhs[c] as number);
      for (let r2 = 0; r2 <= p; r2++) {
        const j = span - p + r2 - 1;
        if (j >= 0 && j < free)
          A[i * free + j] = (A[i * free + j] as number) + wi * (N[r2] as number);
      }
    }
  }
  const x = solve(A, B, free, 3);
  if (!x.ok) return x;
  const row: Tuple3[] = [first];
  for (let i = 0; i < free; i++)
    row.push([
      x.value[3 * i] as number,
      x.value[3 * i + 1] as number,
      x.value[3 * i + 2] as number,
    ]);
  row.push(last);
  return ok(row);
}

/** Order the pieces into a closed loop, reversing a piece whose far end meets its neighbour. */
function orient(
  sides: readonly (readonly FillBoundary[])[],
  tolerance: number,
): Result<Piece[][], ModelingError> {
  const flatList = sides.flatMap((s, side) => s.map((b, piece) => ({ b, side, piece })));
  const ends = flatList.map(({ b }) => {
    const p = { boundary: b, reversed: false };
    return [evalPiece(p, 0).point, evalPiece(p, 1).point] as const;
  });
  const near = (a: Tuple3, b: Tuple3) => norm(sub(a, b)) <= tolerance;
  const [s0, e0] = ends[0] as readonly [Tuple3, Tuple3];
  const [s1, e1] = ends[1] as readonly [Tuple3, Tuple3];
  const firstReversed = !(near(e0, s1) || near(e0, e1)) && (near(s0, s1) || near(s0, e1));
  const reversed = [firstReversed];
  let tail = firstReversed ? s0 : e0;
  for (let k = 1; k < flatList.length; k++) {
    const [s, e] = ends[k] as readonly [Tuple3, Tuple3];
    if (near(s, tail)) {
      reversed.push(false);
      tail = e;
    } else if (near(e, tail)) {
      reversed.push(true);
      tail = s;
    } else {
      const at = flatList[k] as { side: number; piece: number };
      return err(
        modelingError(
          'model-precondition',
          'each boundary piece starts where the previous one ends',
          {
            side: at.side,
            piece: at.piece,
            gap: Math.min(norm(sub(s, tail)), norm(sub(e, tail))),
            tolerance,
          },
          'list the boundaries in loop order around the hole, or raise tolerance',
        ),
      );
    }
  }
  const head = firstReversed ? e0 : s0;
  if (!near(tail, head))
    return err(
      modelingError(
        'model-precondition',
        'the boundary loop closes',
        { gap: norm(sub(tail, head)), tolerance },
        'the last boundary piece must end where the first one begins',
      ),
    );
  let k = 0;
  return ok(
    sides.map((s) => s.map((boundary) => ({ boundary, reversed: reversed[k++] as boolean }))),
  );
}

function checkBoundary(b: FillBoundary, side: number): Result<null, ModelingError> {
  if (b === null || typeof b !== 'object')
    return err(invalid('a boundary is { surface, side, range? } or { curve }', { side }));
  if ('curve' in b) {
    const c = checkCurve(b.curve);
    return c.ok ? ok(null) : c;
  }
  const s = checkSurface(b.surface);
  if (!s.ok) return s;
  if (!['u0', 'u1', 'v0', 'v1'].includes(b.side))
    return err(invalid("a boundary side is 'u0', 'u1', 'v0' or 'v1'", { side, value: b.side }));
  if (b.range !== undefined) {
    const [a0, a1] = b.range;
    if (!(Number.isFinite(a0) && Number.isFinite(a1) && a0 >= 0 && a1 <= 1 && a0 < a1))
      return err(invalid('range is [a, b] with 0 <= a < b <= 1', { side, range: b.range }));
  }
  return ok(null);
}

/** Linear combination of control points: point id (and coordinate) times weight. */
type Terms = { id: number; w: number }[];

interface Net {
  readonly n: number;
  readonly p: number;
  /** Knots along spoke k: quad k runs along spoke k-1 in u and along spoke k in v. */
  readonly knots: readonly (readonly number[])[];
  /** First id of each spoke row (after the center) and of each quad's own points. */
  readonly spokeBase: readonly number[];
  readonly quadBase: readonly number[];
  readonly values: Tuple3[];
  readonly fixed: boolean[];
}

const wrap = (net: Net, k: number) => ((k % net.n) + net.n) % net.n;
const knotsU = (net: Net, k: number) => net.knots[wrap(net, k - 1)] as readonly number[];
const knotsV = (net: Net, k: number) => net.knots[wrap(net, k)] as readonly number[];
const countOf = (net: Net, K: readonly number[]) => K.length - net.p - 1;

/** Point id of quad k's control point (i, j); quads share the center and their spoke rows. */
function pointOf(net: Net, k: number, i: number, j: number): number {
  const kk = wrap(net, k);
  if (i === 0 && j === 0) return 0;
  if (i === 0) return (net.spokeBase[kk] as number) + j - 1;
  if (j === 0) return (net.spokeBase[wrap(net, kk - 1)] as number) + i - 1;
  const nv = countOf(net, knotsV(net, kk));
  return (net.quadBase[kk] as number) + (i - 1) * (nv - 1) + (j - 1);
}

function terms(net: Net, k: number, u: number, v: number, du: number, dv: number): Terms {
  const { p } = net;
  const U = knotsU(net, k);
  const V = knotsV(net, k);
  const su = findSpan(countOf(net, U), p, u, U);
  const sv = findSpan(countOf(net, V), p, v, V);
  const Nu = basisDerivatives(su, u, p, du, U)[du] as number[];
  const Nv = basisDerivatives(sv, v, p, dv, V)[dv] as number[];
  const out: Terms = [];
  for (let r = 0; r <= p; r++)
    for (let c = 0; c <= p; c++) {
      const w = (Nu[r] as number) * (Nv[c] as number);
      if (w !== 0) out.push({ id: pointOf(net, k, su - p + r, sv - p + c), w });
    }
  return out;
}

function combine(net: Net, t: Terms): Tuple3 {
  let acc: Tuple3 = [0, 0, 0];
  for (const { id, w } of t) acc = add(acc, scale(net.values[id] as Tuple3, w));
  return acc;
}

function quad(net: Net, k: number): NurbsSurface {
  const U = knotsU(net, k);
  const V = knotsV(net, k);
  const points = Array.from({ length: countOf(net, U) }, (_, i) =>
    Array.from({ length: countOf(net, V) }, (__, j) => net.values[pointOf(net, k, i, j)] as Tuple3),
  );
  return { degreeU: net.p, degreeV: net.p, points, knotsU: [...U], knotsV: [...V] };
}

/** Collocation parameters along a row: 2 (p + 1) per non-empty span, interior. */
function collocation(K: readonly number[], p: number): number[] {
  const out: number[] = [];
  const count = 2 * (p + 1);
  for (let k = p; k < K.length - p - 1; k++) {
    const a = K[k] as number;
    const b = K[k + 1] as number;
    if (b > a) for (let q = 0; q < count; q++) out.push(a + ((b - a) * (q + 0.5)) / count);
  }
  return out;
}

interface Hole {
  readonly sides: readonly Side[];
  readonly center: Tuple3;
  readonly spokes: readonly Tuple3[];
  readonly spokeLength: number;
  readonly mids: readonly Tuple3[];
}

/** Outer side samples of quad k: side u = 1 runs along S(k-1), side v = 1 along S(k). */
function outerSample(hole: Hole, k: number, onU: boolean, t: number): Sample {
  const n = hole.sides.length;
  const before = hole.sides[(k - 1 + n) % n] as Side;
  const after = hole.sides[k % n] as Side;
  return onU
    ? sideAt(before, before.mid + (1 - before.mid) * t)
    : sideAt(after, after.mid * (1 - t));
}

/**
 * Knots of spoke k: `m` uniform spans plus, at multiplicity p - 1 (C1), the piece joins of
 * the two half sides it parametrizes, the second half of S(k-1) (quad k, side u1) and the
 * first half of S(k+1) (quad k+1, side v1), so polynomial pieces stay exact.
 */
function spokeKnots(hole: Hole, k: number, m: number, p: number): number[] {
  const n = hole.sides.length;
  const before = hole.sides[(k - 1 + n) % n] as Side;
  const after = hole.sides[(k + 1) % n] as Side;
  const breaks: number[] = [];
  for (const g of before.starts.slice(1, -1))
    if (g > before.mid) breaks.push((g - before.mid) / (1 - before.mid));
  for (const g of after.starts.slice(1, -1)) if (g < after.mid) breaks.push(1 - g / after.mid);
  const joins = [...new Set(breaks)]
    .filter((t) => t > 1e-6 && t < 1 - 1e-6)
    .sort((a, b) => a - b)
    .filter((t, i, list) => i === 0 || t - (list[i - 1] as number) > 1e-6);
  const interior = Array.from({ length: m - 1 }, (_, j) => (j + 1) / m).filter((t) =>
    joins.every((b) => Math.abs(t - b) > 0.3 / m),
  );
  const knots = new Array<number>(p + 1).fill(0);
  for (const t of [...interior, ...joins.flatMap((b) => new Array<number>(p - 1).fill(b))].sort(
    (a, b) => a - b,
  ))
    knots.push(t);
  for (let j = 0; j <= p; j++) knots.push(1);
  return knots;
}

function greville(K: readonly number[], p: number): number[] {
  return Array.from({ length: K.length - p - 1 }, (_, i) => {
    let s = 0;
    for (let r = 1; r <= p; r++) s += K[i + r] as number;
    return s / p;
  });
}

function buildNet(hole: Hole, m: number, p: number): Result<Net, ModelingError> {
  const n = hole.sides.length;
  const knots = Array.from({ length: n }, (_, k) => spokeKnots(hole, k, m, p));
  const sizes = knots.map((K) => K.length - p - 1);
  const spokeBase: number[] = [];
  let next = 1;
  for (const size of sizes) {
    spokeBase.push(next);
    next += size - 1;
  }
  const quadBase: number[] = [];
  for (let k = 0; k < n; k++) {
    quadBase.push(next);
    next += ((sizes[(k - 1 + n) % n] as number) - 1) * ((sizes[k] as number) - 1);
  }
  const values: Tuple3[] = new Array<Tuple3>(next).fill([0, 0, 0]);
  const fixed = new Array<boolean>(next).fill(false);
  const net: Net = { n, p, knots, spokeBase, quadBase, values, fixed };
  const O = hole.center;
  const spokeRows: Tuple3[][] = [];
  for (let k = 0; k < n; k++) {
    const K = knots[k] as number[];
    const size = sizes[k] as number;
    const e = hole.mids[k] as Tuple3;
    const d = sideAt(hole.sides[k] as Side, (hole.sides[k] as Side).mid).inward;
    const L = norm(sub(e, O));
    const m0 = scale(hole.spokes[k] as Tuple3, hole.spokeLength);
    const m1 = d === undefined ? scale(unit(sub(e, O)), L) : scale(d, -L);
    const row = fitRow(
      (t) => {
        const t2 = t * t;
        const t3 = t2 * t;
        return add(
          add(scale(O, 2 * t3 - 3 * t2 + 1), scale(m0, t3 - 2 * t2 + t)),
          add(scale(e, -2 * t3 + 3 * t2), scale(m1, t3 - t2)),
        );
      },
      K,
      p,
    );
    if (!row.ok) return row;
    row.value[0] = O;
    row.value[1] = add(
      O,
      scale(hole.spokes[k] as Tuple3, (hole.spokeLength * (K[p + 1] as number)) / p),
    );
    row.value[size - 1] = e;
    spokeRows.push(row.value);
  }
  const rowsU: Tuple3[][] = [];
  const rowsV: Tuple3[][] = [];
  for (let k = 0; k < n; k++) {
    const u = fitRow((t) => outerSample(hole, k, true, t).point, knotsV(net, k), p);
    if (!u.ok) return u;
    const v = fitRow((t) => outerSample(hole, k, false, t).point, knotsU(net, k), p);
    if (!v.ok) return v;
    const corner = scale(
      add(u.value[u.value.length - 1] as Tuple3, v.value[v.value.length - 1] as Tuple3),
      0.5,
    );
    u.value[u.value.length - 1] = corner;
    v.value[v.value.length - 1] = corner;
    rowsU.push(u.value);
    rowsV.push(v.value);
  }
  values[0] = O;
  fixed[0] = true;
  for (let k = 0; k < n; k++) {
    const size = sizes[k] as number;
    for (let j = 1; j < size; j++) {
      const id = pointOf(net, k, 0, j);
      values[id] = (spokeRows[k] as Tuple3[])[j] as Tuple3;
      fixed[id] = j === 1 || j === size - 1;
    }
  }
  for (let k = 0; k < n; k++) {
    const gu = greville(knotsU(net, k), p);
    const gv = greville(knotsV(net, k), p);
    const nu = gu.length;
    const nv = gv.length;
    const left = spokeRows[k] as Tuple3[];
    const bottom = spokeRows[(k - 1 + n) % n] as Tuple3[];
    const right = rowsU[k] as Tuple3[];
    const top = rowsV[k] as Tuple3[];
    const c10 = bottom[nu - 1] as Tuple3;
    const c01 = left[nv - 1] as Tuple3;
    const c11 = right[nv - 1] as Tuple3;
    for (let i = 1; i < nu; i++)
      for (let j = 1; j < nv; j++) {
        const id = pointOf(net, k, i, j);
        if (i === nu - 1 || j === nv - 1) {
          values[id] = (i === nu - 1 ? right[j] : top[i]) as Tuple3;
          fixed[id] = true;
          continue;
        }
        const a = gu[i] as number;
        const b = gv[j] as number;
        values[id] = sub(
          add(
            add(scale(left[j] as Tuple3, 1 - a), scale(right[j] as Tuple3, a)),
            add(scale(bottom[i] as Tuple3, 1 - b), scale(top[i] as Tuple3, b)),
          ),
          add(
            add(scale(O, (1 - a) * (1 - b)), scale(c10, a * (1 - b))),
            add(scale(c01, (1 - a) * b), scale(c11, a * b)),
          ),
        );
      }
  }
  return ok(net);
}

/** One penalty row: coefficients on (point id, coordinate) and its right-hand side. */
interface Row {
  readonly terms: readonly { readonly id: number; readonly c: number; readonly w: number }[];
  readonly rhs: number;
}

/**
 * Minimize the shared fairing energy of all quads plus a weak pull toward `target` and
 * the penalty rows, over the free control points (xyz coupled by the rows).
 */
function solvePlate(
  net: Net,
  target: readonly Tuple3[],
  rows: readonly Row[],
): Result<null, ModelingError> {
  // Solve relative to the center: the penalty scale amplifies rounding of large coordinates.
  const origin = net.values[0] as Tuple3;
  const local = (p: Tuple3): Tuple3 => sub(p, origin);
  const index = new Int32Array(net.values.length).fill(-1);
  let free = 0;
  for (const [id, f] of net.fixed.entries()) if (!f) index[id] = free++;
  const size = 3 * free;
  const A = new Float64Array(size * size);
  const B = new Float64Array(size);
  for (let k = 0; k < net.n; k++) {
    const s = countOf(net, knotsV(net, k));
    forEachFairing(net.p, knotsU(net, k), net.p, knotsV(net, k), FAIR, (ki, kj, g) => {
      const fi = index[pointOf(net, k, Math.floor(ki / s), ki % s)] as number;
      if (fi < 0) return;
      const idJ = pointOf(net, k, Math.floor(kj / s), kj % s);
      const fj = index[idJ] as number;
      for (let c = 0; c < 3; c++) {
        const r = 3 * fi + c;
        if (fj >= 0) A[r * size + 3 * fj + c] = (A[r * size + 3 * fj + c] as number) + g;
        else B[r] = (B[r] as number) - g * (local(net.values[idJ] as Tuple3)[c] as number);
      }
    });
  }
  let diagonal = 0;
  for (let r = 0; r < size; r++) diagonal += A[r * size + r] as number;
  diagonal = size > 0 ? diagonal / size : 1;
  for (const [id, f] of index.entries()) {
    if (f < 0) continue;
    for (let c = 0; c < 3; c++) {
      const r = 3 * f + c;
      A[r * size + r] = (A[r * size + r] as number) + PULL * diagonal;
      B[r] = (B[r] as number) + PULL * diagonal * (local(target[id] as Tuple3)[c] as number);
    }
  }
  const weight = PENALTY * diagonal;
  const vars: number[] = [];
  const coefs: number[] = [];
  for (const row of rows) {
    vars.length = 0;
    coefs.length = 0;
    let rhs = row.rhs;
    let length = 0;
    for (const { id, c, w } of row.terms) {
      length += w * w;
      const f = index[id] as number;
      if (f < 0) rhs -= w * (local(net.values[id] as Tuple3)[c] as number);
      else {
        vars.push(3 * f + c);
        coefs.push(w);
      }
    }
    if (vars.length === 0 || !(length > 0)) continue;
    const wr = weight / length;
    for (const [a, va] of vars.entries()) {
      const ca = (coefs[a] as number) * wr;
      B[va] = (B[va] as number) + ca * rhs;
      for (const [b, vb] of vars.entries())
        A[va * size + vb] = (A[va * size + vb] as number) + ca * (coefs[b] as number);
    }
  }
  // Symmetric diagonal scaling keeps the penalty rows from swamping the pivots.
  const d = new Float64Array(size);
  for (let r = 0; r < size; r++) d[r] = 1 / Math.sqrt(A[r * size + r] as number);
  for (let r = 0; r < size; r++) {
    B[r] = (B[r] as number) * (d[r] as number);
    for (let c = 0; c < size; c++)
      A[r * size + c] = (A[r * size + c] as number) * (d[r] as number) * (d[c] as number);
  }
  const y = solve(A, B, size, 1);
  if (!y.ok) return y;
  const x = (r: number) => (y.value[r] as number) * (d[r] as number);
  for (const [id, f] of index.entries())
    if (f >= 0) net.values[id] = add(origin, [x(3 * f), x(3 * f + 1), x(3 * f + 2)]);
  return ok(null);
}

function normalRow(t: Terms, n: Tuple3, rhs: number): Row {
  return {
    terms: t.flatMap(({ id, w }) => [0, 1, 2].map((c) => ({ id, c, w: w * (n[c] as number) }))),
    rhs,
  };
}

/** Continuity rows: outer G1 (and G2 from the current net), spoke G1 when `spokes`. */
function plateRows(
  hole: Hole,
  net: Net,
  continuity: Continuity,
  spokes: boolean,
  g2: boolean,
): Row[] {
  const rows: Row[] = [];
  if (continuity === 'G0') return rows;
  const n = net.n;
  for (let k = 0; k < n; k++)
    for (const onU of [true, false])
      for (const t of collocation(onU ? knotsV(net, k) : knotsU(net, k), net.p)) {
        const sample = outerSample(hole, k, onU, t);
        const c = sample.curvature;
        if (c === undefined) continue;
        const [u, v] = onU ? [1, t] : [t, 1];
        const [du, dv] = onU ? [1, 0] : [0, 1];
        rows.push(normalRow(terms(net, k, u, v, du, dv), c.normal, 0));
        if (!g2) continue;
        const X = combine(net, terms(net, k, u, v, du, dv));
        const X2 = dot(X, X) - dot(X, c.normal) * dot(X, c.normal);
        rows.push(
          normalRow(terms(net, k, u, v, 2 * du, 2 * dv), c.normal, normalCurvature(c, X) * X2),
        );
      }
  if (!spokes) return rows;
  const factor = 2 * cos((2 * Math.PI) / n);
  for (let k = 0; k < n; k++) {
    // The half sides may leave e(k) at different speeds: weight X_l by mu(t), 1 at O.
    const a = norm(combine(net, terms(net, k, 0, 1, 1, 0)));
    const b = norm(combine(net, terms(net, k + 1, 1, 0, 0, 1)));
    const end = a > 0 && b > 0 ? b / a : 1;
    for (const t of collocation(knotsV(net, k), net.p)) {
      const h = factor * (1 - t);
      const mu = 1 + (end - 1) * t;
      const left = terms(net, k, 0, t, 1, 0);
      const right = terms(net, k + 1, t, 0, 0, 1);
      const along = terms(net, k, 0, t, 0, 1);
      for (let c = 0; c < 3; c++)
        rows.push({
          terms: [
            ...left.map(({ id, w }) => ({ id, c, w: mu * w })),
            ...right.map(({ id, w }) => ({ id, c, w })),
            ...along.map(({ id, w }) => ({ id, c, w: -h * w })),
          ],
          rhs: 0,
        });
    }
  }
  return rows;
}

function maxResidual(a: EdgeResidual, b: EdgeResidual): EdgeResidual {
  return {
    gap: Math.max(a.gap, b.gap),
    angle: Math.max(a.angle, b.angle),
    curvature: Math.max(a.curvature, b.curvature),
    curvatureRatio: Math.max(a.curvatureRatio, b.curvatureRatio),
    rate: Math.max(a.rate, b.rate),
    rateRatio: Math.max(a.rateRatio, b.rateRatio),
    samples: a.samples + b.samples,
  };
}

/** Gap of a quad side to a bare-curve hole side (no ribbon to compare with). */
function gapTo(q: NurbsSurface, side: PatchSide, polyline: readonly Tuple3[]): EdgeResidual {
  let gap = 0;
  const samples = 32;
  for (let k = 0; k < samples; k++) {
    const [u, v] = sideParameters(q, side, (k + 0.5) / samples);
    const p = (surfaceDerivatives(q, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
    let best = Infinity;
    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1] as Tuple3;
      const ab = sub(polyline[i] as Tuple3, a);
      const l2 = dot(ab, ab);
      const f = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
      best = Math.min(best, norm(sub(p, add(a, scale(ab, f)))));
    }
    gap = Math.max(gap, best);
  }
  return { gap, angle: 0, curvature: 0, curvatureRatio: 0, rate: 0, rateRatio: 0, samples };
}

function measure(
  hole: Hole,
  patches: readonly NurbsSurface[],
): Result<{ residual: FillResidual[]; worst: number }, ModelingError> {
  const n = patches.length;
  const residual: FillResidual[] = [];
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const side = hole.sides[i] as Side;
    const a = patches[i] as NurbsSurface;
    const b = patches[(i + 1) % n] as NurbsSurface;
    let r: EdgeResidual;
    if (side.bare) r = maxResidual(gapTo(a, 'v1', side.points), gapTo(b, 'u1', side.points));
    else {
      const targets = side.pieces.map((p) => {
        const s = p.boundary as { surface: NurbsSurface; side: PatchSide };
        return { surface: s.surface, side: s.side };
      });
      const ra = measureEdgeTo(a, 'v1', targets);
      if (!ra.ok) return ra;
      const rb = measureEdgeTo(b, 'u1', targets);
      if (!rb.ok) return rb;
      r = maxResidual(ra.value, rb.value);
    }
    worst = Math.max(worst, r.angle);
    residual.push({ ...r, edge: 'side', index: side.index });
  }
  for (let k = 0; k < n; k++) {
    const r = measureEdge(
      patches[k] as NurbsSurface,
      'u0',
      patches[(k + 1) % n] as NurbsSurface,
      'v0',
    );
    if (!r.ok) return r;
    worst = Math.max(worst, r.value.angle);
    residual.push({ ...r.value, edge: 'spoke', index: (hole.sides[k] as Side).index });
  }
  return ok({ residual, worst });
}

/** Loop tangent of a side at `g` (the direction the loop runs). */
function loopTangent(side: Side, g: number): Tuple3 {
  const h = 1e-4;
  const a = Math.max(0, g - h);
  const b = Math.min(1, g + h);
  return unit(sub(sideAt(side, b).point, sideAt(side, a).point));
}

/**
 * Boundary-oriented reference normal at `g` of a side: the neighbour's tangent plane
 * oriented by the loop, cross(loop tangent, into the hole), whatever the neighbour's sign.
 */
function boundaryNormal(side: Side, g: number): Tuple3 | undefined {
  const s = sideAt(side, g);
  if (s.curvature === undefined || s.inward === undefined) return undefined;
  const r = unit(cross(loopTangent(side, g), s.inward));
  return norm(r) > 0 ? r : undefined;
}

/** Worst sample of the quad orientation against the boundary-oriented reference. */
interface Orientation {
  readonly angle: number;
  readonly quad: number;
  readonly u: number;
  readonly v: number;
  readonly point: Tuple3;
}

const ORIENT_GRID = 40;

/**
 * Orientation of every quad over a dense grid: the normal against the bilinear blend of
 * the reference normals at its corners [O, e(k-1), c(k), e(k)]. A fold (Jacobian sign change)
 * turns some sample more than 90 degrees from it; the corners alone cannot show one.
 */
function orientation(hole: Hole, patches: readonly NurbsSurface[]): Orientation {
  const n = patches.length;
  const sides = hole.sides;
  const mids = sides.map((s) => boundaryNormal(s, s.mid));
  let up = mids.reduce<Tuple3>((acc, r) => (r === undefined ? acc : add(acc, r)), [0, 0, 0]);
  if (!(norm(up) > 0)) {
    const d = surfaceDerivatives(patches[0] as NurbsSurface, 0, 0, 1);
    up = cross((d[1] as Tuple3[])[0] as Tuple3, (d[0] as Tuple3[])[1] as Tuple3);
  }
  const center = unit(up);
  const corners = sides.map((s) => boundaryNormal(s, 0));
  const samples: { k: number; u: number; v: number; point: Tuple3; n: Tuple3; ref: Tuple3 }[] = [];
  let sign = 0;
  for (let k = 0; k < n; k++) {
    const q = patches[k] as NurbsSurface;
    const r00 = center;
    const r10 = mids[(k - 1 + n) % n] ?? center;
    const r11 = corners[k] ?? center;
    const r01 = mids[k] ?? center;
    for (let i = 0; i <= ORIENT_GRID; i++)
      for (let j = 0; j <= ORIENT_GRID; j++) {
        const u = i / ORIENT_GRID;
        const v = j / ORIENT_GRID;
        const d = surfaceDerivatives(q, u, v, 1);
        const normal = unit(
          cross((d[1] as Tuple3[])[0] as Tuple3, (d[0] as Tuple3[])[1] as Tuple3),
        );
        if (!(norm(normal) > 0)) continue;
        const ref = add(
          add(scale(r00, (1 - u) * (1 - v)), scale(r10, u * (1 - v))),
          add(scale(r11, u * v), scale(r01, (1 - u) * v)),
        );
        sign += dot(normal, ref);
        samples.push({ k, u, v, point: (d[0] as Tuple3[])[0] as Tuple3, n: normal, ref });
      }
  }
  const s = sign < 0 ? -1 : 1;
  let worst: Orientation = { angle: 0, quad: 0, u: 0, v: 0, point: hole.center };
  for (const x of samples) {
    const a = angle(scale(x.n, s), x.ref);
    if (a > worst.angle) worst = { angle: a, quad: x.k, u: x.u, v: x.v, point: x.point };
  }
  return worst;
}

/** Angle between the two neighbours' reference normals at each hole corner c(k), degrees. */
function cornerMismatch(hole: Hole): number[] {
  const n = hole.sides.length;
  return hole.sides.map((s, k) => {
    const a = boundaryNormal(hole.sides[(k - 1 + n) % n] as Side, 1);
    const b = boundaryNormal(s, 0);
    return a === undefined || b === undefined ? 0 : angle(a, b);
  });
}

/** The center, its tangent plane and the equiangular spoke directions (research section 2). */
function makeHole(sides: readonly Side[]): Result<Hole, ModelingError> {
  const n = sides.length;
  let newell: Tuple3 = [0, 0, 0];
  const loop = sides.flatMap((s) => s.points);
  for (const [i, a] of loop.entries())
    newell = add(newell, cross(a, loop[(i + 1) % loop.length] as Tuple3));
  const perimeter = sides.reduce((s, side) => s + side.length, 0);
  if (!(norm(newell) > 1e-9 * perimeter * perimeter))
    return err(
      modelingError(
        'model-degenerate',
        'the boundary loop encloses an area',
        { area: norm(newell) / 2 },
        'the hole sides must not fold back onto each other',
      ),
    );
  const N = unit(newell);
  const mids = sides.map((s) => sideAt(s, s.mid).point);
  const G = scale(mids.reduce(add, [0, 0, 0] as Tuple3), 1 / n);
  // Each spoke as a circular arc from e with the ribbon tangent d to a point whose tangent
  // is level (perpendicular to N): its rise is (d . N) |D| / |d_flat + D/|D||.
  let lambda = 0;
  for (const [i, e] of mids.entries()) {
    const d = sideAt(sides[i] as Side, (sides[i] as Side).mid).inward;
    const D = flat(sub(G, e), N);
    const rise = (() => {
      if (d === undefined || !(norm(D) > 0)) return 0;
      const den = norm(add(flat(d, N), unit(D)));
      return den > 1e-9 ? (dot(d, N) * norm(D)) / den : 0;
    })();
    lambda += rise + dot(sub(e, G), N);
  }
  const center = add(G, scale(N, lambda / n));
  const r0 = flat(sub(mids[0] as Tuple3, center), N);
  const e1 = norm(r0) > 0 ? unit(r0) : unit(flat(Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], N));
  const e2 = cross(N, e1);
  let sx = 0;
  let sy = 0;
  for (const [k, e] of mids.entries()) {
    const r = sub(e, center);
    const a = atan2(dot(r, e2), dot(r, e1)) - (2 * Math.PI * k) / n;
    sx += cos(a);
    sy += sin(a);
  }
  const phi = atan2(sy, sx);
  const spokes = Array.from({ length: n }, (_, k): Tuple3 => {
    const a = phi + (2 * Math.PI * k) / n;
    return add(scale(e1, cos(a)), scale(e2, sin(a)));
  });
  const spokeLength = mids.reduce((s, e) => s + norm(sub(e, center)), 0) / n;
  return ok({ sides, center, spokes, spokeLength, mids });
}

/**
 * @internal `fillN` with the spoke continuity rows optional: without them the quads only
 * share spoke positions (the falsifier of the simultaneous solve), and their G1 budget is not gated.
 */
export function fillQuads(
  options: FillOptions,
  spokes: boolean,
): Result<FillResult, ModelingError> {
  if (options === null || typeof options !== 'object' || !Array.isArray(options.boundaries))
    return err(invalid('options.boundaries lists the hole sides', {}));
  const given = options.boundaries.map((b) =>
    Array.isArray(b) ? (b as readonly FillBoundary[]) : [b as FillBoundary],
  );
  const n = given.length;
  if (n < 3 || n > 8) return err(invalid('a fill has 3 to 8 sides', { sides: n }));
  for (const [i, side] of given.entries()) {
    if (side.length === 0) return err(invalid('a side holds at least one boundary', { side: i }));
    for (const b of side) {
      const c = checkBoundary(b, i);
      if (!c.ok) return c;
    }
  }
  const continuity = options.continuity ?? 'G1';
  if (!['G0', 'G1', 'G2'].includes(continuity))
    return err(invalid("continuity is 'G0', 'G1' or 'G2'", { continuity }));
  const tolerance = options.tolerance ?? 1e-6;
  if (!(Number.isFinite(tolerance) && tolerance > 0))
    return err(invalid('tolerance is a positive number of meters', { tolerance }));
  const oriented = orient(given, tolerance);
  if (!oriented.ok) return oriented;
  let sides = oriented.value.map((pieces, i) => makeSide(pieces, i));
  for (const s of sides)
    if (!(s.length > tolerance))
      return err(
        modelingError(
          'model-degenerate',
          'every hole side has a length above tolerance',
          { side: s.index, length: s.length, tolerance },
          'merge a zero-length side into its neighbour',
        ),
      );
  // Orient the loop so the quads face the way the neighbour surfaces do.
  let vote = 0;
  for (const s of sides)
    for (let q = 1; q < 16; q++) {
      const a = sideAt(s, (q - 0.5) / 16);
      const b = sideAt(s, (q + 0.5) / 16);
      const m = sideAt(s, q / 16);
      if (m.curvature !== undefined && m.inward !== undefined)
        vote += dot(m.curvature.normal, cross(sub(b.point, a.point), m.inward));
    }
  if (vote < 0) sides = [...sides].reverse().map(reverseSide);
  const hole = makeHole(sides);
  if (!hole.ok) return hole;
  const p = continuity === 'G2' ? 5 : 3;
  const spans = continuity === 'G0' ? [2] : [2, 3, 4, 6];
  let best: FillResult | undefined;
  let fold: Orientation | undefined;
  let worst = 0;
  for (const m of spans) {
    const built = buildNet(hole.value, m, p);
    if (!built.ok) return built;
    const net = built.value;
    const coons = [...net.values];
    const first = solvePlate(net, coons, plateRows(hole.value, net, continuity, spokes, false));
    if (!first.ok) return first;
    if (continuity === 'G2')
      for (let it = 0; it < 3; it++) {
        const target = [...net.values];
        const rows = plateRows(hole.value, net, continuity, spokes, true);
        const next = solvePlate(net, target, rows);
        if (!next.ok) return next;
      }
    const patches = Array.from({ length: n }, (_, k) => quad(net, k));
    const measured = measure(hole.value, patches);
    if (!measured.ok) return measured;
    const turn = orientation(hole.value, patches);
    fold = turn.angle > 90 ? turn : undefined;
    worst = measured.value.worst;
    best = {
      patches,
      residual: measured.value.residual,
      normalSpread: turn.angle,
    };
    if (fold === undefined && (continuity === 'G0' || worst <= G1_TARGET)) break;
  }
  if (fold !== undefined)
    return err(
      modelingError(
        'model-degenerate',
        'the fill quads keep the orientation of the boundary (no fold)',
        {
          quad: fold.quad,
          angle: fold.angle,
          point: fold.point,
          u: fold.u,
          v: fold.v,
          sides: hole.value.sides.map((s) => s.length),
        },
        'the hole is too thin for the midpoint quads: split it into better-proportioned holes or widen its short side',
      ),
    );
  const result = best as FillResult;
  if (spokes && continuity !== 'G0' && worst > G1_TARGET) {
    const corners = cornerMismatch(hole.value);
    const inconsistent = corners.some((a) => a > G1_TARGET);
    const worstOf = (edge: 'side' | 'spoke') =>
      Math.max(0, ...result.residual.filter((r) => r.edge === edge).map((r) => r.angle));
    return err(
      modelingError(
        'model-precondition',
        `the fill meets its neighbours and itself G1 within ${G1_TARGET} degree`,
        {
          sideAngle: worstOf('side'),
          spokeAngle: worstOf('spoke'),
          target: G1_TARGET,
          cornerMismatch: corners,
        },
        inconsistent
          ? 'the neighbour normals are inconsistent at the hole corners (cornerMismatch, degrees): make neighbouring boundaries meet G1 at each corner'
          : 'the solve did not reach the G1 budget: request G1 instead of G2, or split the hole',
      ),
    );
  }
  return ok(result);
}

/**
 * Fill an n-sided hole (3 to 8 sides) bounded by patch sides or curves with n quads that
 * meet the neighbours G1 (or G2 along the outer sides) and each other G1, solved
 * simultaneously so the spokes close around the center. Residuals are measured on the
 * result per outer side and spoke; spans grow until every G1 angle is <= 0.1 deg. A quad
 * folding against the boundary orientation is `model-degenerate`; a G1 angle still above
 * 0.1 deg after the last span count (neighbour normals that disagree at a corner) is
 * `model-precondition` with the residuals.
 */
export function fillN(options: FillOptions): Result<FillResult, ModelingError> {
  return fillQuads(options, true);
}
