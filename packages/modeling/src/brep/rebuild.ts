import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import type { ModelingError } from '../errors';
import { shiftPCurve } from './curves';
import { coedgeEnds, coedgeGreen, UV_TOL } from './faces';
import { surfaceDomain } from './surfaces';
import {
  brepError,
  type Coedge,
  type Curve,
  deepFreeze,
  type Edge,
  type Face,
  type Shape,
  type Surface,
  type Vertex,
} from './types';
import { validate } from './validate';
import type { P2 } from './vec';

/** For every entity of an edited Shape, the ids in the input Shape it derives from (empty: created by the edit). */
export interface Provenance {
  readonly faces: readonly (readonly number[])[];
  readonly edges: readonly (readonly number[])[];
  readonly vertices: readonly (readonly number[])[];
}

export interface EditResult {
  readonly shape: Shape;
  readonly provenance: Provenance;
}

export interface DraftFace {
  surface: number;
  loops: number[];
  reversed: boolean;
  label: string;
  role: string;
}

/** A mutable copy of a Shape. Edits rewrite it freely; `finishDraft` compacts, freezes and validates. */
export interface Draft {
  readonly tol: number;
  readonly maxTol: number;
  vertices: Vertex[];
  curves: Curve[];
  surfaces: Surface[];
  edges: Edge[];
  coedges: Coedge[];
  loops: { coedges: number[]; outer: boolean }[];
  faces: DraftFace[];
  shells: number[][];
  vertexFrom: number[][];
  edgeFrom: number[][];
  faceFrom: number[][];
}

export function draftOf(shape: Shape): Draft {
  return {
    tol: shape.tol,
    maxTol: shape.maxTol,
    vertices: shape.vertices.slice(),
    curves: shape.curves.slice(),
    surfaces: shape.surfaces.slice(),
    edges: shape.edges.slice(),
    coedges: shape.coedges.slice(),
    loops: shape.loops.map((l) => ({ coedges: l.coedges.slice(), outer: l.outer })),
    faces: shape.faces.map((f) => ({ ...f, loops: f.loops.slice() })),
    shells: shape.shells.map((s) => s.faces.slice()),
    vertexFrom: shape.vertices.map((_, i) => [i]),
    edgeFrom: shape.edges.map((_, i) => [i]),
    faceFrom: shape.faces.map((_, i) => [i]),
  };
}

export interface DraftUse {
  readonly coedge: number;
  readonly face: number;
  readonly loop: number;
}

/** Per edge, the uses by faces that are still in a shell. */
export function draftUses(d: Draft): Map<number, DraftUse[]> {
  const out = new Map<number, DraftUse[]>();
  for (const face of liveFaces(d)) {
    for (const loop of (d.faces[face] as DraftFace).loops) {
      for (const coedge of (d.loops[loop] as { coedges: number[] }).coedges) {
        const e = (d.coedges[coedge] as Coedge).edge;
        const list = out.get(e);
        if (list === undefined) out.set(e, [{ coedge, face, loop }]);
        else list.push({ coedge, face, loop });
      }
    }
  }
  return out;
}

/** A copy a failed trial can write to without touching `d`; `commitDraft` adopts a successful one. */
export function forkDraft(d: Draft): Draft {
  return {
    tol: d.tol,
    maxTol: d.maxTol,
    vertices: d.vertices.slice(),
    curves: d.curves.slice(),
    surfaces: d.surfaces.slice(),
    edges: d.edges.slice(),
    coedges: d.coedges.slice(),
    loops: d.loops.map((l) => ({ coedges: l.coedges.slice(), outer: l.outer })),
    faces: d.faces.map((f) => ({ ...f, loops: f.loops.slice() })),
    shells: d.shells.map((s) => s.slice()),
    vertexFrom: d.vertexFrom.map((a) => a.slice()),
    edgeFrom: d.edgeFrom.map((a) => a.slice()),
    faceFrom: d.faceFrom.map((a) => a.slice()),
  };
}

export function commitDraft(d: Draft, fork: Draft): void {
  Object.assign(d, fork);
}

export function partial(op: string, reason: string, ids?: Record<string, unknown>): ModelingError {
  return brepError('brep-face-unsupported', 'an edit this module supports', { op, reason, ...ids });
}

export function badEdit(op: string, reason: string, ids?: Record<string, unknown>): ModelingError {
  return brepError('brep-bad-argument', 'a valid edit request', { op, reason, ...ids });
}

/** The faces still in a shell. */
export function liveFaces(d: Draft): number[] {
  const out: number[] = [];
  for (const s of d.shells) pushAll(out, s);
  return out.sort((a, b) => a - b);
}

export function startVertex(d: Draft, c: Coedge): number {
  const e = d.edges[c.edge] as Edge;
  return c.reversed ? e.v1 : e.v0;
}

export function endVertex(d: Draft, c: Coedge): number {
  const e = d.edges[c.edge] as Edge;
  return c.reversed ? e.v0 : e.v1;
}

export function uvEnds(d: Draft, c: Coedge): { start: P2; end: P2 } {
  return coedgeEnds(d.edges[c.edge] as Edge, c);
}

function near(a: P2, b: P2): boolean {
  return Math.abs(a[0] - b[0]) <= UV_TOL && Math.abs(a[1] - b[1]) <= UV_TOL;
}

function loopOpen(op: string, ids: Record<string, unknown>): ModelingError {
  return brepError('brep-loop-open', 'coedges that chain head to tail and close in (u, v)', {
    op,
    ...ids,
  });
}

/** The coedge moved by whole periods of the surface so it starts at `prevEnd`, or `undefined` when no shift does. */
function alignTo(d: Draft, surface: Surface, co: Coedge, prevEnd: P2): Coedge | undefined {
  const dom = surfaceDomain(surface);
  const s0 = uvEnds(d, co).start;
  const du = dom.uPeriod > 0 ? Math.round((prevEnd[0] - s0[0]) / dom.uPeriod) * dom.uPeriod : 0;
  const dv = dom.vPeriod > 0 ? Math.round((prevEnd[1] - s0[1]) / dom.vPeriod) * dom.vPeriod : 0;
  const shifted = du === 0 && dv === 0 ? co : { ...co, pcurve: shiftPCurve(co.pcurve, du, dv) };
  return near(uvEnds(d, shifted).start, prevEnd) ? shifted : undefined;
}

const SEARCH_BUDGET = 20000;

/**
 * Partition coedges into closed loops: each coedge starts at the vertex and (u, v) where the previous ends,
 * after moving it by whole periods of a periodic surface. Candidates are tried in the given order, so an
 * unambiguous set keeps its order. The shifted pcurves are written back to the draft.
 */
export function chainLoops(
  d: Draft,
  surface: Surface,
  ids: readonly number[],
  op: string,
): Result<number[][], ModelingError> {
  const placed = new Map<number, Coedge>();
  const used = new Set<number>();
  const loops: number[][] = [];
  let budget = SEARCH_BUDGET;
  for (const first of ids) {
    if (used.has(first)) continue;
    const path: number[] = [first];
    used.add(first);
    placed.set(first, d.coedges[first] as Coedge);
    const extend = (): boolean => {
      if (--budget < 0) return false;
      const last = placed.get(path[path.length - 1] as number) as Coedge;
      const head = placed.get(path[0] as number) as Coedge;
      const end = uvEnds(d, last).end;
      if (endVertex(d, last) === startVertex(d, head) && near(end, uvEnds(d, head).start)) {
        return true;
      }
      // A periodic corner joins many coedges at one vertex; trying the least-shifted one first keeps the natural loop.
      const options: { cand: number; shifted: Coedge; cost: number }[] = [];
      for (const cand of ids) {
        if (used.has(cand)) continue;
        const co = d.coedges[cand] as Coedge;
        if (startVertex(d, co) !== endVertex(d, last)) continue;
        const shifted = alignTo(d, surface, co, end);
        if (shifted === undefined) continue;
        const from = uvEnds(d, co).start;
        options.push({
          cand,
          shifted,
          cost: Math.abs(end[0] - from[0]) + Math.abs(end[1] - from[1]),
        });
      }
      options.sort((a, b) => a.cost - b.cost);
      for (const { cand, shifted } of options) {
        path.push(cand);
        used.add(cand);
        placed.set(cand, shifted);
        if (extend()) return true;
        path.pop();
        used.delete(cand);
        placed.delete(cand);
      }
      return false;
    };
    if (!extend()) return err(loopOpen(op, { coedge: first }));
    for (const c of path) d.coedges[c] = placed.get(c) as Coedge;
    placed.clear();
    loops.push(path);
  }
  return ok(loops);
}

/** Shift each coedge of a loop given in order by whole periods so it follows the previous one, and check it closes. */
export function alignOrdered(
  d: Draft,
  surface: Surface,
  ids: readonly number[],
  op: string,
): Result<number[], ModelingError> {
  const first = ids[0];
  if (first === undefined) return err(loopOpen(op, {}));
  let prevEnd = uvEnds(d, d.coedges[first] as Coedge).end;
  let prevVertex = endVertex(d, d.coedges[first] as Coedge);
  for (let k = 1; k < ids.length; k++) {
    const c = ids[k] as number;
    const co = d.coedges[c] as Coedge;
    const shifted =
      startVertex(d, co) === prevVertex ? alignTo(d, surface, co, prevEnd) : undefined;
    if (shifted === undefined) return err(loopOpen(op, { coedge: c }));
    d.coedges[c] = shifted;
    prevEnd = uvEnds(d, shifted).end;
    prevVertex = endVertex(d, shifted);
  }
  const head = d.coedges[first] as Coedge;
  if (prevVertex !== startVertex(d, head) || !near(prevEnd, uvEnds(d, head).start)) {
    return err(loopOpen(op, { coedge: first }));
  }
  return ok(ids.slice());
}

function minUv(d: Draft, ids: readonly number[]): P2 {
  let u = Infinity;
  let v = Infinity;
  for (const c of ids) {
    const s = uvEnds(d, d.coedges[c] as Coedge).start;
    u = Math.min(u, s[0]);
    v = Math.min(v, s[1]);
  }
  return [u, v];
}

function shiftLoop(d: Draft, ids: readonly number[], du: number, dv: number): void {
  if (du === 0 && dv === 0) return;
  for (const c of ids) {
    const co = d.coedges[c] as Coedge;
    d.coedges[c] = { ...co, pcurve: shiftPCurve(co.pcurve, du, dv) };
  }
}

/**
 * Give a face the closed loops `chains`: the one with positive (u, v) area is the outer loop, the rest are
 * holes. Periodic loops are shifted so the outer one starts in the first period and holes sit in its period.
 */
export function setFaceLoops(
  d: Draft,
  face: number,
  chains: readonly (readonly number[])[],
  op: string,
): Result<true, ModelingError> {
  const surface = d.surfaces[(d.faces[face] as DraftFace).surface] as Surface;
  const areas = chains.map((ids) =>
    ids.reduce((a, c) => {
      const co = d.coedges[c] as Coedge;
      return a + coedgeGreen(d.edges[co.edge] as Edge, co);
    }, 0),
  );
  const outerAt = areas.reduce((best, a, i) => (a > (areas[best] as number) ? i : best), 0);
  const positive = areas.filter((a) => a > 0).length;
  if (positive !== 1) {
    return err(
      brepError('brep-orientation', 'exactly one counter-clockwise outer loop', {
        op,
        face,
        outerLoops: positive,
      }),
    );
  }
  const dom = surfaceDomain(surface);
  const outer = chains[outerAt] as readonly number[];
  const base = minUv(d, outer);
  shiftLoop(
    d,
    outer,
    dom.uPeriod > 0 ? -Math.floor((base[0] + UV_TOL) / dom.uPeriod) * dom.uPeriod : 0,
    dom.vPeriod > 0 ? -Math.floor((base[1] + UV_TOL) / dom.vPeriod) * dom.vPeriod : 0,
  );
  const anchor = minUv(d, outer);
  const ordered = [outerAt, ...chains.map((_, i) => i).filter((i) => i !== outerAt)];
  const created: number[] = [];
  for (const i of ordered) {
    const ids = chains[i] as readonly number[];
    if (i !== outerAt) {
      const m = minUv(d, ids);
      shiftLoop(
        d,
        ids,
        dom.uPeriod > 0 ? -Math.floor((m[0] - anchor[0] + UV_TOL) / dom.uPeriod) * dom.uPeriod : 0,
        dom.vPeriod > 0 ? -Math.floor((m[1] - anchor[1] + UV_TOL) / dom.vPeriod) * dom.vPeriod : 0,
      );
    }
    d.loops.push({ coedges: ids.slice(), outer: i === outerAt });
    created.push(d.loops.length - 1);
  }
  (d.faces[face] as DraftFace).loops = created;
  return ok(true);
}

/** Drop every entity no shell reaches, renumber the rest in ascending order, freeze. */
export function compact(d: Draft): Result<EditResult, ModelingError> {
  const faces = liveFaces(d);
  const loopSet = new Set<number>();
  const coedgeSet = new Set<number>();
  const edgeSet = new Set<number>();
  const vertexSet = new Set<number>();
  const curveSet = new Set<number>();
  const surfaceSet = new Set<number>();
  for (const f of faces) {
    const face = d.faces[f] as DraftFace;
    surfaceSet.add(face.surface);
    for (const l of face.loops) {
      loopSet.add(l);
      for (const c of (d.loops[l] as { coedges: number[] }).coedges) {
        coedgeSet.add(c);
        const e = (d.coedges[c] as Coedge).edge;
        edgeSet.add(e);
        const edge = d.edges[e] as Edge;
        vertexSet.add(edge.v0);
        vertexSet.add(edge.v1);
        if (edge.curve >= 0) curveSet.add(edge.curve);
      }
    }
  }
  const order = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);
  const index = (ids: readonly number[]): Map<number, number> =>
    new Map(ids.map((id, i) => [id, i]));
  const vs = order(vertexSet);
  const cs = order(curveSet);
  const ss = order(surfaceSet);
  const es = order(edgeSet);
  const cos = order(coedgeSet);
  const ls = order(loopSet);
  const vi = index(vs);
  const ci = index(cs);
  const si = index(ss);
  const ei = index(es);
  const coi = index(cos);
  const li = index(ls);
  const fi = index(faces);
  const at = (m: ReadonlyMap<number, number>, k: number): number => m.get(k) as number;
  const shells = d.shells
    .map((s) => ({ faces: s.map((f) => at(fi, f)).sort((a, b) => a - b) }))
    .filter((s) => s.faces.length > 0);
  if (shells.length === 0) {
    return err(
      brepError('brep-bad-argument', 'an edit that leaves at least one face', { op: 'compact' }),
    );
  }
  const shape: Shape = deepFreeze({
    tol: d.tol,
    maxTol: d.maxTol,
    vertices: vs.map((v) => d.vertices[v] as Vertex),
    curves: cs.map((c) => d.curves[c] as Curve),
    surfaces: ss.map((s) => d.surfaces[s] as Surface),
    edges: es.map((e): Edge => {
      const edge = d.edges[e] as Edge;
      return {
        ...edge,
        curve: edge.curve < 0 ? -1 : at(ci, edge.curve),
        v0: at(vi, edge.v0),
        v1: at(vi, edge.v1),
      };
    }),
    coedges: cos.map((c): Coedge => {
      const co = d.coedges[c] as Coedge;
      return { ...co, edge: at(ei, co.edge) };
    }),
    loops: ls.map((l) => {
      const loop = d.loops[l] as { coedges: number[]; outer: boolean };
      return { coedges: loop.coedges.map((c) => at(coi, c)), outer: loop.outer };
    }),
    faces: faces.map((f): Face => {
      const face = d.faces[f] as DraftFace;
      return { ...face, surface: at(si, face.surface), loops: face.loops.map((l) => at(li, l)) };
    }),
    shells,
  });
  return ok({
    shape,
    provenance: {
      faces: faces.map((f) => (d.faceFrom[f] as number[]).slice()),
      edges: es.map((e) => (d.edgeFrom[e] as number[]).slice()),
      vertices: vs.map((v) => (d.vertexFrom[v] as number[]).slice()),
    },
  });
}

/** Issues that only say a shell is open: an edge used by a single face. */
function nonOpenIssues(shape: Shape) {
  return validate(shape).issues.filter((i) => !(i.code === 'brep-edge-use' && i.ids.uses === 1));
}

/** True when `shape` validates except for free boundary edges; the error names the first other issue. */
export function checkEditable(shape: Shape, op: string): Result<boolean, ModelingError> {
  const report = validate(shape);
  const other = report.issues.filter((i) => !(i.code === 'brep-edge-use' && i.ids.uses === 1));
  const first = other[0];
  if (first !== undefined) {
    return err(brepError(first.code, first.message, { op, reason: 'input-invalid', ...first.ids }));
  }
  return ok(report.issues.length > 0);
}

/**
 * Compact the draft and validate the result. A free boundary edge is accepted only when the input already
 * had one or the edit is allowed to open the shell; anything else fails with the validation issue.
 */
export function finishDraft(
  d: Draft,
  op: string,
  allowOpen: boolean,
): Result<EditResult, ModelingError> {
  const out = compact(d);
  if (!out.ok) return out;
  const report = validate(out.value.shape);
  const bad = allowOpen ? nonOpenIssues(out.value.shape) : report.issues;
  const first = bad[0];
  if (first !== undefined) {
    return err(
      brepError(first.code, first.message, { op, reason: 'result-invalid', ...first.ids }),
    );
  }
  return out;
}

/** The provenance of applying `second` to the output of `first`, expressed on `first`'s input. */
export function composeProvenance(first: Provenance, second: Provenance): Provenance {
  const through = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]) =>
    b.map((ids) => [...new Set(ids.flatMap((i) => a[i] ?? []))].sort((x, y) => x - y));
  return {
    faces: through(first.faces, second.faces),
    edges: through(first.edges, second.edges),
    vertices: through(first.vertices, second.vertices),
  };
}
