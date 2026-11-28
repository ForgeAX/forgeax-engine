import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { pcurvePoint, pcurveTangent } from './curves';
import { tally } from './ops';
import { brepError, type Coedge, type Edge, type Face, type Shape } from './types';
import type { P2 } from './vec';

/** Tolerance for comparing parameters that come from different closed-form pcurves. */
export const UV_TOL = 1e-9;

export function isDegenerate(shape: Shape, coedge: Coedge): boolean {
  return (shape.edges[coedge.edge] as Edge).curve < 0;
}

/** The (u, v) at the start and end of a coedge in loop traversal order. */
export function coedgeEnds(e: Edge, coedge: Coedge): { start: P2; end: P2 } {
  const a = pcurvePoint(coedge.pcurve, coedge.reversed ? e.t1 : e.t0);
  const b = pcurvePoint(coedge.pcurve, coedge.reversed ? e.t0 : e.t1);
  return { start: a, end: b };
}

function endsOf(shape: Shape, c: number): { start: P2; end: P2 } {
  const co = shape.coedges[c] as Coedge;
  return coedgeEnds(shape.edges[co.edge] as Edge, co);
}

/** The coedge indices of the face's loops: `outer` first, then holes. */
export function faceLoops(
  shape: Shape,
  f: number,
): { outer: readonly number[]; holes: readonly (readonly number[])[] } {
  const face = shape.faces[f] as Shape['faces'][number];
  const outer: number[] = [];
  const holes: (readonly number[])[] = [];
  for (const l of face.loops) {
    const loop = shape.loops[l] as Shape['loops'][number];
    if (loop.outer && outer.length === 0) outer.push(...loop.coedges);
    else holes.push(loop.coedges);
  }
  return { outer, holes };
}

/** A side of a grid face: consecutive coedges along one iso-line of (u, v). */
export interface GridSide {
  readonly coedges: readonly number[];
  readonly degenerate: boolean;
}

/**
 * A face whose single outer loop is an axis-aligned rectangle in (u, v): bottom (+u at `v0`),
 * right (+v at `u1`), top (-u at `v1`), left (-v at `u0`). A side that maps to a point
 * (a pole or apex) is `degenerate`.
 */
export interface GridFace {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  readonly bottom: GridSide;
  readonly right: GridSide;
  readonly top: GridSide;
  readonly left: GridSide;
}

function unsupported(f: number, why: string, kind?: string): Result<GridFace, ModelingError> {
  return err(
    brepError('brep-face-unsupported', `a rectangular (u, v) outer loop (${why})`, {
      face: f,
      reason: why,
      ...(kind === undefined ? {} : { surface: kind }),
    }),
  );
}

interface Run {
  dir: number;
  coedges: number[];
}

/**
 * True when the coedge's pcurve keeps one coordinate constant over its whole span, sampled densely:
 * `v` for a u-direction side (`fixedV`), `u` for a v-direction side.
 */
function isIsoLine(shape: Shape, coedge: Coedge, fixedV: boolean): boolean {
  const e = shape.edges[coedge.edge] as Edge;
  if (e.curve < 0 || coedge.pcurve.kind !== 'nurbs') return true;
  const axis = fixedV ? 1 : 0;
  const ref = pcurvePoint(coedge.pcurve, e.t0)[axis];
  for (let k = 1; k <= 16; k++) {
    const t = e.t0 + ((e.t1 - e.t0) * k) / 16;
    if (Math.abs(pcurvePoint(coedge.pcurve, t)[axis] - ref) > UV_TOL) return false;
  }
  return true;
}

export function gridOf(shape: Shape, f: number): Result<GridFace, ModelingError> {
  const kind = shape.surfaces[(shape.faces[f] as Face).surface]?.kind;
  const gridded = gridRuns(shape, f);
  if (gridded.ok || kind === undefined) return gridded;
  return unsupported(f, (gridded.error.detail as { reason: string }).reason, kind);
}

/**
 * True when a `gridOf` failure only says the outer loop is not an axis-aligned rectangle: a hole,
 * a side that is not an iso-line, or a side count other than four. Any other grid failure (a
 * rectangle with the wrong orientation or an open rectangle) is a real error and must keep it.
 */
export function isTrimEligibleGridFailure(error: ModelingError): boolean {
  const reason = (error.detail as { reason?: unknown }).reason;
  return (
    reason === 'no holes' ||
    reason === 'axis-aligned sides' ||
    (typeof reason === 'string' && /^\d+ sides$/.test(reason))
  );
}

function gridRuns(shape: Shape, f: number): Result<GridFace, ModelingError> {
  const { outer, holes } = faceLoops(shape, f);
  if (holes.length > 0) return unsupported(f, 'no holes');
  const runs: { dir: number; coedges: number[] }[] = [];
  for (const c of outer) {
    const co = shape.coedges[c] as Coedge;
    const { start, end } = coedgeEnds(shape.edges[co.edge] as Edge, co);
    const du = end[0] - start[0];
    const dv = end[1] - start[1];
    let dir: number;
    if (Math.abs(dv) <= UV_TOL && Math.abs(du) > UV_TOL) dir = du > 0 ? 0 : 2;
    else if (Math.abs(du) <= UV_TOL && Math.abs(dv) > UV_TOL) dir = dv > 0 ? 1 : 3;
    else return unsupported(f, 'axis-aligned sides');
    // Endpoints alone do not prove an iso-line: a curve whose ends share a v may still bow away from it.
    if (!isIsoLine(shape, shape.coedges[c] as Coedge, dir % 2 === 0)) {
      return unsupported(f, 'axis-aligned sides');
    }
    const last = runs[runs.length - 1];
    if (last !== undefined && last.dir === dir) last.coedges.push(c);
    else runs.push({ dir, coedges: [c] });
  }
  if (
    runs.length > 1 &&
    (runs[0] as { dir: number }).dir === (runs[runs.length - 1] as { dir: number }).dir
  ) {
    const first = runs.shift() as { dir: number; coedges: number[] };
    (runs[runs.length - 1] as { coedges: number[] }).coedges.push(...first.coedges);
  }
  if (runs.length !== 4) return unsupported(f, `${runs.length} sides`);
  const k = runs.findIndex((r) => r.dir === 0);
  if (k < 0) return unsupported(f, 'no +u side');
  const ordered = [0, 1, 2, 3].map((i) => runs[(k + i) % 4] as { dir: number; coedges: number[] });
  if (ordered.some((r, i) => r.dir !== i)) return unsupported(f, 'counter-clockwise order');
  const side = (r: Run): GridSide => ({
    coedges: r.coedges,
    degenerate: r.coedges.every((c) => isDegenerate(shape, shape.coedges[c] as Coedge)),
  });
  const first = (r: Run) => endsOf(shape, r.coedges[0] as number).start;
  const lastOf = (r: Run) => endsOf(shape, r.coedges[r.coedges.length - 1] as number).end;
  const [b, r, t, l] = ordered as [Run, Run, Run, Run];
  const u0 = first(b)[0];
  const u1 = lastOf(b)[0];
  const v0 = first(b)[1];
  const v1 = lastOf(r)[1];
  const close =
    Math.abs(first(r)[0] - u1) <= UV_TOL &&
    Math.abs(first(t)[1] - v1) <= UV_TOL &&
    Math.abs(lastOf(t)[0] - u0) <= UV_TOL &&
    Math.abs(first(l)[0] - u0) <= UV_TOL &&
    Math.abs(lastOf(l)[1] - v0) <= UV_TOL;
  if (!close || !(u1 > u0) || !(v1 > v0)) return unsupported(f, 'a closed rectangle');
  return ok({ u0, u1, v0, v1, bottom: side(b), right: side(r), top: side(t), left: side(l) });
}

const GL_X = [
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
] as const;
const GL_W = [
  0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
] as const;
const PIECE = Math.PI / 4;

/**
 * Composite 8-point Gauss-Legendre over [a, b] with pieces of at most `piece` (default pi/4: exact for the
 * trig integrands of the quadrics, where the parameter is an angle). A parameter along a length passes
 * `Infinity`: its polynomial integrand needs one piece however long the span is.
 */
export function integrate(f: (x: number) => number, a: number, b: number, piece = PIECE): number {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / piece));
  const h = (b - a) / n;
  tally('quadratureEvals', 8 * n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const mid = a + (i + 0.5) * h;
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const dx = 0.5 * h * (GL_X[k] as number);
      s += (GL_W[k] as number) * (f(mid - dx) + f(mid + dx));
    }
    total += 0.5 * h * s;
  }
  return total;
}

/** Green's integral of (u dv - v du) / 2 along a coedge in its traversal direction. */
export function coedgeGreen(e: Edge, coedge: Coedge): number {
  const ta = coedge.reversed ? e.t1 : e.t0;
  const tb = coedge.reversed ? e.t0 : e.t1;
  const p = coedge.pcurve;
  if (p.kind === 'line') return 0.5 * (p.o[0] * p.d[1] - p.o[1] * p.d[0]) * (tb - ta);
  return integrate(
    (t) => {
      const q = pcurvePoint(p, t);
      const d = pcurveTangent(p, t);
      return 0.5 * (q[0] * d[1] - q[1] * d[0]);
    },
    ta,
    tb,
  );
}

export function loopSignedArea(shape: Shape, coedges: readonly number[]): number {
  let a = 0;
  for (const c of coedges)
    a += coedgeGreen(
      shape.edges[(shape.coedges[c] as Coedge).edge] as Edge,
      shape.coedges[c] as Coedge,
    );
  return a;
}
