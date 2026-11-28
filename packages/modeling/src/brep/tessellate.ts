import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, pushAll } from '../arrays';
import { atan2, cos, hypot3, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { EDGE_SHARP, EditMesh } from '../mesh';
import { type NurbsCurve, curvePoint as nurbsPoint } from '../nurbs';
import { triangulatePolygon } from '../polygon2d';
import { curvePoint, pcurvePoint } from './curves';
import { acos } from './dmath-acos';
import {
  coedgeEnds,
  faceLoops,
  type GridFace,
  type GridSide,
  gridOf,
  isTrimEligibleGridFailure,
  UV_TOL,
} from './faces';
import { tally } from './ops';
import { structureError } from './structure';
import { surfaceNormal, surfacePoint } from './surfaces';
import { type TrimRing, triangulateTrimmed } from './tessellate-trimmed';
import {
  brepError,
  brepFail,
  type Coedge,
  type Curve,
  type Edge,
  type Face,
  type Shape,
  type Surface,
  type Vertex,
} from './types';
import { dot3, type P2, type P3, sub3, TWO_PI, unit3 } from './vec';

/** How `uv0` is laid out: one metric chart per face, packed into the material zone cells. */
export interface UvOptions {
  /** Face role -> zone cell `[i, j]` (integers); a face whose role is absent lies in `[0, 0]`. */
  readonly zones?: Readonly<Record<string, readonly [number, number]>>;
  /** Clear border around every chart, in metres (default 1% of the largest chart side). */
  readonly gutter?: number;
}

export interface TessellateOptions {
  /** Largest turn between neighbouring samples of a curve or surface direction, in radians (default pi / 16). */
  readonly angle?: number;
  /** Largest sagitta, in metres on the surface, of any circular sample (default: none). */
  readonly chord?: number;
  /** Edges whose two face normals differ by more than this, in radians, are flagged `EDGE_SHARP` (default pi / 6). */
  readonly crease?: number;
  readonly uv?: UvOptions;
}

const DEFAULT_ANGLE = Math.PI / 16;
const DEFAULT_CREASE = Math.PI / 6;
const SLACK = 1e-9;

function fail<T>(why: string, ids: Record<string, unknown>): Result<T, ModelingError> {
  return err(brepError('brep-face-unsupported', why, ids));
}

/** Segments of an arc `span` wide at `radius`: the tighter of the angle bound and the chord (sagitta) bound. */
function arcSegments(
  radius: number,
  span: number,
  angle: number,
  chord: number | undefined,
  minimum: number,
): number {
  let n = Math.ceil(Math.abs(span) / angle - SLACK);
  if (chord !== undefined) {
    const e = chord / radius;
    if (e < 2) {
      const half = atan2(Math.sqrt(e * (2 - e)), 1 - e);
      n = Math.max(n, Math.ceil(Math.abs(span) / (2 * half) - SLACK));
    }
  }
  return Math.max(minimum, n);
}

function edgeRequirement(shape: Shape, e: Edge, angle: number, chord: number | undefined): number {
  const c = shape.curves[e.curve] as Curve;
  const span = e.t1 - e.t0;
  switch (c.kind) {
    case 'line':
      return 1;
    case 'circle':
      return arcSegments(c.radius, span, angle, chord, Math.abs(span) >= TWO_PI - SLACK ? 3 : 2);
    case 'ellipse':
      return arcSegments(
        Math.max(c.a, c.b),
        span,
        angle,
        chord,
        Math.abs(span) >= TWO_PI - SLACK ? 3 : 2,
      );
    case 'nurbs':
      return nurbsSegments(c.curve, e.t0, e.t1, angle, chord);
  }
}

const NURBS_PROBE = 64;

/**
 * Samples for a NURBS edge from a 64-chord probe polyline. Two quantities, two bounds: the angle
 * bound uses the TOTAL absolute turn over the edge (the sum of probe turns), the same quantity an
 * analytic arc's span divides by `angle`; the chord bound uses the LARGEST single probe turn as the
 * local curvature estimate, with the probe chord length as its segment length. Probing with 64 chords
 * is a bound, not an error estimate: it sets the sample density.
 */
function nurbsSegments(
  curve: NurbsCurve,
  t0: number,
  t1: number,
  angle: number,
  chord: number | undefined,
): number {
  const pts: P3[] = [];
  for (let k = 0; k <= NURBS_PROBE; k++) {
    pts.push(nurbsPoint(curve, t0 + ((t1 - t0) * k) / NURBS_PROBE));
  }
  let totalTurn = 0;
  let maxTurn = 0;
  let length = 0;
  for (let k = 1; k < NURBS_PROBE; k++) {
    const a = sub3(pts[k] as P3, pts[k - 1] as P3);
    const b = sub3(pts[k + 1] as P3, pts[k] as P3);
    const la = hypot3(a[0], a[1], a[2]);
    const lb = hypot3(b[0], b[1], b[2]);
    if (la > 0 && lb > 0) {
      const c = Math.min(1, Math.max(-1, dot3(a, b) / (la * lb)));
      const turnK = acos(c);
      totalTurn += turnK;
      maxTurn = Math.max(maxTurn, turnK);
    }
    length += la;
  }
  const last = sub3(pts[NURBS_PROBE] as P3, pts[NURBS_PROBE - 1] as P3);
  length += hypot3(last[0], last[1], last[2]);
  const byAngle = Math.ceil(totalTurn / angle - SLACK);
  // Sagitta of a chord h at curvature k is k h^2 / 8; with k = maxTurn / chord-length, N chords of
  // length L / N meet the bound when N >= L * sqrt(k / (8 chord)). A straight edge needs no more.
  const segment = length / NURBS_PROBE;
  const curvature = segment > 0 ? maxTurn / segment : 0;
  const byChord = chord === undefined ? 0 : Math.ceil(length * Math.sqrt(curvature / (8 * chord)));
  return Math.max(3, byAngle, byChord);
}

/**
 * A face's metric chart: parameters `(a, b)` map to `cell + (offset + (param - origin) * scale) / period`.
 * The scales are the first fundamental form at the face's parameter centre: exact on planes and cylinders, a mean on the rest.
 */
interface Chart {
  readonly a0: number;
  readonly b0: number;
  readonly su: number;
  readonly sv: number;
  width: number;
  height: number;
  cell: readonly [number, number];
  x: number;
  y: number;
}

function placeUv(chart: Chart, period: number, a: number, b: number): P2 {
  return [
    chart.cell[0] + (chart.x + (a - chart.a0) * chart.su) / period,
    chart.cell[1] + (chart.y + (b - chart.b0) * chart.sv) / period,
  ];
}

function planarBounds(shape: Shape, f: number): { a0: number; b0: number; a1: number; b1: number } {
  const box = { a0: Infinity, b0: Infinity, a1: -Infinity, b1: -Infinity };
  const take = (p: P2) => {
    box.a0 = Math.min(box.a0, p[0]);
    box.a1 = Math.max(box.a1, p[0]);
    box.b0 = Math.min(box.b0, p[1]);
    box.b1 = Math.max(box.b1, p[1]);
  };
  for (const c of faceLoops(shape, f).outer) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    const { start, end } = coedgeEnds(e, co);
    take(start);
    take(end);
    const pc = co.pcurve;
    if (pc.kind !== 'circle') continue;
    const x = [pc.dir * e.t0 + pc.phase, pc.dir * e.t1 + pc.phase];
    const lo = Math.min(x[0] as number, x[1] as number);
    const hi = Math.max(x[0] as number, x[1] as number);
    for (let k = Math.ceil((lo - SLACK) / (Math.PI / 2)); k * (Math.PI / 2) <= hi + SLACK; k++) {
      const a = k * (Math.PI / 2);
      take([pc.c[0] + pc.r * cos(a), pc.c[1] + pc.r * sin(a)]);
    }
  }
  return box;
}

function mean(lo: number, hi: number, antiderivative: (x: number) => number, at: number): number {
  return hi - lo > SLACK ? (antiderivative(hi) - antiderivative(lo)) / (hi - lo) : at;
}

/** Physical length per unit of (u, v) at the v range `[v0, v1]`; the metric a chart and a triangulation share. */
function uvScale(surface: Surface, v0: number, v1: number): { su: number; sv: number } {
  switch (surface.kind) {
    case 'plane':
    case 'nurbs':
      return { su: 1, sv: 1 };
    case 'cylinder':
      return { su: surface.radius, sv: 1 };
    case 'cone':
      return {
        su: surface.radius + (sin(surface.halfAngle) * (v0 + v1)) / 2,
        sv: 1,
      };
    case 'sphere':
      return {
        su: surface.radius * mean(v0, v1, sin, cos((v0 + v1) / 2)),
        sv: surface.radius,
      };
    case 'torus':
      return {
        su: surface.major + surface.minor * mean(v0, v1, sin, cos((v0 + v1) / 2)),
        sv: surface.minor,
      };
  }
}

function gridChart(surface: Surface, g: GridFace): Chart {
  const { su, sv } = uvScale(surface, g.v0, g.v1);
  const du = g.u1 - g.u0;
  const dv = g.v1 - g.v0;
  return {
    a0: g.u0,
    b0: g.v0,
    su,
    sv,
    width: du * su,
    height: dv * sv,
    cell: [0, 0],
    x: 0,
    y: 0,
  };
}

/** Shelf pack of `items` (sorted tall first) at the shelf width that makes the square side smallest. */
function shelfPack(items: readonly Chart[], gap: number): number {
  const sorted = items.slice().sort((p, q) => q.height - p.height || q.width - p.width);
  const area = sorted.reduce((s, c) => s + (c.width + gap) * (c.height + gap), 0);
  const widest = maxOf(sorted.map((c) => c.width));
  const run = (w: number, commit: boolean): number => {
    let x = 0;
    let y = 0;
    let row = 0;
    let used = 0;
    for (const c of sorted) {
      if (x > 0 && x + c.width > w) {
        y += row + gap;
        x = 0;
        row = 0;
      }
      if (commit) {
        c.x = x;
        c.y = y;
      }
      x += c.width + gap;
      used = Math.max(used, x - gap);
      row = Math.max(row, c.height);
    }
    return Math.max(used, y + row);
  };
  const root = Math.sqrt(area);
  let best = Infinity;
  let bestW = widest;
  for (const w of [widest, root, root * 1.25, root * 1.5, root * 2, root * 3, root * 4]) {
    const width = Math.max(w, widest);
    const side = run(width, false);
    if (side < best - SLACK) {
      best = side;
      bestW = width;
    }
  }
  return run(bestW, true);
}

function layoutCharts(
  shape: Shape,
  grids: ReadonlyMap<number, GridFace>,
  uv: UvSnapshot,
): Result<{ charts: Chart[]; period: number }, ModelingError> {
  const charts = shape.faces.map((face, f): Chart => {
    const g = grids.get(f);
    if (g !== undefined) return gridChart(shape.surfaces[face.surface] as Surface, g);
    const b = planarBounds(shape, f);
    const { su, sv } = uvScale(shape.surfaces[face.surface] as Surface, b.b0, b.b1);
    return {
      a0: b.a0,
      b0: b.b0,
      su,
      sv,
      width: (b.a1 - b.a0) * su,
      height: (b.b1 - b.b0) * sv,
      cell: [0, 0],
      x: 0,
      y: 0,
    };
  });
  const largest = maxOf(charts.map((c) => Math.max(c.width, c.height)));
  const gutter = uv.gutter ?? largest * 0.01;
  const byCell = new Map<string, Chart[]>();
  charts.forEach((c, f) => {
    const role = (shape.faces[f] as Face).role;
    const cell: readonly [number, number] = uv.zones.get(role) ?? [0, 0];
    c.cell = cell;
    const key = `${cell[0]},${cell[1]}`;
    byCell.set(key, [...(byCell.get(key) ?? []), c]);
  });
  let side = 0;
  for (const group of byCell.values()) side = Math.max(side, shelfPack(group, gutter));
  const period = side + gutter;
  for (const c of charts) {
    c.x += gutter / 2;
    c.y += gutter / 2;
  }
  if (!(largest / period >= MIN_UV_SPAN))
    return brepFail(
      'brep-bad-argument',
      `a uv gutter no larger than ${1 / MIN_UV_SPAN} times the largest chart (float32 uv0 collapses beyond)`,
      { gutter, largest },
    );
  return ok({ charts, period });
}

/** Smallest share of a cell the largest chart may span: below it float32 uv0 collapses the chart to zero area. */
export const MIN_UV_SPAN = 1e-6;

/** Largest zone cell magnitude: float32 uv0 keeps a texel apart up to here (the cap of `uv.fromPatch`). */
export const MAX_UV_CELL = 1024;

/** One validated read of the caller's `uv`: layout never touches the caller's object again. */
interface UvSnapshot {
  readonly zones: ReadonlyMap<string, readonly [number, number]>;
  readonly gutter: number | undefined;
}

function snapshotUv(uv: UvOptions | undefined): Result<UvSnapshot, ModelingError> {
  try {
    return readUv(uv === undefined ? {} : uv);
  } catch {
    return brepFail('brep-bad-argument', 'uv is readable (a property access threw)');
  }
}

function readUv(uv: UvOptions): Result<UvSnapshot, ModelingError> {
  if (typeof uv !== 'object' || uv === null || Array.isArray(uv))
    return brepFail('brep-bad-argument', 'uv is an object { zones?, gutter? }', { uv });
  const gutter = uv.gutter;
  const zones = uv.zones;
  if (gutter !== undefined && !(Number.isFinite(gutter) && gutter > 0))
    return brepFail('brep-bad-argument', 'uv.gutter is a finite number greater than 0', { gutter });
  const cells = new Map<string, readonly [number, number]>();
  if (zones === undefined) return ok({ zones: cells, gutter });
  if (typeof zones !== 'object' || zones === null || Array.isArray(zones))
    return brepFail('brep-bad-argument', 'uv.zones is an object mapping roles to cells', {
      zones,
    });
  for (const role of Object.keys(zones)) {
    const cell: unknown = zones[role];
    if (!Array.isArray(cell) || cell.length !== 2)
      return brepFail('brep-bad-argument', 'uv.zones maps a role to a cell [i, j] of integers', {
        role,
      });
    const i = cell[0];
    const j = cell[1];
    if (!Number.isInteger(i) || !Number.isInteger(j))
      return brepFail('brep-bad-argument', 'uv.zones maps a role to a cell [i, j] of integers', {
        role,
      });
    if (Math.abs(i) > MAX_UV_CELL || Math.abs(j) > MAX_UV_CELL)
      return brepFail(
        'brep-bad-argument',
        `uv.zones cells are within +-${MAX_UV_CELL} (float32 uv0 loses texels beyond)`,
        { role, cell: [i, j] },
      );
    cells.set(role, [i, j]);
  }
  return ok({ zones: cells, gutter });
}

class Groups {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(a: number): number {
    let r = a;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    let x = a;
    while (this.parent[x] !== r) {
      const next = this.parent[x] as number;
      this.parent[x] = r;
      x = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

interface Context {
  readonly shape: Shape;
  readonly mesh: EditMesh;
  readonly vertexMesh: Map<number, number>;
  readonly counts: number[];
  readonly samples: Map<number, number[]>;
  /** B-rep face of each mesh face, by mesh face id. */
  readonly owner: number[];
  readonly charts: readonly Chart[];
  readonly period: number;
}

function meshVertex(cx: Context, v: number): number {
  let m = cx.vertexMesh.get(v);
  if (m === undefined) {
    const p = (cx.shape.vertices[v] as Vertex).p;
    m = cx.mesh.addVertex(p[0], p[1], p[2]);
    cx.vertexMesh.set(v, m);
  }
  return m;
}

/** Mesh vertices of an edge's samples from `t0` to `t1`; every use of the edge shares them. */
function edgeSamples(cx: Context, ei: number): number[] {
  const known = cx.samples.get(ei);
  if (known !== undefined) return known;
  const e = cx.shape.edges[ei] as Edge;
  const n = cx.counts[ei] as number;
  const curve = cx.shape.curves[e.curve] as Curve;
  const out: number[] = [meshVertex(cx, e.v0)];
  for (let k = 1; k < n; k++) {
    const p = curvePoint(curve, e.t0 + ((e.t1 - e.t0) * k) / n);
    out.push(cx.mesh.addVertex(p[0], p[1], p[2]));
  }
  out.push(meshVertex(cx, e.v1));
  cx.samples.set(ei, out);
  return out;
}

function coedgeSamples(cx: Context, c: number): number[] {
  const co = cx.shape.coedges[c] as Coedge;
  const e = cx.shape.edges[co.edge] as Edge;
  if (e.curve < 0) return [meshVertex(cx, e.v0)];
  const s = edgeSamples(cx, co.edge);
  return co.reversed ? s.slice().reverse() : s.slice();
}

/** Samples along consecutive coedges, sharing each junction vertex once. */
function runSamples(cx: Context, coedges: readonly number[]): number[] {
  const out: number[] = [];
  for (const c of coedges) {
    const s = coedgeSamples(cx, c);
    out.push(...(out.length === 0 ? s : s.slice(1)));
  }
  return out;
}

function runCount(cx: Context, side: GridSide): number {
  let n = 0;
  for (const c of side.coedges) {
    const co = cx.shape.coedges[c] as Coedge;
    n += cx.counts[co.edge] as number;
  }
  return n;
}

/** Material slot 0 for faces without a role; a role may not reuse this name. */
const DEFAULT_SLOT = 'Default';

/**
 * Stamps label, role and material slot of Shape face `f` on mesh face `m`. A role is its material
 * slot: the slot index is the role's roleNames index, and materialNames[i] names that slot
 * (unassigned faces share slot 0, "Default").
 */
export function stampFaceNames(
  mesh: EditMesh,
  m: number,
  face: Face,
  f: number,
): Result<void, ModelingError> {
  if (face.role === DEFAULT_SLOT) {
    return err(
      brepError('brep-bad-argument', 'face role is not the reserved "Default" slot', { face: f }),
    );
  }
  mesh.fLabel[m] = mesh.nameIndex(mesh.labelNames, face.label);
  const role = mesh.nameIndex(mesh.roleNames, face.role);
  mesh.fRole[m] = role;
  mesh.fMaterial[m] = role;
  for (let s = mesh.materialNames.length; s <= role; s++) {
    mesh.materialNames.push(mesh.roleNames[s] as string);
  }
  return ok(undefined);
}

function finishFace(
  cx: Context,
  f: number,
  face: Face,
  loop: readonly number[],
  corners: readonly P2[],
): Result<number, ModelingError> {
  const ordered = face.reversed ? loop.slice().reverse() : loop.slice();
  const uv = face.reversed ? corners.slice().reverse() : corners.slice();
  const added = cx.mesh.addFace(ordered);
  if (!added.ok) {
    return fail('a face the mesh accepts', {
      face: f,
      reason: added.error.expected,
    });
  }
  const m = added.value;
  cx.owner[m] = f;
  const stamped = stampFaceNames(cx.mesh, m, face, f);
  if (!stamped.ok) return stamped;
  cx.mesh.faceHalves(m).forEach((h, k) => {
    cx.mesh.setCorner('uv0', h, uv[k] as P2);
  });
  return ok(m);
}

function planarFace(
  cx: Context,
  f: number,
  face: Face,
  surface: Extract<Surface, { kind: 'plane' }>,
): Result<void, ModelingError> {
  const { outer, holes } = faceLoops(cx.shape, f);
  const frame = surface.frame;
  const chart = cx.charts[f] as Chart;
  const loops = [outer, ...holes].map((coedges) => {
    const verts = runSamples(cx, coedges);
    verts.pop();
    return verts;
  });
  const toUv = (v: number): P2 => {
    const q = sub3(cx.mesh.position(v) as unknown as P3, frame.o);
    return placeUv(chart, cx.period, dot3(q, frame.x), dot3(q, frame.y));
  };
  const outline = loops[0] as number[];
  let convex = holes.length === 0;
  if (convex) {
    const pts = outline.map(toUv);
    for (let i = 0; i < pts.length && convex; i++) {
      const a = pts[i] as P2;
      const b = pts[(i + 1) % pts.length] as P2;
      const c = pts[(i + 2) % pts.length] as P2;
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -SLACK) convex = false;
    }
  }
  if (convex) {
    const r = finishFace(cx, f, face, outline, outline.map(toUv));
    return r.ok ? ok(undefined) : r;
  }
  const flat = loops.flat();
  const points = flat.map(toUv);
  const index: number[][] = [];
  let at = 0;
  for (const l of loops) {
    index.push(l.map((_, i) => at + i));
    at += l.length;
  }
  tally('triangulations');
  tally('triangulationPoints', points.length);
  const tris = triangulatePolygon(points, index[0] as number[], index.slice(1));
  if (!tris.ok)
    return fail('a triangulable planar face', {
      face: f,
      reason: tris.error.expected,
    });
  for (const t of tris.value) {
    const r = finishFace(
      cx,
      f,
      face,
      t.map((i) => flat[i] as number),
      t.map((i) => points[i] as P2),
    );
    if (!r.ok) return r;
  }
  return ok(undefined);
}

/** Upper bound on boundary plus interior points of one trimmed face. */
export const MAX_TRIM_POINTS = 4096;

/** Parameter-space samples of one coedge, aligned with `edgeSamples` (same count and order as 3D). */
function coedgeUvSamples(cx: Context, c: number, n: number): P2[] {
  const co = cx.shape.coedges[c] as Coedge;
  const e = cx.shape.edges[co.edge] as Edge;
  const out: P2[] = [];
  for (let k = 0; k <= n; k++) out.push(pcurvePoint(co.pcurve, e.t0 + ((e.t1 - e.t0) * k) / n));
  return co.reversed ? out.reverse() : out;
}

/**
 * The closed rings of a trimmed face: every point is a shared edge sample with its (u, v) image. A
 * pole (degenerate) coedge is subdivided in (u, v) so its triangles stay well shaped; every one of its
 * points is the pole vertex, and the triangles that collapse onto it are dropped later.
 */
function trimRings(cx: Context, f: number, angle: number): Result<TrimRing[], ModelingError> {
  const { outer, holes } = faceLoops(cx.shape, f);
  const rings: TrimRing[] = [];
  for (const coedges of [outer, ...holes]) {
    const ids: number[] = [];
    const uv: P2[] = [];
    for (const c of coedges) {
      const co = cx.shape.coedges[c] as Coedge;
      const e = cx.shape.edges[co.edge] as Edge;
      let m: number[];
      let q: P2[];
      if (e.curve < 0) {
        const { start, end } = coedgeEnds(e, co);
        const span = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
        const n = Math.max(1, Math.ceil(span / angle - SLACK));
        q = coedgeUvSamples(cx, c, n);
        const pole = meshVertex(cx, e.v0);
        m = q.map(() => pole);
      } else {
        m = coedgeSamples(cx, c);
        q = coedgeUvSamples(cx, c, cx.counts[co.edge] as number);
      }
      if (ids.length > 0) {
        const prev = uv[uv.length - 1] as P2;
        const head = q[0] as P2;
        if (Math.abs(prev[0] - head[0]) > UV_TOL || Math.abs(prev[1] - head[1]) > UV_TOL) {
          return fail('a trim loop closed in (u, v)', { face: f, coedge: c });
        }
      }
      pushAll(ids, ids.length === 0 ? m : m.slice(1));
      pushAll(uv, uv.length === 0 ? q : q.slice(1));
    }
    const first = uv[0] as P2;
    const last = uv[uv.length - 1] as P2;
    if (Math.abs(first[0] - last[0]) > UV_TOL || Math.abs(first[1] - last[1]) > UV_TOL) {
      return fail('a trim loop closed in (u, v)', { face: f });
    }
    ids.pop();
    uv.pop();
    rings.push({ ids, uv });
  }
  return ok(rings);
}

/**
 * A non-plane face whose trim is not a rectangle in (u, v), including NURBS faces, holes, seams and
 * poles: a constrained Delaunay triangulation over the shared edge samples (see tessellate-trimmed).
 */
function trimmedFace(
  cx: Context,
  f: number,
  face: Face,
  surface: Surface,
  angle: number,
  chord: number | undefined,
): Result<void, ModelingError> {
  const rings = trimRings(cx, f, angle);
  if (!rings.ok) return rings;
  const boundary = rings.value.reduce((n, r) => n + r.uv.length, 0);
  if (boundary > MAX_TRIM_POINTS) {
    return fail('a trimmed face within the point cap', {
      face: f,
      points: boundary,
      cap: MAX_TRIM_POINTS,
    });
  }
  tally('triangulations');
  const built = triangulateTrimmed(surface, rings.value, {
    angle,
    ...(chord === undefined ? {} : { chord }),
    maxPoints: MAX_TRIM_POINTS,
  });
  if (!built.ok) {
    return fail('a constrained triangulation of the trim', {
      face: f,
      ...built.error,
      cap: MAX_TRIM_POINTS,
    });
  }
  const { interior, triangles } = built.value;
  tally('triangulationPoints', boundary + interior.length);
  const ids = rings.value.flatMap((r) => r.ids);
  const uv = [...rings.value.flatMap((r) => r.uv), ...interior];
  for (const q of interior) {
    const p = surfacePoint(surface, q[0], q[1]);
    ids.push(cx.mesh.addVertex(p[0], p[1], p[2]));
  }
  const chart = cx.charts[f] as Chart;
  for (const t of triangles) {
    const m = t.map((i) => ids[i] as number);
    if (m[0] === m[1] || m[1] === m[2] || m[2] === m[0]) continue;
    const r = finishFace(
      cx,
      f,
      face,
      m,
      t.map((i) => placeUv(chart, cx.period, (uv[i] as P2)[0], (uv[i] as P2)[1])),
    );
    if (!r.ok) return r;
  }
  return ok(undefined);
}

function gridFace(
  cx: Context,
  f: number,
  face: Face,
  surface: Surface,
  g: GridFace,
  nu: number,
  nv: number,
): Result<void, ModelingError> {
  const pole = (side: GridSide): number | undefined =>
    side.degenerate ? (runSamples(cx, side.coedges)[0] as number) : undefined;
  const rail = (side: GridSide, count: number, why: string): Result<number[], ModelingError> => {
    const poleV = pole(side);
    if (poleV !== undefined) return ok(Array.from({ length: count + 1 }, () => poleV));
    const s = runSamples(cx, side.coedges);
    return s.length === count + 1
      ? ok(s)
      : fail(`matching ${why} sample counts`, {
          face: f,
          have: s.length - 1,
          want: count,
        });
  };
  const bottom = rail(g.bottom, nu, 'u');
  if (!bottom.ok) return bottom;
  const top = rail(g.top, nu, 'u');
  if (!top.ok) return top;
  const right = rail(g.right, nv, 'v');
  if (!right.ok) return right;
  const left = rail(g.left, nv, 'v');
  if (!left.ok) return left;
  const bottomRail = bottom.value;
  const topRail = top.value.slice().reverse();
  const rightRail = right.value;
  const leftRail = left.value.slice().reverse();
  const grid: number[][] = [];
  const chart = cx.charts[f] as Chart;
  const uAt = (i: number) => g.u0 + ((g.u1 - g.u0) * i) / nu;
  const vAt = (j: number) => g.v0 + ((g.v1 - g.v0) * j) / nv;
  for (let j = 0; j <= nv; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nu; i++) {
      if (j === 0) row.push(bottomRail[i] as number);
      else if (j === nv) row.push(topRail[i] as number);
      else if (i === 0) row.push(leftRail[j] as number);
      else if (i === nu) row.push(rightRail[j] as number);
      else {
        const p = surfacePoint(surface, uAt(i), vAt(j));
        row.push(cx.mesh.addVertex(p[0], p[1], p[2]));
      }
    }
    grid.push(row);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const corners: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const loop: number[] = [];
      const uv: P2[] = [];
      for (const [a, b] of corners) {
        const m = (grid[b] as number[])[a] as number;
        if (loop[loop.length - 1] === m) continue;
        loop.push(m);
        uv.push(placeUv(chart, cx.period, uAt(a), vAt(b)));
      }
      if (loop.length < 3) continue;
      const r = finishFace(cx, f, face, loop, uv);
      if (!r.ok) return r;
    }
  }
  return ok(undefined);
}

function resolveCounts(
  shape: Shape,
  angle: number,
  chord: number | undefined,
): Result<{ counts: number[]; grids: Map<number, GridFace> }, ModelingError> {
  const counts = shape.edges.map((e, i) => {
    if (e.curve < 0) return 0;
    const n = edgeRequirement(shape, e, angle, chord);
    return n === 0 ? -1 - i : n;
  });
  const bad = counts.findIndex((n) => n < 0);
  if (bad >= 0) return fail('a line, circle or ellipse edge', { edge: bad });
  const groups = new Groups(shape.edges.length);
  const grids = new Map<number, GridFace>();
  for (let f = 0; f < shape.faces.length; f++) {
    const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
    if (surface.kind === 'plane') continue;
    const grid = gridOf(shape, f);
    if (!grid.ok) {
      if (isTrimEligibleGridFailure(grid.error)) continue;
      return grid;
    }
    grids.set(f, grid.value);
    const g = grid.value;
    for (const [a, b] of [
      [g.bottom, g.top],
      [g.left, g.right],
    ] as const) {
      if (a.degenerate || b.degenerate) continue;
      if (a.coedges.length === 1 && b.coedges.length === 1) {
        groups.union(
          (shape.coedges[a.coedges[0] as number] as Coedge).edge,
          (shape.coedges[b.coedges[0] as number] as Coedge).edge,
        );
      }
    }
  }
  const best = new Map<number, number>();
  shape.edges.forEach((e, i) => {
    if (e.curve < 0) return;
    const r = groups.find(i);
    best.set(r, Math.max(best.get(r) ?? 0, counts[i] as number));
  });
  shape.edges.forEach((e, i) => {
    if (e.curve >= 0) counts[i] = best.get(groups.find(i)) as number;
  });
  for (const g of grids.values()) {
    for (const [a, b] of [
      [g.bottom, g.top],
      [g.left, g.right],
    ] as const) {
      if (a.degenerate || b.degenerate) continue;
      const split = a.coedges.length === 1 ? b : a;
      const single = split === a ? b : a;
      if (single.coedges.length !== 1 || split.coedges.length < 2) continue;
      const want = counts[(shape.coedges[single.coedges[0] as number] as Coedge).edge] as number;
      const arcs = split.coedges.map((c) => (shape.coedges[c] as Coedge).edge);
      const share = distributeSamples(
        want,
        arcs.map((e) => Math.abs((shape.edges[e] as Edge).t1 - (shape.edges[e] as Edge).t0)),
      );
      if (share === undefined) return fail('matching u sample counts', { want, have: arcs.length });
      arcs.forEach((e, k) => {
        counts[e] = share[k] as number;
      });
    }
  }
  return ok({ counts, grids });
}

/** Splits `total` samples over weighted arcs: each arc gets at least one, the sum is exact. */
function distributeSamples(total: number, weights: readonly number[]): number[] | undefined {
  if (total < weights.length) return undefined;
  const sum = weights.reduce((x, y) => x + y, 0);
  const share = weights.map((w) =>
    Math.max(1, Math.floor((total * (sum > 0 ? w : 1)) / (sum > 0 ? sum : weights.length))),
  );
  const order = weights
    .map((_, i) => i)
    .sort((x, y) => (weights[y] as number) - (weights[x] as number));
  let diff = total - share.reduce((x, y) => x + y, 0);
  for (let k = 0; diff !== 0; k = (k + 1) % order.length) {
    const i = order[k] as number;
    if (diff > 0) {
      share[i] = (share[i] as number) + 1;
      diff--;
    } else if ((share[i] as number) > 1) {
      share[i] = (share[i] as number) - 1;
      diff++;
    }
  }
  return share;
}

/** Flags mesh edges whose two face normals turn by more than `crease`; shared by tessellate and quadrangulate. */
export function flagCreases(
  shape: Shape,
  mesh: EditMesh,
  samples: ReadonlyMap<number, readonly number[]>,
  crease: number,
): void {
  const uses = new Map<number, { face: number; coedge: number }[]>();
  shape.faces.forEach((face: Face, f) => {
    for (const l of face.loops) {
      for (const c of (shape.loops[l] as Shape['loops'][number]).coedges) {
        const co = shape.coedges[c] as Coedge;
        const list = uses.get(co.edge) ?? [];
        list.push({ face: f, coedge: c });
        uses.set(co.edge, list);
      }
    }
  });
  const threshold = cos(crease);
  const normalOf = (use: { face: number; coedge: number }): P3 => {
    const co = shape.coedges[use.coedge] as Coedge;
    const face = shape.faces[use.face] as Face;
    const e = shape.edges[co.edge] as Edge;
    const { start, end } = coedgeEnds(e, co);
    const surface = shape.surfaces[face.surface] as Surface;
    const n = surfaceNormal(surface, (start[0] + end[0]) / 2, (start[1] + end[1]) / 2);
    return face.reversed ? [-n[0], -n[1], -n[2]] : n;
  };
  shape.edges.forEach((e: Edge, ei) => {
    const u = uses.get(ei);
    if (e.curve < 0 || u === undefined || u.length !== 2) return;
    const a = unit3(normalOf(u[0] as { face: number; coedge: number }));
    const b = unit3(normalOf(u[1] as { face: number; coedge: number }));
    if (dot3(a, b) >= threshold) return;
    const s = samples.get(ei) as readonly number[];
    for (let k = 0; k + 1 < s.length; k++) {
      const h = mesh.findHalf(s[k] as number, s[k + 1] as number);
      if (h >= 0) mesh.eFlags[h >> 1] = (mesh.eFlags[h >> 1] as number) | EDGE_SHARP;
    }
  });
}

/**
 * The single crossing from exact to mesh: every edge is sampled once and both of its uses reuse
 * those vertices, so the mesh is watertight by construction. Faces carry label and role; analytic
 * creases are `EDGE_SHARP`. `uv0` is a per-face parameter-space metric: each face is one chart in
 * metres (its surface (u, v) scaled by the first fundamental form at the face centre), shelf-packed
 * per zone cell and divided by one shared period. Charts never overlap and the layout depends only on
 * the Shape and `uv`, never on `angle` or `chord`. Texel density is constant on planes and cylinders;
 * on cones, spheres and tori the metric varies across the face and the density varies with it
 * (see reference/exact.md). A face's cell is `uv.zones[role]` (default [0, 0]).
 */
export function tessellate(
  shape: Shape,
  options: TessellateOptions = {},
): Result<EditMesh, ModelingError> {
  const sampled = tessellateSampled(shape, options);
  return sampled.ok ? ok(sampled.value.mesh) : sampled;
}

/** The mesh vertices sampled on each B-rep edge, in edge order from `t0` to `t1`; every use of an edge shares them. */
export interface SampledMesh {
  readonly mesh: EditMesh;
  readonly samples: ReadonlyMap<number, readonly number[]>;
  /** The B-rep face that produced each mesh face, by mesh face id. */
  readonly owner: readonly number[];
}

/** `tessellate` plus the per-edge sample ids, so a consumer can map B-rep edges to mesh edges. */
export function tessellateSampled(
  shape: Shape,
  options: TessellateOptions = {},
): Result<SampledMesh, ModelingError> {
  let rawAngle: number | undefined;
  let rawCrease: number | undefined;
  let chord: number | undefined;
  let uvOptions: UvOptions | undefined;
  try {
    ({ angle: rawAngle, crease: rawCrease, chord, uv: uvOptions } = options);
  } catch {
    return brepFail('brep-bad-argument', 'options are readable (a property access threw)');
  }
  const angle = rawAngle ?? DEFAULT_ANGLE;
  const crease = rawCrease ?? DEFAULT_CREASE;
  if (!Number.isFinite(angle) || angle <= 0 || angle > Math.PI) {
    return err(brepError('brep-bad-argument', 'angle in (0, pi]', { angle }));
  }
  if (chord !== undefined && !(Number.isFinite(chord) && chord > 0)) {
    return err(
      brepError('brep-bad-argument', 'chord is a finite number greater than 0', { chord }),
    );
  }
  if (!Number.isFinite(crease) || crease < 0 || crease > Math.PI) {
    return err(brepError('brep-bad-argument', 'crease in [0, pi]', { crease }));
  }
  const snapshot = snapshotUv(uvOptions);
  if (!snapshot.ok) return snapshot;
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const resolved = resolveCounts(shape, angle, chord);
  if (!resolved.ok) return resolved;
  const laid = layoutCharts(shape, resolved.value.grids, snapshot.value);
  if (!laid.ok) return laid;
  const cx: Context = {
    shape,
    mesh: new EditMesh(),
    vertexMesh: new Map(),
    counts: resolved.value.counts,
    samples: new Map(),
    owner: [],
    charts: laid.value.charts,
    period: laid.value.period,
  };
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Face;
    const surface = shape.surfaces[face.surface] as Surface;
    const g = resolved.value.grids.get(f);
    let r: Result<void, ModelingError>;
    if (g === undefined) {
      r =
        surface.kind === 'plane'
          ? planarFace(cx, f, face, surface)
          : trimmedFace(cx, f, face, surface, angle, chord);
    } else {
      const nuSide = g.bottom.degenerate ? g.top : g.bottom;
      if (nuSide.degenerate && surface.kind !== 'sphere')
        return fail('a non-degenerate u side', { face: f });
      const nu =
        nuSide.degenerate && surface.kind === 'sphere'
          ? arcSegments(surface.radius, g.u1 - g.u0, angle, chord, 3)
          : runCount(cx, nuSide);
      const nvSide = g.left.degenerate ? g.right : g.left;
      if (nvSide.degenerate) r = fail('a face with a non-degenerate v side', { face: f });
      else r = gridFace(cx, f, face, surface, g, nu, runCount(cx, nvSide));
    }
    if (!r.ok) return r;
  }
  flagCreases(shape, cx.mesh, cx.samples, crease);
  return ok({ mesh: cx.mesh, samples: cx.samples, owner: cx.owner });
}
