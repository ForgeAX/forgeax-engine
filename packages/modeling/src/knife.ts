import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll, replaceAll } from './arrays';
import { mergeFlags } from './crease';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceCentroid,
  length,
  newell,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, edgeKey, NONE } from './mesh';
import { markRole, type OpDiagnostic, type RoleCounts } from './ops';
import { type CornerSource, rewriteFaces } from './rewrite';
import { SurfaceQuery } from './shrinkwrap';

export interface KnifeOptions {
  /** Path points (meters): on the surface, or anywhere along the view when `direction` is set. */
  readonly points: readonly Tuple3[];
  /**
   * Knife project: cut where the path, swept along this view direction, meets the
   * faces. Absent: a surface path, each point snapped to its nearest surface point
   * and each segment swept along the surface normal.
   */
  readonly direction?: Tuple3;
  /** The last point joins the first; enclosed faces get role `inside` (default false). */
  readonly closed?: boolean;
  /** With `direction`: cut every layer the sweep meets, not only the visible one (default false). */
  readonly through?: boolean;
  /**
   * Crossings closer than this to a vertex go through the vertex (meters; default 1% of
   * the crossed edge, at least the model tolerance), so no sliver faces appear.
   */
  readonly snap?: number;
  /** Mark the cut edges sharp / as UV seams (default false). */
  readonly sharp?: boolean;
  readonly seam?: boolean;
}

type Point2 = readonly [number, number];

interface Segment {
  readonly a: Tuple3;
  readonly length: number;
  readonly d: Tuple3;
  readonly u: Tuple3;
  readonly w: Tuple3;
}

/** A point of the path on the mesh: a vertex, a point on an edge, or a point inside a face. */
type CutEvent =
  | { readonly kind: 'vertex'; readonly id: number; readonly param: number; readonly v: number }
  | {
      readonly kind: 'edge';
      readonly id: number;
      readonly param: number;
      readonly a: number;
      readonly b: number;
      /** Parameter from `a` to `b`. */
      readonly t: number;
      readonly point: Tuple3;
    }
  | {
      readonly kind: 'inside';
      readonly id: number;
      readonly param: number;
      readonly face: number;
      readonly point: Tuple3;
      readonly weights: readonly (readonly [number, number])[];
    };

interface Piece {
  readonly face: number;
  readonly from: CutEvent;
  readonly to: CutEvent;
  readonly mid: Tuple3;
  /** The path runs along an existing edge of the face: no split, only intent. */
  readonly along?: readonly [number, number];
}

const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

function finite3(value: unknown): value is Tuple3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((c) => typeof c === 'number' && Number.isFinite(c))
  );
}

function frame(a: Tuple3, b: Tuple3, d: Tuple3): Segment | undefined {
  const e = sub(b, a);
  const along = sub(e, scale(d, dot(e, d)));
  const l = length(along);
  if (!(l > 0)) return undefined;
  const u = scale(along, 1 / l);
  return { a, length: l, d, u, w: normalize(cross(d, u)) };
}

function to2(s: Segment, p: Tuple3): Point2 {
  const x = p[0] - s.a[0];
  const y = p[1] - s.a[1];
  const z = p[2] - s.a[2];
  return [x * s.u[0] + y * s.u[1] + z * s.u[2], x * s.w[0] + y * s.w[1] + z * s.w[2]];
}

/** Distance from q to segment ab (2D). */
function segmentDistance(q: Point2, a: Point2, b: Point2): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / l2)) : 0;
  const dx = a[0] + ex * t - q[0];
  const dy = a[1] + ey * t - q[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Strictly inside the polygon, farther than `margin` from its boundary (even-odd rule). */
function insidePolygon(q: Point2, polygon: readonly Point2[], margin: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as Point2;
    const b = polygon[j] as Point2;
    if (segmentDistance(q, a, b) <= margin) return false;
    if (a[1] > q[1] !== b[1] > q[1]) {
      const x = a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (q[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** Barycentric lift of a frame point onto a face's export triangulation, or undefined. */
function liftOnto(
  mesh: EditMesh,
  f: number,
  segment: Segment,
  q: Point2,
): { point: Tuple3; weights: [number, number][] } | undefined {
  const halves = mesh.faceHalves(f);
  const points = halves.map((h) => mesh.position(mesh.hVert[h] as number));
  const triangles = triangulateLoop(points);
  if (triangles === undefined) return undefined;
  const slack = 1e-9;
  for (let i = 0; i < triangles.length; i += 3) {
    const ids = [triangles[i], triangles[i + 1], triangles[i + 2]] as [number, number, number];
    const [a, b, c] = ids.map((k) => to2(segment, points[k] as Tuple3)) as [Point2, Point2, Point2];
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(det) < 1e-30) continue;
    const l1 = ((q[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (q[1] - a[1])) / det;
    const l2 = ((b[0] - a[0]) * (q[1] - a[1]) - (q[0] - a[0]) * (b[1] - a[1])) / det;
    const l0 = 1 - l1 - l2;
    if (l0 < -slack || l1 < -slack || l2 < -slack) continue;
    const weights: [number, number][] = [
      [halves[ids[0]] as number, l0],
      [halves[ids[1]] as number, l1],
      [halves[ids[2]] as number, l2],
    ];
    const point = add(
      add(scale(points[ids[0]] as Tuple3, l0), scale(points[ids[1]] as Tuple3, l1)),
      scale(points[ids[2]] as Tuple3, l2),
    );
    return { point, weights };
  }
  return undefined;
}

/**
 * Knife / knife project: cut a polyline into the mesh.
 * Each segment sweeps a curtain along a direction (the view direction, or the
 * surface normal at a surface path); faces split along the curtain's chords into
 * valid n-gons, crossed edges gain vertices with interpolated corner values, and a
 * crossing near a vertex goes through it. Open path ends inside a face are trimmed to
 * that face's boundary (reported). A closed path gives the enclosed faces role
 * `inside` (with a label) and the placement tag.
 */
export function knife(
  mesh: EditMesh,
  scope: readonly number[],
  options: KnifeOptions,
  label: number,
  tag: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  // Snapping moves crossings onto vertices; two of them can then meet one vertex or
  // cross an earlier chain. The cut is atomic: on such a split failure the mesh is
  // restored and the cut repeats with a smaller snap, so snap never creates crossings.
  let first: Result<RoleCounts, ModelingError> | undefined;
  for (const scale of SNAP_SCALES) {
    const saved = mesh.clone();
    const local: OpDiagnostic[] = [];
    const cut = knifeAt(mesh, scope, options, label, tag, tolerance, local, scale);
    if (cut.ok) {
      pushAll(diagnostics, local);
      if (scale !== 1) {
        diagnostics.push({
          severity: 'info',
          message: `knife snap reduced to ${scale} x the requested distance so crossings stay apart`,
          detail: {
            snapScale: scale,
            first: first?.ok === false ? first.error.expected : undefined,
          },
        });
      }
      return cut;
    }
    first ??= cut;
    mesh.assign(saved);
    if (cut.error.code !== 'model-precondition' && cut.error.code !== 'model-degenerate') break;
  }
  return first as Result<RoleCounts, ModelingError>;
}

/** Snap distances tried in turn, as multiples of the requested (or default) snap. */
const SNAP_SCALES = [1, 0.25, 1 / 16, 0];

function knifeAt(
  mesh: EditMesh,
  scope: readonly number[],
  options: KnifeOptions,
  label: number,
  tag: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  snapScale: number,
): Result<RoleCounts, ModelingError> {
  const points = options?.points;
  const closed = options.closed === true;
  if (!Array.isArray(points) || !points.every(finite3)) {
    return invalid('points are [x, y, z] triples of finite numbers', { points });
  }
  if (points.length < (closed ? 3 : 2)) {
    return invalid(
      `a ${closed ? 'closed' : 'open'} knife path has at least ${closed ? 3 : 2} points`,
      {
        points: points.length,
      },
    );
  }
  if (
    options.direction !== undefined &&
    (!finite3(options.direction) || length(options.direction) === 0)
  ) {
    return invalid('direction is three finite numbers, not all zero', {
      direction: options.direction,
    });
  }
  if (options.through === true && options.direction === undefined) {
    return invalid('through applies to a projected path (direction)', { through: true });
  }
  if (options.snap !== undefined && !(Number.isFinite(options.snap) && options.snap >= 0)) {
    return invalid('snap is a finite length >= 0', { snap: options.snap });
  }
  const surface = SurfaceQuery.of(mesh, scope);
  if (!surface.ok) return surface;
  const n = points.length;
  const m = closed ? n : n - 1;

  // Path points and the per-segment sweep direction.
  const path: Tuple3[] = [];
  const cornerFaces: (number | undefined)[] = [];
  const directions: Tuple3[] = [];
  if (options.direction !== undefined) {
    const d = normalize(options.direction);
    for (const p of points) {
      path.push([...p]);
      cornerFaces.push(undefined);
    }
    for (let k = 0; k < m; k++) directions.push(d);
  } else {
    const normals: Tuple3[] = [];
    let farthest = 0;
    for (const p of points) {
      const hit = surface.value.nearest(p);
      if (hit === undefined) return invalid('the scope has faces to cut', {});
      farthest = Math.max(farthest, hit.distance);
      path.push(hit.point);
      normals.push(hit.normal);
      cornerFaces.push(hit.face);
    }
    for (let k = 0; k < m; k++) {
      const d = normalize(add(normals[k] as Tuple3, normals[(k + 1) % n] as Tuple3));
      if (length(d) === 0) {
        return err(
          modelingError(
            'model-precondition',
            'consecutive surface path points do not face opposite ways',
            { segment: k, points: [path[k], path[(k + 1) % n]] },
            'add path points between the two, on the surface the cut follows',
          ),
        );
      }
      directions.push(d);
    }
    diagnostics.push({
      severity: 'info',
      message: `knife snapped ${n} path points onto the surface (farthest ${farthest.toPrecision(3)} m)`,
      detail: { farthest },
    });
  }
  const segments: Segment[] = [];
  for (let k = 0; k < m; k++) {
    const s = frame(path[k] as Tuple3, path[(k + 1) % n] as Tuple3, directions[k] as Tuple3);
    if (s === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          'every knife segment has a length across its sweep direction',
          { segment: k, points: [path[k], path[(k + 1) % n]] },
          'remove repeated points, or points one behind the other along the view direction',
        ),
      );
    }
    segments.push(s);
  }

  // Events: vertices on a curtain, edge crossings, path corners inside faces.
  const events: CutEvent[] = [];
  const vertexEvents = new Map<number, CutEvent[]>();
  const edgeEvents = new Map<number, CutEvent[]>();
  const insideEvents = new Map<number, CutEvent[]>();
  const pushTo = (map: Map<number, CutEvent[]>, key: number, e: CutEvent) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [e]);
    else list.push(e);
  };
  const addVertexEvent = (v: number, param: number) => {
    const same = (vertexEvents.get(v) ?? []).find((e) => Math.abs(e.param - param) < 0.01);
    if (same !== undefined) return same;
    const e: CutEvent = { kind: 'vertex', id: events.length, param, v };
    events.push(e);
    pushTo(vertexEvents, v, e);
    return e;
  };
  const snapOf = (edgeLength: number) =>
    Math.max(tolerance, (options.snap ?? edgeLength * 0.01) * snapScale);
  const addEdgeEvent = (a: number, b: number, t: number, param: number) => {
    const [lo, hi, tl] = a < b ? [a, b, t] : [b, a, 1 - t];
    const pa = mesh.position(lo);
    const pb = mesh.position(hi);
    const len = length(sub(pb, pa));
    const snap = snapOf(len);
    if (tl * len <= snap) return addVertexEvent(lo, param);
    if ((1 - tl) * len <= snap) return addVertexEvent(hi, param);
    const key = edgeKey(lo, hi);
    const same = (edgeEvents.get(key) ?? []).find(
      (e) => e.kind === 'edge' && Math.abs(e.t - tl) * len <= snap,
    );
    if (same !== undefined) return same;
    const e: CutEvent = {
      kind: 'edge',
      id: events.length,
      param,
      a: lo,
      b: hi,
      t: tl,
      point: add(pa, scale(sub(pb, pa), tl)),
    };
    events.push(e);
    pushTo(edgeEvents, key, e);
    return e;
  };
  const scopeSet = new Set(scope);
  const edges = new Map<number, [number, number]>();
  const scopeVertices = new Set<number>();
  for (const f of scope) {
    for (const v of mesh.faceVertices(f)) scopeVertices.add(v);
    for (const h of mesh.faceHalves(f)) {
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      edges.set(edgeKey(a, b), a < b ? [a, b] : [b, a]);
    }
  }
  const sortedVertices = [...scopeVertices].sort((x, y) => x - y);
  const sortedEdges = [...edges.entries()].sort((x, y) => x[0] - y[0]);
  // Cross-section coordinate of every scope vertex per segment, computed once: a vertex
  // or an edge can only meet a segment's curtain within its along-range, so both scans
  // below visit only the vertices whose x falls there (sorted, binary-searched).
  // The scan precedes every topology write; all segments share these exact positions.
  const scanPositions = sortedVertices.map((v) => ({ v, point: mesh.position(v) }));
  const segmentScan = segments.map((s) => {
    const xs = scanPositions.map(({ v, point }) => {
      const [x, r] = to2(s, point);
      return { v, x, r };
    });
    xs.sort((p, q) => p.x - q.x || p.v - q.v);
    return xs;
  });
  const lowerBound = (xs: readonly { x: number }[], value: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((xs[mid] as { x: number }).x < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const incident = new Map<number, [number, number][]>();
  for (const [, edge] of sortedEdges) {
    for (const v of edge) {
      const list = incident.get(v);
      if (list === undefined) incident.set(v, [edge]);
      else list.push(edge);
    }
  }
  let maxEdge = 0;
  for (const [, [a, b]] of sortedEdges) {
    maxEdge = Math.max(maxEdge, length(sub(mesh.position(b), mesh.position(a))));
  }
  // Faces with a vertex within one edge length (plus the snap) of a frame point: the
  // only faces whose projection can contain it.
  const facesOfVertex = new Map<number, number[]>();
  for (const f of scope) {
    for (const v of mesh.faceVertices(f)) {
      const list = facesOfVertex.get(v);
      if (list === undefined) facesOfVertex.set(v, [f]);
      else list.push(f);
    }
  }
  // A point inside a face lies within the face's diameter of each of its vertices.
  let maxDiameter = 0;
  for (const f of scope) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const c = scale(
      points.reduce<Tuple3>((sum, p) => add(sum, p), [0, 0, 0]),
      1 / points.length,
    );
    for (const p of points) maxDiameter = Math.max(maxDiameter, 2 * length(sub(p, c)));
  }
  const slack = maxDiameter + (options.snap ?? maxEdge * 0.01) + tolerance;
  const facesNear = (xs: readonly { v: number; x: number; r: number }[], q: Point2): number[] => {
    const out = new Set<number>();
    const from = lowerBound(xs, q[0] - slack);
    const to = lowerBound(xs, q[0] + slack);
    for (let i = from; i < to; i++) {
      const { v, r } = xs[i] as { v: number; x: number; r: number };
      if (Math.abs(r - q[1]) > slack) continue;
      for (const f of facesOfVertex.get(v) ?? []) out.add(f);
    }
    return [...out].sort((a, b) => a - b);
  };
  for (const [k, s] of segments.entries()) {
    const reach = s.length + tolerance;
    const xs = segmentScan[k] as { v: number; x: number; r: number }[];
    // Vertices of edges that can cross this curtain lie within one edge length of it.
    const near = xs
      .slice(lowerBound(xs, -tolerance - maxEdge), lowerBound(xs, reach + maxEdge))
      .filter(({ r }) => Math.abs(r) <= maxEdge + tolerance);
    const nearEdges = new Map<number, [number, number]>();
    for (const { v } of near) {
      for (const [a, b] of incident.get(v) ?? []) nearEdges.set(edgeKey(a, b), [a, b]);
    }
    for (const { v, x, r } of near) {
      if (Math.abs(r) <= tolerance && x >= -tolerance && x <= reach) {
        addVertexEvent(v, k + Math.min(1, Math.max(0, x / s.length)));
      }
    }
    for (const [, [a, b]] of [...nearEdges.entries()].sort((p, q) => p[0] - q[0])) {
      const ra = to2(s, mesh.position(a))[1];
      const rb = to2(s, mesh.position(b))[1];
      if (!((ra > tolerance && rb < -tolerance) || (ra < -tolerance && rb > tolerance))) continue;
      const t = ra / (ra - rb);
      const p = add(mesh.position(a), scale(sub(mesh.position(b), mesh.position(a)), t));
      const x = to2(s, p)[0];
      if (x < -tolerance || x > reach) continue;
      addEdgeEvent(a, b, t, k + Math.min(1, Math.max(0, x / s.length)));
    }
  }
  // Path corners (and the ends of an open path) inside faces. A corner on an edge or a
  // vertex of its face is an event of every face there: it seeds the surface layer too.
  const cornerEvents = new Set<number>();
  for (let k = 0; k < n; k++) {
    const segment = segments[Math.min(k, m - 1)] as Segment;
    const param = k === n - 1 && !closed ? m : k;
    const q = to2(segment, path[k] as Tuple3);
    const candidates =
      cornerFaces[k] === undefined
        ? facesNear(segmentScan[Math.min(k, m - 1)] as { v: number; x: number; r: number }[], q)
        : [cornerFaces[k] as number];
    for (const f of candidates) {
      const loop = mesh.faceVertices(f);
      const polygon = loop.map((v) => to2(segment, mesh.position(v)));
      const span = Math.max(
        ...loop.map((v, i) =>
          length(sub(mesh.position(v), mesh.position(loop[(i + 1) % loop.length] as number))),
        ),
      );
      const snap = Math.max(tolerance, (options.snap ?? span * 0.01) * snapScale);
      let lo0 = Infinity;
      let hi0 = -Infinity;
      let lo1 = Infinity;
      let hi1 = -Infinity;
      for (const [x, y] of polygon) {
        lo0 = Math.min(lo0, x);
        hi0 = Math.max(hi0, x);
        lo1 = Math.min(lo1, y);
        hi1 = Math.max(hi1, y);
      }
      if (q[0] < lo0 - snap || q[0] > hi0 + snap || q[1] < lo1 - snap || q[1] > hi1 + snap)
        continue;
      const lifted = liftOnto(mesh, f, segment, q);
      if (lifted === undefined) continue;
      const near = loop.findIndex((v) => length(sub(mesh.position(v), lifted.point)) <= snap);
      if (near >= 0) {
        cornerEvents.add(addVertexEvent(loop[near] as number, param).id);
        continue;
      }
      let onEdge = false;
      for (const [i, a] of loop.entries()) {
        const b = loop[(i + 1) % loop.length] as number;
        const pa = mesh.position(a);
        const e = sub(mesh.position(b), pa);
        const t = Math.min(1, Math.max(0, dot(sub(lifted.point, pa), e) / dot(e, e)));
        if (length(sub(add(pa, scale(e, t)), lifted.point)) <= snap) {
          cornerEvents.add(addEdgeEvent(a, b, t, param).id);
          onEdge = true;
          break;
        }
      }
      if (onEdge || !insidePolygon(q, polygon, 0)) continue;
      const e: CutEvent = {
        kind: 'inside',
        id: events.length,
        param,
        face: f,
        point: lifted.point,
        weights: lifted.weights,
      };
      events.push(e);
      pushTo(insideEvents, f, e);
    }
  }

  // Pieces: consecutive events of one face whose path between them runs inside it.
  const segmentAt = (param: number): [Segment, number] => {
    const wrapped = closed ? ((param % m) + m) % m : Math.min(param, m - 1e-12);
    const k = Math.min(m - 1, Math.floor(wrapped));
    const s = segments[k] as Segment;
    return [s, (wrapped - k) * s.length];
  };
  const pieces: Piece[] = [];
  for (const f of scope) {
    const loop = mesh.faceVertices(f);
    const own: CutEvent[] = [];
    for (const v of loop) pushAll(own, vertexEvents.get(v) ?? []);
    for (const [i, a] of loop.entries()) {
      pushAll(own, edgeEvents.get(edgeKey(a, loop[(i + 1) % loop.length] as number)) ?? []);
    }
    pushAll(own, insideEvents.get(f) ?? []);
    if (own.length < 2) continue;
    own.sort((x, y) => x.param - y.param || x.id - y.id);
    const pairs = closed ? own.length : own.length - 1;
    for (let i = 0; i < pairs; i++) {
      const from = own[i] as CutEvent;
      const to = own[(i + 1) % own.length] as CutEvent;
      if (from.id === to.id) continue;
      if (from.kind === 'vertex' && to.kind === 'vertex') {
        const at = loop.indexOf(from.v);
        const next = loop[(at + 1) % loop.length];
        const prev = loop[(at + loop.length - 1) % loop.length];
        if (to.v === next || to.v === prev) {
          const mid = scale(add(mesh.position(from.v), mesh.position(to.v)), 0.5);
          pieces.push({ face: f, from, to, mid, along: [from.v, to.v] });
          continue;
        }
      }
      const end = to.param > from.param ? to.param : to.param + m;
      const [segment, x] = segmentAt((from.param + end) / 2);
      const polygon = loop.map((v) => to2(segment, mesh.position(v)));
      if (!insidePolygon([x, 0], polygon, tolerance)) continue;
      const lifted = liftOnto(mesh, f, segment, [x, 0]);
      if (lifted === undefined) continue;
      pieces.push({ face: f, from, to, mid: lifted.point });
    }
  }

  // Keep the cut layer: the visible one for a knife project, the surface the path
  // lies on for a surface path (pieces connected to the path corners).
  let kept = pieces;
  if (options.direction !== undefined && options.through !== true) {
    const toward = scale(normalize(options.direction), -1);
    const view = normalize(options.direction);
    kept = pieces.filter(
      (piece) =>
        facesViewer(mesh, piece.face, view) &&
        !surface.value.occluded(piece.mid, toward, piece.face),
    );
  } else if (options.direction === undefined) {
    const byEvent = new Map<number, number[]>();
    for (const [i, piece] of pieces.entries()) {
      for (const e of [piece.from, piece.to])
        pushTo(byEvent as Map<number, never[]>, e.id, i as never);
    }
    const reached = new Set<number>();
    const queue: number[] = [];
    const corners = new Set(cornerFaces);
    for (const [i, piece] of pieces.entries()) {
      if (
        corners.has(piece.face) ||
        cornerEvents.has(piece.from.id) ||
        cornerEvents.has(piece.to.id)
      ) {
        reached.add(i);
        queue.push(i);
      }
    }
    while (queue.length > 0) {
      const i = queue.shift() as number;
      const piece = pieces[i] as Piece;
      for (const e of [piece.from, piece.to]) {
        for (const j of byEvent.get(e.id) ?? []) {
          if (reached.has(j)) continue;
          reached.add(j);
          queue.push(j);
        }
      }
    }
    kept = pieces.filter((_, i) => reached.has(i));
  }

  const alongEdges = [
    ...new Map(
      kept.flatMap((p) => (p.along === undefined ? [] : [[edgeKey(...p.along), p.along] as const])),
    ).values(),
  ].map(([a, b]) => [a, b] as [number, number]);
  const layerVertices = new Set<number>();
  for (const p of kept) for (const v of mesh.faceVertices(p.face)) layerVertices.add(v);
  kept = kept.filter((p) => p.along === undefined);
  // Chains per face: pieces joined through the path corners inside it.
  const chainsOf = new Map<number, CutEvent[][]>();
  let trimmed = 0;
  const byFace = new Map<number, Piece[]>();
  for (const piece of kept) {
    const list = byFace.get(piece.face);
    if (list === undefined) byFace.set(piece.face, [piece]);
    else list.push(piece);
  }
  for (const [f, list] of byFace) {
    const next = new Map<number, Piece>();
    const hasPrevious = new Set<number>();
    for (const piece of list) {
      next.set(piece.from.id, piece);
      hasPrevious.add(piece.to.id);
    }
    const chains: CutEvent[][] = [];
    const used = new Set<Piece>();
    const starts = list.filter((p) => p.from.kind !== 'inside' || !hasPrevious.has(p.from.id));
    for (const start of [...starts, ...list]) {
      if (used.has(start)) continue;
      const chain: CutEvent[] = [start.from];
      let piece: Piece | undefined = start;
      while (piece !== undefined && !used.has(piece)) {
        used.add(piece);
        chain.push(piece.to);
        piece = piece.to.kind === 'inside' ? next.get(piece.to.id) : undefined;
      }
      const first = chain[0] as CutEvent;
      const last = chain[chain.length - 1] as CutEvent;
      if (first.kind === 'inside' || last.kind === 'inside' || first.id === last.id) {
        trimmed++;
        continue;
      }
      chains.push(chain);
    }
    if (chains.length > 0) chainsOf.set(f, chains);
  }
  if (chainsOf.size === 0 && alongEdges.length === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'the knife path crosses at least one face from edge to edge',
        { points: n, pieces: pieces.length, kept: kept.length, trimmed },
        options.direction === undefined
          ? 'put the path points on the surface to cut, at least one face apart'
          : 'check the direction (from the viewer into the scene) and that the path covers the faces, or pass through: true',
      ),
    );
  }

  // Vertices for the used edge crossings and corners.
  const vertexOf = new Map<number, number>();
  const parent = new Map<number, readonly [number, number]>();
  const edgePoints = new Map<number, { t: number; v: number }[]>();
  for (const chains of chainsOf.values()) {
    for (const chain of chains) {
      for (const e of chain) {
        if (vertexOf.has(e.id)) continue;
        if (e.kind === 'vertex') vertexOf.set(e.id, e.v);
        else {
          const v = mesh.addVertex(...e.point);
          vertexOf.set(e.id, v);
          if (e.kind === 'edge') {
            parent.set(v, [e.a, e.b]);
            pushTo(edgePoints as Map<number, never[]>, edgeKey(e.a, e.b), { t: e.t, v } as never);
          }
        }
      }
    }
  }
  const affected = new Set<number>(chainsOf.keys());
  for (const key of edgePoints.keys()) {
    const [a, b] = edges.get(key) as [number, number];
    for (const h of [mesh.findHalf(a, b), mesh.findHalf(b, a)]) {
      if (h !== NONE && (mesh.hFace[h] as number) !== NONE) affected.add(mesh.hFace[h] as number);
    }
  }

  const rewrites: { face: number; loops: CornerSource[][] }[] = [];
  const cutPairs: [number, number][] = [];
  const leftOf = new Set<number>();
  const rightOf = new Set<number>();
  for (const f of [...affected].sort((x, y) => x - y)) {
    const loop: CornerSource[] = [];
    for (const h of mesh.faceHalves(f)) {
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      loop.push({ v: a, corner: h });
      const inserted = [...(edgePoints.get(edgeKey(a, b)) ?? [])]
        .map(({ t, v }) => ({ t: a < b ? t : 1 - t, v }))
        .sort((x, y) => x.t - y.t);
      for (const { t, v } of inserted) {
        loop.push({ v, from: h, to: mesh.hNext[h] as number, t });
      }
    }
    let polygons: CornerSource[][] = [loop];
    const normal = normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v))));
    const basisU = normalize(
      Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]),
    );
    const basisV = cross(normal, basisU);
    const plane = (p: Tuple3): Point2 => [dot(p, basisU), dot(p, basisV)];
    const positionOf = (c: CornerSource): Tuple3 => mesh.position(c.v);
    for (const chain of chainsOf.get(f) ?? []) {
      const start = vertexOf.get((chain[0] as CutEvent).id) as number;
      const end = vertexOf.get((chain[chain.length - 1] as CutEvent).id) as number;
      if (start === end) {
        return err(
          modelingError(
            'model-degenerate',
            'a knife chain inside a face ends on another vertex than it starts',
            { face: f, vertex: start },
            'two crossings snapped onto one vertex: lower snap',
          ),
        );
      }
      const interior: CornerSource[] = chain.slice(1, -1).map((e) => ({
        v: vertexOf.get(e.id) as number,
        weights: (e as Extract<CutEvent, { kind: 'inside' }>).weights,
      }));
      const firstStep = interior[0]?.v ?? end;
      const probe = scale(add(mesh.position(start), mesh.position(firstStep)), 0.5);
      const candidates = polygons
        .map((polygon, index) => ({ polygon, index }))
        .filter(
          ({ polygon }) => polygon.some((c) => c.v === start) && polygon.some((c) => c.v === end),
        );
      const target =
        candidates.length <= 1
          ? candidates[0]
          : candidates.find(({ polygon }) =>
              insidePolygon(
                plane(probe),
                polygon.map((c) => plane(positionOf(c))),
                0,
              ),
            );
      if (target === undefined) {
        return err(
          modelingError(
            'model-precondition',
            'knife paths do not cross each other inside a face',
            { face: f, point: probe },
            'split the path where it crosses itself, or cut the crossing strokes in separate calls',
          ),
        );
      }
      const polygon = target.polygon;
      const ia = polygon.findIndex((c) => c.v === start);
      const ib = polygon.findIndex((c) => c.v === end);
      const steps = [start, ...interior.map((c) => c.v), end];
      for (let i = 0; i + 1 < steps.length; i++)
        cutPairs.push([steps[i] as number, steps[i + 1] as number]);
      const adjacent =
        polygon[(ia + 1) % polygon.length]?.v === end ||
        polygon[(ib + 1) % polygon.length]?.v === start;
      if (interior.length === 0 && adjacent) continue;
      const walk = (from: number, to: number) => {
        const out: CornerSource[] = [];
        for (let i = from; ; i = (i + 1) % polygon.length) {
          out.push(polygon[i] as CornerSource);
          if (i === to) break;
        }
        return out;
      };
      // Left of the chain (a -> b): the boundary from b back to a, then the chain.
      const right = [...walk(ia, ib), ...[...interior].reverse()];
      const left = [...walk(ib, ia), ...interior];
      polygons = [
        ...polygons.slice(0, target.index),
        right,
        left,
        ...polygons.slice(target.index + 1),
      ];
    }
    rewrites.push({ face: f, loops: polygons });
  }
  const created = rewriteFaces(mesh, rewrites, parent);
  if (!created.ok) return created;
  // One pair per cut edge, oriented along the path (the leftOf/rightOf sides below).
  const oriented = new Map<number, [number, number]>();
  for (const pair of [
    ...followedEdges(mesh, events, layerVertices, vertexOf, closed, m, segmentAt, snapOf),
    ...cutPairs,
  ]) {
    const key = edgeKey(...pair);
    if (!oriented.has(key)) oriented.set(key, pair);
  }
  replaceAll(cutPairs, oriented.values());
  // The face that runs along a cut edge in the path direction lies left of the path.
  const cutKeys = new Set(cutPairs.map(([a, b]) => edgeKey(a, b)));
  for (const [a, b] of cutPairs) {
    for (const [h, side] of [
      [mesh.findHalf(a, b), leftOf],
      [mesh.findHalf(b, a), rightOf],
    ] as const) {
      if (h !== NONE && (mesh.hFace[h] as number) !== NONE) side.add(mesh.hFace[h] as number);
    }
  }
  const flags = (options.sharp === true ? EDGE_SHARP : 0) | (options.seam === true ? EDGE_SEAM : 0);
  if (flags !== 0) {
    for (const [a, b] of cutPairs) {
      const h = mesh.findHalf(a, b);
      if (h !== NONE) mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, flags);
    }
  }

  const counts: RoleCounts = {};
  let inside: number[] = [];
  if (closed) {
    const seeds = [...new Set([...created.value.flat(), ...leftOf, ...rightOf])];
    const region = enclosed(
      mesh,
      scopeSet,
      seeds,
      cutKeys,
      leftOf,
      rightOf,
      options,
      path,
      diagnostics,
    );
    if (region.ok) inside = region.value;
    else diagnostics.push(region.error);
    if (inside.length > 0) {
      markRole(mesh, inside, label, 'inside', counts);
      if (tag >= 0) for (const f of inside) mesh.addTag(f, tag);
    }
  }
  diagnostics.push({
    severity: 'info',
    message: `knife cut ${chainsOf.size} faces along ${cutPairs.length} edges`,
    detail: {
      faces: chainsOf.size,
      crossings: [...edgePoints.values()].reduce((s, l) => s + l.length, 0),
      cutEdges: cutPairs.length,
      trimmed,
      ...(closed ? { inside: inside.length } : {}),
    },
  });
  if (trimmed > 0) {
    diagnostics.push({
      severity: 'info',
      message: `${trimmed} knife piece(s) ending inside a face were trimmed to its boundary`,
      detail: { trimmed },
    });
  }
  return ok({ ...counts, cut: chainsOf.size });
}

/** The face turns toward a viewer looking along `view`; edge-on faces do not. */
function facesViewer(mesh: EditMesh, f: number, view: Tuple3): boolean {
  return dot(normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v)))), view) < -1e-6;
}

/**
 * Existing edges the path runs along, oriented by the path: consecutive cut vertices on
 * the kept layer (in path order) that an edge joins, with the edge on the path's curtain.
 * This covers whole edges between existing vertices and the parts of edges between a
 * vertex and a crossing inserted on the same edge.
 */
function followedEdges(
  mesh: EditMesh,
  events: readonly CutEvent[],
  layer: ReadonlySet<number>,
  vertexOf: ReadonlyMap<number, number>,
  closed: boolean,
  m: number,
  segmentAt: (param: number) => [Segment, number],
  snapOf: (edgeLength: number) => number,
): [number, number][] {
  const stops: { param: number; id: number; v: number }[] = [];
  for (const e of events) {
    const v = e.kind === 'vertex' ? e.v : vertexOf.get(e.id);
    if (v === undefined || (e.kind === 'vertex' && !layer.has(v))) continue;
    stops.push({ param: e.param, id: e.id, v });
  }
  stops.sort((x, y) => x.param - y.param || x.id - y.id);
  const out = new Map<number, [number, number]>();
  const pairs = closed ? stops.length : stops.length - 1;
  for (let i = 0; i < pairs && stops.length > 1; i++) {
    const from = stops[i] as (typeof stops)[number];
    const to = stops[(i + 1) % stops.length] as (typeof stops)[number];
    if (from.v === to.v) continue;
    if (mesh.findHalf(from.v, to.v) === NONE && mesh.findHalf(to.v, from.v) === NONE) continue;
    const end = to.param >= from.param ? to.param : to.param + m;
    const [segment] = segmentAt((from.param + end) / 2);
    const pa = mesh.position(from.v);
    const pb = mesh.position(to.v);
    const [, w] = to2(segment, scale(add(pa, pb), 0.5));
    if (Math.abs(w) > snapOf(length(sub(pb, pa)))) continue;
    const key = edgeKey(from.v, to.v);
    if (!out.has(key)) out.set(key, [from.v, to.v]);
  }
  return [...out.values()];
}

/**
 * Faces enclosed by a closed cut: a knife project takes the faces reached from the cut
 * without crossing it whose centroid projects inside the path; a surface path takes
 * the faces left of it (counter-clockwise seen from outside), and reports a cut that
 * does not separate them.
 */
function enclosed(
  mesh: EditMesh,
  scope: ReadonlySet<number>,
  created: readonly number[],
  cut: ReadonlySet<number>,
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
  options: KnifeOptions,
  path: readonly Tuple3[],
  diagnostics: OpDiagnostic[],
): Result<number[], OpDiagnostic> {
  const neighbours = (f: number): number[] => {
    const out: number[] = [];
    for (const h of mesh.faceHalves(f)) {
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      if (cut.has(edgeKey(a, b))) continue;
      const g = mesh.hFace[h ^ 1] as number;
      if (g !== NONE) out.push(g);
    }
    return out;
  };
  const live = new Set([...scope].filter((f) => mesh.isFaceAlive(f)));
  for (const f of created) live.add(f);
  const flood = (seeds: readonly number[], admit: (f: number) => boolean) => {
    const seen = new Set<number>();
    const queue = seeds.filter((f) => admit(f));
    for (const f of queue) seen.add(f);
    while (queue.length > 0) {
      const f = queue.shift() as number;
      for (const g of neighbours(f)) {
        if (seen.has(g) || !live.has(g) || !admit(g)) continue;
        seen.add(g);
        queue.push(g);
      }
    }
    return [...seen].sort((a, b) => a - b);
  };
  if (options.direction !== undefined) {
    const d = normalize(options.direction);
    const u = normalize(Math.abs(d[0]) < 0.9 ? cross(d, [1, 0, 0]) : cross(d, [0, 1, 0]));
    const v = cross(d, u);
    const outline = path.map((p) => [dot(p, u), dot(p, v)] as Point2);
    // Without `through` only the visible layer is cut: faces seen edge-on or from behind
    // (across a silhouette or panel boundary the outline overhangs) stay outside.
    const facing = (f: number) => options.through === true || facesViewer(mesh, f, d);
    const within = (f: number) => {
      const c = faceCentroid(mesh, f);
      return facing(f) && insidePolygon([dot(c, u), dot(c, v)], outline, 0);
    };
    return ok(flood(created, within));
  }
  const region = flood([...left], () => true);
  const leak = region.filter((f) => right.has(f));
  if (leak.length > 0) {
    return err({
      severity: 'warn',
      message: 'the closed knife path does not separate its inside from the rest; no inside role',
      detail: { faces: leak.slice(0, MAX_REPORTED) },
    });
  }
  const outside = flood([...right], () => true);
  if (region.length > outside.length) {
    diagnostics.push({
      severity: 'warn',
      message: `the inside (left of the path, counter-clockwise seen from outside) has more faces than the other side (${region.length} > ${outside.length}); reverse the points to take the other side`,
      detail: { inside: region.length, outside: outside.length },
    });
  }
  return ok(region);
}
