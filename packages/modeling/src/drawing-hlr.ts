import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, hypot2 } from './dmath';
import {
  chain,
  DRAWING_POINT_LIMIT,
  type DrawingRole,
  type DrawnLine,
  type Segment2,
} from './drawing';
import { pieces } from './drawing-explode';
import { type ModelingError, modelingError } from './errors';
import { dot, faceNormal, type Tuple3, triangulateLoop } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import type { Point2 } from './primitives';
import { isOrthoView, ORTHO_VIEWS, type OrthoView, toView, type ViewFrame } from './views';

/** Work bound of one hidden-line pass: grid cells visited plus edge-triangle tests. */
export const HLR_WORK_LIMIT = 20_000_000;

/** Turning angle (degrees) from which an edge between two faces is a crease. */
export const HLR_CREASE_ANGLE = 30;

export interface ViewLinesOptions {
  /** Id of the view the items belong to; items are keyed `<id>/<kind>-<role>-<k>`. */
  readonly id: string;
  /** Turning angle in degrees between the two face normals from which an edge is a crease (default 30). */
  readonly creaseAngle?: number;
  /** Edges flagged sharp are creases whatever their angle (default true). */
  readonly sharp?: boolean;
  /** Bound on grid cells visited plus edge-triangle tests (default `HLR_WORK_LIMIT`). */
  readonly workLimit?: number;
}

type EdgeKind = 'contour' | 'crease' | 'boundary';

const FACING = 1e-9;
const REL = 1e-6;
const JOIN = 1e-6;
const MAX_GRID = 256;

interface Tri {
  readonly face: number;
  readonly a: Tuple3;
  readonly b: Tuple3;
  readonly c: Tuple3;
  readonly sign: number;
  readonly du: number;
  readonly dv: number;
  readonly w0: number;
}

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function checkOptions(options: ViewLinesOptions): ModelingError | undefined {
  if (typeof options.id !== 'string' || options.id.length === 0)
    return invalid('options.id is the non-empty id of the view', { id: options.id });
  const angle = options.creaseAngle;
  if (angle !== undefined && !(Number.isFinite(angle) && angle >= 0 && angle <= 180))
    return invalid('creaseAngle is a finite angle in [0, 180] degrees', { creaseAngle: angle });
  const limit = options.workLimit;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
    return invalid('workLimit is a positive integer', { workLimit: limit });
  return undefined;
}

function frameOf(view: OrthoView | ViewFrame): ViewFrame | undefined {
  if (typeof view === 'string') return isOrthoView(view) ? ORTHO_VIEWS[view] : undefined;
  const ok3 = (v: unknown) =>
    Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  return view !== null && ok3(view.right) && ok3(view.up) && ok3(view.toward) ? view : undefined;
}

function triangles(mesh: EditMesh, frame: ViewFrame): Tri[] {
  const out: Tri[] = [];
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    const tri = loop.length >= 3 ? (triangulateLoop(loop) ?? fan(loop.length)) : [];
    const view = loop.map((p) => toView(frame, p));
    for (let i = 0; i < tri.length; i += 3) {
      const a = view[tri[i] as number] as Tri['a'];
      const b = view[tri[i + 1] as number] as Tri['b'];
      const c = view[tri[i + 2] as number] as Tri['c'];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area === 0) continue;
      const sign = area > 0 ? 1 : -1;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
      const du = (ab[2] * ac[1] - ac[2] * ab[1]) / -area;
      const dv = (ab[0] * ac[2] - ac[0] * ab[2]) / -area;
      out.push({ face: f, a, b, c, sign, du, dv, w0: a[2] - du * a[0] - dv * a[1] });
    }
  }
  return out;
}

function fan(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
  return out;
}

interface Grid {
  readonly lo: Point2;
  readonly cell: Point2;
  readonly n: number;
  readonly cells: readonly (readonly number[])[];
}

function buildGrid(tris: readonly Tri[]): Grid {
  let u0 = Number.POSITIVE_INFINITY;
  let v0 = Number.POSITIVE_INFINITY;
  let u1 = Number.NEGATIVE_INFINITY;
  let v1 = Number.NEGATIVE_INFINITY;
  for (const t of tris)
    for (const p of [t.a, t.b, t.c]) {
      u0 = Math.min(u0, p[0]);
      u1 = Math.max(u1, p[0]);
      v0 = Math.min(v0, p[1]);
      v1 = Math.max(v1, p[1]);
    }
  const n = Math.max(1, Math.min(MAX_GRID, Math.ceil(Math.sqrt(tris.length))));
  const cell: Point2 = [Math.max((u1 - u0) / n, 1e-12), Math.max((v1 - v0) / n, 1e-12)];
  const cells: number[][] = Array.from({ length: n * n }, () => []);
  const grid: Grid = { lo: [u0, v0], cell, n, cells };
  tris.forEach((t, i) => {
    const [i0, i1] = span(
      grid,
      0,
      Math.min(t.a[0], t.b[0], t.c[0]),
      Math.max(t.a[0], t.b[0], t.c[0]),
    );
    const [j0, j1] = span(
      grid,
      1,
      Math.min(t.a[1], t.b[1], t.c[1]),
      Math.max(t.a[1], t.b[1], t.c[1]),
    );
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) cells[j * n + k]?.push(i);
  });
  return grid;
}

function span(grid: Grid, axis: 0 | 1, lo: number, hi: number): [number, number] {
  const at = (x: number) =>
    Math.max(0, Math.min(grid.n - 1, Math.floor((x - grid.lo[axis]) / grid.cell[axis] + 1e-9)));
  return [at(lo), at(hi)];
}

/** Interval of t in [0, 1] where the edge is behind `t` in view depth, or undefined. */
function hiddenBy(
  p: Tuple3,
  q: Tuple3,
  t: Tri,
  eps2: number,
  epsW: number,
): [number, number] | undefined {
  let lo = 0;
  let hi = 1;
  const sides = [
    [t.a, t.b],
    [t.b, t.c],
    [t.c, t.a],
  ] as const;
  for (const [x, y] of sides) {
    const ex = y[0] - x[0];
    const ey = y[1] - x[1];
    const len = hypot2(ex, ey);
    const f0 = (t.sign * (ex * (p[1] - x[1]) - ey * (p[0] - x[0]))) / len + eps2;
    const f1 = (t.sign * (ex * (q[1] - x[1]) - ey * (q[0] - x[0]))) / len + eps2;
    if (f0 < 0 && f1 < 0) return undefined;
    if (f0 >= 0 && f1 >= 0) continue;
    const at = f0 / (f0 - f1);
    if (f0 < 0) lo = Math.max(lo, at);
    else hi = Math.min(hi, at);
    if (lo >= hi) return undefined;
  }
  const g0 = t.w0 + t.du * p[0] + t.dv * p[1] - p[2] - epsW;
  const g1 = t.w0 + t.du * q[0] + t.dv * q[1] - q[2] - epsW;
  if (g0 <= 0 && g1 <= 0) return undefined;
  if (g0 < 0 || g1 < 0) {
    const at = g0 / (g0 - g1);
    if (g0 < 0) lo = Math.max(lo, at);
    else hi = Math.min(hi, at);
  }
  return lo < hi ? [lo, hi] : undefined;
}

function classify(
  mesh: EditMesh,
  e: number,
  frame: ViewFrame,
  cosCrease: number,
  sharp: boolean,
  facing: Map<number, number>,
  normals: Map<number, Tuple3>,
): EdgeKind | undefined {
  const fa = mesh.hFace[e * 2] as number;
  const fb = mesh.hFace[e * 2 + 1] as number;
  if (fa === NONE || fb === NONE) return 'boundary';
  const normal = (f: number) => {
    let n = normals.get(f);
    if (n === undefined) {
      n = faceNormal(mesh, f);
      normals.set(f, n);
    }
    return n;
  };
  const side = (f: number) => {
    let d = facing.get(f);
    if (d === undefined) {
      d = dot(normal(f), frame.toward);
      facing.set(f, d);
    }
    return d > FACING;
  };
  if (side(fa) !== side(fb)) return 'contour';
  if (sharp && ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0) return 'crease';
  return dot(normal(fa), normal(fb)) <= cosCrease ? 'crease' : undefined;
}

/**
 * Contour, crease and boundary edges of the mesh in an orthographic view, split exactly into
 * visible and hidden runs and returned as `visible` / `hidden` polylines in view coordinates
 * (meters), ready to add to a drawing. Hidden-line removal: every edge is clipped against the
 * projection of every triangle that is not one of its own faces, and the part behind the triangle's
 * plane is hidden; the intervals are exact (no sampling) and the triangles are found through a
 * uniform grid. A contour is an edge between a face turned to the viewer and one turned away
 * (faces edge-on count as turned away), a crease an edge whose faces turn by at least
 * `creaseAngle` (or that is flagged sharp), a boundary an edge of one face. Edges seen end-on
 * have no length in the view and are left out. Hidden pieces that lie on a visible line are
 * dropped. `meshViewEdges` lacks this: it only drops back faces.
 */
export function meshViewLines(
  mesh: EditMesh,
  view: OrthoView | ViewFrame,
  options: ViewLinesOptions,
): Result<DrawnLine[], ModelingError> {
  const bad = checkOptions(options);
  if (bad !== undefined) return err(bad);
  const frame = frameOf(view);
  if (frame === undefined)
    return err(invalid('view is an ortho view name or a frame of three finite vectors', { view }));
  const limit = options.workLimit ?? HLR_WORK_LIMIT;
  const cosCrease = cos(((options.creaseAngle ?? HLR_CREASE_ANGLE) * Math.PI) / 180);
  const tris = triangles(mesh, frame);
  const grid = buildGrid(tris);
  let extent = 0;
  for (const t of tris)
    for (const p of [t.a, t.b, t.c])
      extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps2 = REL * extent * 1e-3;
  const epsW = REL * extent;
  const minLen = Math.max(JOIN, REL * extent);
  const facing = new Map<number, number>();
  const normals = new Map<number, Tuple3>();
  const stamp = new Int32Array(tris.length);
  let work = 0;
  const runs: Record<EdgeKind, { visible: Segment2[]; hidden: Segment2[] }> = {
    contour: { visible: [], hidden: [] },
    crease: { visible: [], hidden: [] },
    boundary: { visible: [], hidden: [] },
  };
  let n = 0;
  for (const e of mesh.edges()) {
    const kind = classify(mesh, e, frame, cosCrease, options.sharp !== false, facing, normals);
    if (kind === undefined) continue;
    const [v0, v1] = mesh.edgeVertices(e);
    const p = toView(frame, mesh.position(v0));
    const q = toView(frame, mesh.position(v1));
    const length = hypot2(q[0] - p[0], q[1] - p[1]);
    if (length <= minLen) continue;
    const own = [mesh.hFace[e * 2] as number, mesh.hFace[e * 2 + 1] as number];
    n++;
    const [i0, i1] = span(grid, 0, Math.min(p[0], q[0]), Math.max(p[0], q[0]));
    const [j0, j1] = span(grid, 1, Math.min(p[1], q[1]), Math.max(p[1], q[1]));
    const covered: [number, number][] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        work++;
        for (const k of grid.cells[j * grid.n + i] as readonly number[]) {
          if (stamp[k] === n) continue;
          stamp[k] = n;
          const t = tris[k] as Tri;
          if (own.includes(t.face)) continue;
          work++;
          const h = hiddenBy(p, q, t, eps2, epsW);
          if (h !== undefined && (h[1] - h[0]) * length > minLen) covered.push(h);
        }
        if (work > limit) return budget(limit, mesh, tris.length);
      }
    }
    covered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const point = (t: number): Point2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const put = (from: number, to: number, hidden: boolean) => {
      if ((to - from) * length <= minLen) return;
      (hidden ? runs[kind].hidden : runs[kind].visible).push([point(from), point(to)]);
    };
    let at = 0;
    let from = -1;
    let to = -1;
    for (const [lo, hi] of covered) {
      if (from < 0) {
        from = lo;
        to = hi;
      } else if (lo <= to + minLen / length) to = Math.max(to, hi);
      else {
        put(at, from, false);
        put(from, to, true);
        at = to;
        from = lo;
        to = hi;
      }
    }
    if (from < 0) put(0, 1, false);
    else {
      put(at, from, false);
      put(from, to, true);
      put(to, 1, false);
    }
  }
  const cover: Segment2[] = (Object.values(runs) as { visible: Segment2[] }[]).flatMap(
    (r) => r.visible,
  );
  const out: DrawnLine[] = [];
  let total = 0;
  for (const kind of ['contour', 'crease', 'boundary'] as const) {
    for (const role of ['visible', 'hidden'] as const) {
      const segments = role === 'visible' ? runs[kind].visible : [];
      if (role === 'hidden') {
        for (const s of runs[kind].hidden) {
          work += cover.length;
          if (work > limit) return budget(limit, mesh, tris.length);
          for (const piece of withoutCovered(s, cover, minLen)) {
            segments.push(piece);
            cover.push(piece);
          }
        }
      }
      let k = 0;
      for (const line of chain(segments, JOIN)) {
        for (const piece of pieces(line)) {
          total += piece.points.length;
          if (total > DRAWING_POINT_LIMIT) {
            return err(
              modelingError(
                'model-work-budget',
                'the view lines stay within the drawing point limit',
                { limit: DRAWING_POINT_LIMIT },
              ),
            );
          }
          out.push({
            id: `${options.id}/${kind}-${role}-${k++}`,
            view: options.id,
            role: role as DrawingRole,
            kind: 'curve',
            curve: { kind: 'polyline', points: piece.points },
            closed: piece.closed,
            basis: 'derived',
          });
        }
      }
    }
  }
  return ok(out);
}

function budget(
  limit: number,
  mesh: EditMesh,
  triangles: number,
): Result<DrawnLine[], ModelingError> {
  return err(
    modelingError(
      'model-work-budget',
      `hidden-line removal stays within ${limit} grid cells and edge-triangle tests`,
      { limit, edges: mesh.edges().length, triangles },
    ),
  );
}

/** The parts of a hidden segment not lying on a visible segment (same line, within tolerance). */
function withoutCovered(s: Segment2, visible: readonly Segment2[], tol: number): Segment2[] {
  const [a, b] = s;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = hypot2(dx, dy);
  const cuts: [number, number][] = [];
  for (const [c, d] of visible) {
    const sc = (dx * (c[1] - a[1]) - dy * (c[0] - a[0])) / len;
    const sd = (dx * (d[1] - a[1]) - dy * (d[0] - a[0])) / len;
    if (Math.abs(sc) > tol || Math.abs(sd) > tol) continue;
    const tc = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (len * len);
    const td = ((d[0] - a[0]) * dx + (d[1] - a[1]) * dy) / (len * len);
    const lo = Math.max(0, Math.min(tc, td));
    const hi = Math.min(1, Math.max(tc, td));
    if (hi > lo) cuts.push([lo, hi]);
  }
  cuts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Segment2[] = [];
  let at = 0;
  const keep = (from: number, to: number) => {
    if ((to - from) * len > tol)
      out.push([
        [a[0] + dx * from, a[1] + dy * from],
        [a[0] + dx * to, a[1] + dy * to],
      ]);
  };
  for (const [lo, hi] of cuts) {
    if (lo > at) keep(at, lo);
    at = Math.max(at, hi);
  }
  keep(at, 1);
  return out;
}
