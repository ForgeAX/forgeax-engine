import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import type { ModelingError } from '../errors';
import { edgeUses } from './adjacency';
import { curvePoint, pcurvePoint } from './curves';
import { mergeEdges, mergeFaces } from './edit';
import { measure } from './measure';
import {
  compact,
  composeProvenance,
  draftOf,
  draftUses,
  type EditResult,
  type Provenance,
} from './rebuild';
import { structureError } from './structure';
import { surfacePoint } from './surfaces';
import { TOL_FLOOR } from './tolerance';
import {
  brepError,
  type Coedge,
  type Curve,
  type Edge,
  type Face,
  type Loop,
  type Shape,
  type Surface,
} from './types';
import { type BrepIssue, validate } from './validate';
import { dist3, type P3 } from './vec';

export interface HealOptions {
  /**
   * Vertices closer than this are one vertex, edges shorter than this and faces thinner than this are slivers,
   * and unsewn edges closer than this are one edge; default `shape.maxTol`, the largest tolerance a Shape allows.
   */
  readonly tol?: number;
}

export type Defect =
  /** Two vertices that no edge joins, closer than `tol`. */
  | {
      readonly kind: 'duplicate-vertex';
      readonly vertices: readonly [number, number];
      readonly distance: number;
    }
  /** An edge's curve ends farther from its vertex than `max(vertex.tol, edge.tol)`. */
  | {
      readonly kind: 'vertex-gap';
      readonly vertex: number;
      readonly edge: number;
      readonly gap: number;
    }
  /** An edge's curve leaves its face surface by more than `max(edge.tol, shape.tol)` along a coedge. */
  | { readonly kind: 'edge-gap'; readonly edge: number; readonly gap: number }
  /** A non-degenerate edge used by one face. */
  | { readonly kind: 'free-edge'; readonly edge: number }
  | { readonly kind: 'sliver-edge'; readonly edge: number; readonly length: number }
  /** `width = 2 area / perimeter`. */
  | { readonly kind: 'sliver-face'; readonly face: number; readonly width: number };

export type DefectKind = Defect['kind'];

type DefectOf<K extends DefectKind> = Extract<Defect, { kind: K }>;

export type RepairKind =
  | 'merge-vertices'
  | 'raise-edge-tolerance'
  | 'fit-vertex'
  | 'sew-edges'
  | 'merge-sliver-face'
  | 'merge-sliver-edge';

/** One applied repair; ids are those of the input Shape, `at` is where it happened. */
export interface Repair {
  readonly kind: RepairKind;
  readonly at: P3;
  /** The gap, merge spread, sliver length or sliver width the repair removed or absorbed. */
  readonly amount: number;
  readonly vertices: readonly number[];
  readonly edges: readonly number[];
  readonly faces: readonly number[];
}

export interface Unrepaired {
  /** Ids of the healed Shape. */
  readonly defect: Defect;
  readonly reason: string;
}

export interface HealReport {
  /** Defects of the input Shape, by input ids. */
  readonly before: readonly Defect[];
  readonly repairs: readonly Repair[];
  readonly unrepaired: readonly Unrepaired[];
  readonly issuesBefore: readonly BrepIssue[];
  readonly issuesAfter: readonly BrepIssue[];
  /** The healed Shape passes `validate`. */
  readonly valid: boolean;
  /** Checks that could not run (a sliver-face check needs measurable faces). */
  readonly notes: readonly string[];
}

export interface HealResult extends EditResult {
  readonly report: HealReport;
}

const SAMPLES = 9;
const CHORDS = 16;

function edgeLength(shape: Shape, e: Edge): number {
  if (e.curve < 0) return 0;
  const c = shape.curves[e.curve] as Curve;
  let len = 0;
  let prev = curvePoint(c, e.t0);
  for (let k = 1; k <= CHORDS; k++) {
    const p = curvePoint(c, e.t0 + ((e.t1 - e.t0) * k) / CHORDS);
    len += dist3(prev, p);
    prev = p;
  }
  return len;
}

function mean(points: readonly P3[]): P3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/** Curve end points attached to each vertex, with the tolerance of the edge that owns the end. */
function endsByVertex(shape: Shape): { p: P3; edge: number; tol: number }[][] {
  const out = shape.vertices.map(() => [] as { p: P3; edge: number; tol: number }[]);
  shape.edges.forEach((e, i) => {
    if (e.curve < 0) return;
    const c = shape.curves[e.curve] as Curve;
    (out[e.v0] as { p: P3; edge: number; tol: number }[]).push({
      p: curvePoint(c, e.t0),
      edge: i,
      tol: e.tol,
    });
    (out[e.v1] as { p: P3; edge: number; tol: number }[]).push({
      p: curvePoint(c, e.t1),
      edge: i,
      tol: e.tol,
    });
  });
  return out;
}

function duplicatePairs(shape: Shape, tol: number): DefectOf<'duplicate-vertex'>[] {
  const joined = new Set<string>();
  for (const e of shape.edges) {
    if (e.curve >= 0 && e.v0 !== e.v1)
      joined.add(`${Math.min(e.v0, e.v1)}:${Math.max(e.v0, e.v1)}`);
  }
  const order = shape.vertices
    .map((_, i) => i)
    .sort((a, b) => vx(shape, a) - vx(shape, b) || a - b);
  const out: DefectOf<'duplicate-vertex'>[] = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i] as number;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j] as number;
      if (vx(shape, b) - vx(shape, a) > tol) break;
      const distance = dist3(vp(shape, a), vp(shape, b));
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (distance <= tol && !joined.has(`${lo}:${hi}`)) {
        out.push({ kind: 'duplicate-vertex', vertices: [lo, hi], distance });
      }
    }
  }
  return out.sort((p, q) => p.vertices[0] - q.vertices[0] || p.vertices[1] - q.vertices[1]);
}

function faceCoedges(shape: Shape, f: Face): Coedge[] {
  return f.loops.flatMap((l) =>
    (shape.loops[l] as Loop).coedges.map((c) => shape.coedges[c] as Coedge),
  );
}

function vp(shape: Shape, v: number): P3 {
  return (shape.vertices[v] as { p: P3 }).p;
}

function vx(shape: Shape, v: number): number {
  return vp(shape, v)[0];
}

function vertexGaps(shape: Shape): Defect[] {
  const out: Defect[] = [];
  const ends = endsByVertex(shape);
  shape.vertices.forEach((v, i) => {
    let worst: { edge: number; gap: number } | undefined;
    for (const end of ends[i] as { p: P3; edge: number; tol: number }[]) {
      const gap = dist3(end.p, v.p);
      if (gap > Math.max(v.tol, end.tol) && (worst === undefined || gap > worst.gap)) {
        worst = { edge: end.edge, gap };
      }
    }
    if (worst !== undefined) out.push({ kind: 'vertex-gap', vertex: i, ...worst });
  });
  return out;
}

function edgeGaps(shape: Shape): Defect[] {
  const worst = new Map<number, number>();
  for (const f of shape.faces) {
    const surface = shape.surfaces[f.surface] as Surface;
    for (const co of faceCoedges(shape, f)) {
      const e = shape.edges[co.edge] as Edge;
      let gap = 0;
      for (let k = 0; k <= SAMPLES; k++) {
        const t = e.t0 + ((e.t1 - e.t0) * k) / SAMPLES;
        const [u, v] = pcurvePoint(co.pcurve, t);
        const target =
          e.curve < 0 ? vp(shape, e.v0) : curvePoint(shape.curves[e.curve] as Curve, t);
        gap = Math.max(gap, dist3(surfacePoint(surface, u, v), target));
      }
      worst.set(co.edge, Math.max(worst.get(co.edge) ?? 0, gap));
    }
  }
  const out: Defect[] = [];
  for (const [edge, gap] of [...worst].sort((a, b) => a[0] - b[0])) {
    if (gap > Math.max((shape.edges[edge] as Edge).tol, shape.tol))
      out.push({ kind: 'edge-gap', edge, gap });
  }
  return out;
}

function freeEdges(shape: Shape): Defect[] {
  const out: Defect[] = [];
  edgeUses(shape).forEach((u, edge) => {
    if (u.length === 1 && (shape.edges[edge] as Edge).curve >= 0)
      out.push({ kind: 'free-edge', edge });
  });
  return out;
}

function sliverEdges(shape: Shape, tol: number): DefectOf<'sliver-edge'>[] {
  const out: DefectOf<'sliver-edge'>[] = [];
  shape.edges.forEach((e, edge) => {
    if (e.curve < 0 || e.v0 === e.v1) return;
    const length = edgeLength(shape, e);
    if (length < tol) out.push({ kind: 'sliver-edge', edge, length });
  });
  return out;
}

function sliverFaces(shape: Shape, tol: number): DefectOf<'sliver-face'>[] | undefined {
  const m = measure(shape);
  if (!m.ok) return undefined;
  const out: DefectOf<'sliver-face'>[] = [];
  shape.faces.forEach((f, face) => {
    let perimeter = 0;
    for (const co of faceCoedges(shape, f)) {
      perimeter += edgeLength(shape, shape.edges[co.edge] as Edge);
    }
    const area = (m.value.faces[face] as { area: number }).area;
    const width = perimeter > 0 ? (2 * area) / perimeter : 0;
    if (width < tol) out.push({ kind: 'sliver-face', face, width });
  });
  return out;
}

interface Found {
  readonly defects: Defect[];
  readonly skipped: boolean;
}

function scan(shape: Shape, tol: number): Found {
  const faces = sliverFaces(shape, tol);
  return {
    defects: [
      ...duplicatePairs(shape, tol),
      ...vertexGaps(shape),
      ...edgeGaps(shape),
      ...freeEdges(shape),
      ...sliverEdges(shape, tol),
      ...(faces ?? []),
    ],
    skipped: faces === undefined,
  };
}

function resolveTol(shape: Shape, options: HealOptions): Result<number, ModelingError> {
  const tol = options.tol ?? shape.maxTol;
  if (!Number.isFinite(tol) || tol < TOL_FLOOR) {
    return err(brepError('brep-bad-argument', 'finite tol >= 1e-9', { op: 'heal', tol }));
  }
  return ok(tol);
}

/** Every defect `heal` knows how to look for, by the ids of `shape`; throws nothing on a damaged Shape. */
export function findDefects(
  shape: Shape,
  options: HealOptions = {},
): Result<Defect[], ModelingError> {
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const tol = resolveTol(shape, options);
  return tol.ok ? ok(scan(shape, tol.value).defects) : tol;
}

// ---- repairs -------------------------------------------------------------------------------

interface State {
  shape: Shape;
  /** Current entities -> input entities. */
  cum: Provenance;
  readonly repairs: Repair[];
}

function input(ids: readonly (readonly number[])[], picked: readonly number[]): number[] {
  return [...new Set(picked.flatMap((i) => ids[i] ?? []))].sort((a, b) => a - b);
}

function record(
  s: State,
  kind: RepairKind,
  at: P3,
  amount: number,
  ids: { vertices?: number[]; edges?: number[]; faces?: number[] },
): void {
  s.repairs.push({
    kind,
    at,
    amount,
    vertices: input(s.cum.vertices, ids.vertices ?? []),
    edges: input(s.cum.edges, ids.edges ?? []),
    faces: input(s.cum.faces, ids.faces ?? []),
  });
}

function adopt(s: State, out: EditResult): void {
  s.shape = out.shape;
  s.cum = composeProvenance(s.cum, out.provenance);
}

function edgeMid(shape: Shape, edge: number): P3 {
  const e = shape.edges[edge] as Edge;
  return e.curve < 0
    ? (shape.vertices[e.v0] as { p: P3 }).p
    : curvePoint(shape.curves[e.curve] as Curve, 0.5 * (e.t0 + e.t1));
}

/** Rebuild without validating: a pass leaves a Shape that later passes and `validate` judge. */
function rebuild(s: State, d: ReturnType<typeof draftOf>): void {
  const out = compact(d);
  if (out.ok) adopt(s, out.value);
}

function raiseEdgeTolerance(s: State, nondegenerate: boolean): void {
  const d = draftOf(s.shape);
  let changed = false;
  for (const defect of edgeGaps(s.shape)) {
    if (defect.kind !== 'edge-gap' || defect.gap > s.shape.maxTol) continue;
    const e = s.shape.edges[defect.edge] as Edge;
    if (e.curve >= 0 !== nondegenerate) continue;
    d.edges[defect.edge] = { ...e, tol: defect.gap };
    record(s, 'raise-edge-tolerance', edgeMid(s.shape, defect.edge), defect.gap, {
      edges: [defect.edge],
    });
    changed = true;
  }
  if (changed) rebuild(s, d);
}

function find(parent: number[], x: number): number {
  let r = x;
  while (parent[r] !== r) r = parent[r] as number;
  for (let c = x; parent[c] !== r; ) {
    const next = parent[c] as number;
    parent[c] = r;
    c = next;
  }
  return r;
}

function mergeVertices(s: State, tol: number): void {
  const pairs = duplicatePairs(s.shape, tol);
  if (pairs.length === 0) return;
  const shape = s.shape;
  const parent = shape.vertices.map((_, i) => i);
  for (const p of pairs) {
    if (p.kind !== 'duplicate-vertex') continue;
    const a = find(parent, p.vertices[0]);
    const b = find(parent, p.vertices[1]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const clusters = new Map<number, number[]>();
  shape.vertices.forEach((_, v) => {
    const r = find(parent, v);
    clusters.set(r, [...(clusters.get(r) ?? []), v]);
  });
  const ends = endsByVertex(shape);
  const d = draftOf(shape);
  const redirect = new Map<number, number>();
  for (const [rep, members] of clusters) {
    if (members.length < 2) continue;
    const p = mean(members.map((m) => (shape.vertices[m] as { p: P3 }).p));
    let vtol = shape.tol;
    for (const m of members) {
      for (const end of ends[m] as { p: P3; tol: number }[]) {
        const gap = dist3(end.p, p);
        if (gap > end.tol) vtol = Math.max(vtol, gap);
      }
    }
    if (vtol > shape.maxTol) continue;
    const spread = maxOf(members.map((m) => dist3((shape.vertices[m] as { p: P3 }).p, p)));
    d.vertices[rep] = { p, tol: vtol };
    d.vertexFrom[rep] = [...new Set(members.flatMap((m) => d.vertexFrom[m] as number[]))].sort(
      (x, y) => x - y,
    );
    for (const m of members) if (m !== rep) redirect.set(m, rep);
    record(s, 'merge-vertices', p, spread, { vertices: members });
  }
  if (redirect.size === 0) return;
  d.edges = d.edges.map((e) => ({
    ...e,
    v0: redirect.get(e.v0) ?? e.v0,
    v1: redirect.get(e.v1) ?? e.v1,
  }));
  rebuild(s, d);
}

function fitVertices(s: State): void {
  const shape = s.shape;
  const ends = endsByVertex(shape);
  const d = draftOf(shape);
  let changed = false;
  for (const defect of vertexGaps(shape)) {
    if (defect.kind !== 'vertex-gap') continue;
    const at = (ends[defect.vertex] as { p: P3 }[]).map((end) => end.p);
    const p = mean(at);
    const spread = maxOf(at.map((q) => dist3(q, p)));
    const tol = Math.max(shape.tol, spread);
    if (tol > shape.maxTol) continue;
    d.vertices[defect.vertex] = { p, tol };
    record(s, 'fit-vertex', p, defect.gap, { vertices: [defect.vertex] });
    changed = true;
  }
  if (changed) rebuild(s, d);
}

/** Why two free edges cannot be sewn, or `undefined` when they can. */
function sewMismatch(shape: Shape, a: Edge, b: Edge, tol: number): { gap: number } | string {
  if (Math.abs(a.t0 - b.t0) > 1e-9 || Math.abs(a.t1 - b.t1) > 1e-9)
    return 'parameter-ranges-differ';
  let gap = 0;
  const ca = shape.curves[a.curve] as Curve;
  const cb = shape.curves[b.curve] as Curve;
  for (let k = 0; k <= SAMPLES; k++) {
    const t = a.t0 + ((a.t1 - a.t0) * k) / SAMPLES;
    gap = Math.max(gap, dist3(curvePoint(ca, t), curvePoint(cb, t)));
  }
  return gap <= tol ? { gap } : 'curves-differ';
}

function sewEdges(s: State, tol: number): void {
  const d = draftOf(s.shape);
  const uses = draftUses(d);
  const free = freeEdges(s.shape).flatMap((x) => (x.kind === 'free-edge' ? [x.edge] : []));
  const byKey = new Map<string, number[]>();
  for (const e of free) {
    const ed = s.shape.edges[e] as Edge;
    const key = `${ed.v0}:${ed.v1}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  let changed = false;
  for (const list of byKey.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const a = list[i] as number;
      const b = list[i + 1] as number;
      const ea = s.shape.edges[a] as Edge;
      const eb = s.shape.edges[b] as Edge;
      const ua = (uses.get(a) ?? [])[0];
      const ub = (uses.get(b) ?? [])[0];
      if (ua === undefined || ub === undefined) continue;
      const sense = (u: { coedge: number; face: number }) =>
        (d.coedges[u.coedge] as Coedge).reversed !== (d.faces[u.face] as Face).reversed;
      const match = sewMismatch(s.shape, ea, eb, tol);
      if (typeof match === 'string' || sense(ua) === sense(ub)) continue;
      d.coedges[ub.coedge] = { ...(d.coedges[ub.coedge] as Coedge), edge: a };
      d.edges[a] = { ...ea, tol: Math.max(ea.tol, eb.tol, match.gap) };
      d.edgeFrom[a] = [
        ...new Set([...(d.edgeFrom[a] as number[]), ...(d.edgeFrom[b] as number[])]),
      ].sort((x, y) => x - y);
      record(s, 'sew-edges', edgeMid(s.shape, a), match.gap, { edges: [a, b] });
      changed = true;
    }
  }
  if (changed) rebuild(s, d);
}

function repairKey(s: State, defect: Defect): string {
  switch (defect.kind) {
    case 'sliver-face':
      return `f${(s.cum.faces[defect.face] ?? []).join(',')}`;
    case 'sliver-edge':
      return `e${(s.cum.edges[defect.edge] ?? []).join(',')}`;
    default:
      return '';
  }
}

/** The sliver face merged into the coplanar neighbour it shares most edges with; `false` when none merges. */
function mergeSliverFace(s: State, face: number, width: number): boolean {
  const uses = edgeUses(s.shape);
  const shared = new Map<number, number>();
  for (const list of uses) {
    if (list.length !== 2) continue;
    const [p, q] = list;
    if (p === undefined || q === undefined) continue;
    if (p.face === face && q.face !== face) shared.set(q.face, (shared.get(q.face) ?? 0) + 1);
    if (q.face === face && p.face !== face) shared.set(p.face, (shared.get(p.face) ?? 0) + 1);
  }
  const at = faceCenter(s.shape, face);
  for (const [other] of [...shared].sort((x, y) => y[1] - x[1] || x[0] - y[0])) {
    const out = mergeFaces(s.shape, face, other);
    if (!out.ok) continue;
    record(s, 'merge-sliver-face', at, width, { faces: [face, other] });
    adopt(s, out.value);
    return true;
  }
  return false;
}

function faceCenter(shape: Shape, face: number): P3 {
  const f = shape.faces[face] as Face;
  return mean(faceCoedges(shape, f).map((co) => vp(shape, (shape.edges[co.edge] as Edge).v0)));
}

/** The sliver edge joined with the one edge continuing it through a vertex nothing else touches. */
function mergeSliverEdge(s: State, edge: number, length: number): boolean {
  const shape = s.shape;
  const e = shape.edges[edge] as Edge;
  for (const v of [e.v0, e.v1]) {
    const others = shape.edges.flatMap((o, i) =>
      i !== edge && (o.v0 === v || o.v1 === v) ? [i] : [],
    );
    const other = others[0];
    if (others.length !== 1 || other === undefined) continue;
    const out = mergeEdges(shape, edge, other);
    if (!out.ok) continue;
    record(s, 'merge-sliver-edge', edgeMid(shape, edge), length, { edges: [edge, other] });
    adopt(s, out.value);
    return true;
  }
  return false;
}

function mergeSlivers(s: State, tol: number): void {
  const stuck = new Set<string>();
  for (let guard = 0; guard < 4 * (s.shape.faces.length + s.shape.edges.length) + 8; guard++) {
    const faces = (sliverFaces(s.shape, tol) ?? [])
      .filter((x) => !stuck.has(repairKey(s, x)))
      .sort((p, q) => (p as { width: number }).width - (q as { width: number }).width);
    const edges = sliverEdges(s.shape, tol)
      .filter((x) => !stuck.has(repairKey(s, x)))
      .sort((p, q) => (p as { length: number }).length - (q as { length: number }).length);
    const f = faces[0];
    if (f !== undefined && f.kind === 'sliver-face') {
      if (!mergeSliverFace(s, f.face, f.width)) stuck.add(repairKey(s, f));
      continue;
    }
    const e = edges[0];
    if (e === undefined || e.kind !== 'sliver-edge') return;
    if (!mergeSliverEdge(s, e.edge, e.length)) stuck.add(repairKey(s, e));
  }
}

function reasonFor(shape: Shape, defect: Defect): string {
  switch (defect.kind) {
    case 'duplicate-vertex':
      return 'vertex tolerance needed to cover the merged ends exceeds maxTol';
    case 'vertex-gap':
      return defect.gap > shape.maxTol
        ? 'gap exceeds maxTol'
        : 'incident curve ends disagree by more than maxTol';
    case 'edge-gap':
      return 'gap exceeds maxTol';
    case 'free-edge':
      return 'no free edge with the same vertices, parameter range, curve and opposite sense';
    case 'sliver-edge':
      return 'no neighbouring edge continues it through a vertex nothing else touches';
    case 'sliver-face':
      return 'no coplanar neighbour face to absorb it';
  }
}

/**
 * Repair what a damaged Shape can be repaired of within `tol`: duplicate vertices are merged, vertex and edge
 * gaps are closed by moving a vertex to its curve ends or raising a tolerance (never above `maxTol`), unsewn
 * coincident free edges are sewn, and sliver faces and edges are absorbed into a neighbour. Each repair is
 * listed; whatever no repair applies to is listed with its reason. The result is not guaranteed valid:
 * `report.valid` says whether it is. Healing a healthy Shape returns it unchanged.
 */
export function heal(shape: Shape, options: HealOptions = {}): Result<HealResult, ModelingError> {
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const resolved = resolveTol(shape, options);
  if (!resolved.ok) return resolved;
  const tol = resolved.value;
  const found = scan(shape, tol);
  const issuesBefore = validate(shape).issues;
  const s: State = {
    shape,
    cum: {
      faces: shape.faces.map((_, i) => [i]),
      edges: shape.edges.map((_, i) => [i]),
      vertices: shape.vertices.map((_, i) => [i]),
    },
    repairs: [],
  };
  if (found.defects.length > 0) {
    raiseEdgeTolerance(s, true);
    mergeVertices(s, tol);
    fitVertices(s);
    raiseEdgeTolerance(s, false);
    sewEdges(s, tol);
    mergeSlivers(s, tol);
  }
  const after = scan(s.shape, tol);
  const check = validate(s.shape);
  const notes =
    found.skipped || after.skipped ? ['sliver-face check skipped: faces are not measurable'] : [];
  return ok({
    shape: s.shape,
    provenance: s.cum,
    report: {
      before: found.defects,
      repairs: s.repairs,
      unrepaired: after.defects.map((defect) => ({ defect, reason: reasonFor(s.shape, defect) })),
      issuesBefore: issuesBefore,
      issuesAfter: check.issues,
      valid: check.ok,
      notes,
    },
  });
}
