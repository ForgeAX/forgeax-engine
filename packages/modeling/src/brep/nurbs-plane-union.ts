import { ok, type Result } from '@forgeax/engine-types';
import { replaceAll } from '../arrays';
import type { ModelingError } from '../errors';
import { domain, type NurbsCurve, curvePoint as nurbsPoint, splitCurve } from '../nurbs';
import { type LoopEdge, ShapeAssembler } from './assembler';
import { Copier } from './copier';
import { curvePoint } from './curves';
import { splitEdgeAt } from './edge-split';
import { brepFail, type Coedge, type Curve, type Face, type Frame, type Shape } from './types';
import { dist3, dot3, madd3, type P3, sub3 } from './vec';

/**
 * S2b2: union of a NURBS wall with a planar plate, from the clipped section branches of one pairing.
 * Each section is one NURBS edge shared by the wall hole loop and the plate piece it bounds. Plate
 * edges are pre-split at section ends so chord endpoints are plate vertices. The wall keeps its outer
 * loop and gains one hole per closed chain of sections; plate faces split along their chords and keep
 * the pieces outside the wall. Shapes outside this family are refused by name.
 */
export type Side = 0 | 1;

export interface NurbsSection {
  /** Face index on the wall solid and on the plate solid. */
  readonly wallFace: number;
  readonly plateFace: number;
  /** The 3D section and its trims on the wall and on the plate; parameters are the knot domain. */
  readonly curve: NurbsCurve;
  readonly onWall: NurbsCurve;
  readonly onPlate: NurbsCurve;
  readonly t0: number;
  readonly t1: number;
  readonly p0: P3;
  readonly p1: P3;
}

export interface NurbsPlaneUnionInput {
  readonly solids: readonly [Shape, Shape];
  readonly wallSide: Side;
  readonly sections: readonly NurbsSection[];
  readonly diag: number;
  readonly tol: number;
  /** Inside test of a point against one input solid (ray parity through its tessellation). */
  readonly inside: (side: Side, p: P3) => boolean;
}

const CHORD_SAMPLES = 8;

function refuse<T = never>(
  reason: string,
  detail: Record<string, unknown> = {},
): Result<T, ModelingError> {
  return brepFail('brep-ssi-unsupported', 'a NURBS-wall union in the supported family', {
    reason,
    ...detail,
  });
}

/** The sub-curve over [lo, hi] on the original knot parameters. */
export function subNurbs(c: NurbsCurve, lo: number, hi: number): Result<NurbsCurve, ModelingError> {
  const [a, b] = domain(c);
  let cur = c;
  if (hi < b) {
    const r = splitCurve(cur, hi);
    if (!r.ok) return r;
    cur = r.value[0];
  }
  if (lo > a) {
    const r = splitCurve(cur, lo);
    if (!r.ok) return r;
    cur = r.value[1];
  }
  const [da, db] = domain(cur);
  if (Math.abs(da - lo) > 1e-9 || Math.abs(db - hi) > 1e-9)
    return refuse('section-domain', { lo, hi, da, db });
  return ok(cur);
}

/** Split the plate's line edge that carries `p` at `p`, unless `p` is already one of its ends. */
function splitPlateAt(
  shape: Shape,
  face: number,
  p: P3,
  tol: number,
): Result<Shape, ModelingError> {
  const f: Face | undefined = shape.faces[face];
  if (f === undefined) return refuse('plate-face-index', { face });
  for (const l of f.loops) {
    for (const c of shape.loops[l]?.coedges ?? []) {
      const co = shape.coedges[c] as Coedge;
      const e = shape.edges[co.edge];
      if (e === undefined || e.curve < 0) continue;
      const cv = shape.curves[e.curve] as Curve;
      if (cv.kind !== 'line') continue;
      const t = dot3(sub3(p, cv.o), cv.d);
      if (t < e.t0 - tol || t > e.t1 + tol) continue;
      if (dist3(madd3(cv.o, cv.d, t), p) > tol) continue;
      if (t <= e.t0 + tol || t >= e.t1 - tol) return ok(shape);
      const r = splitEdgeAt(shape, co.edge, t);
      if (!r.ok) return r;
      return ok(r.value.shape);
    }
  }
  return refuse('section-off-plate-edge', { face });
}

/** Move a section's clamped end control points onto the plate vertex that coincides with them. */
function snapToVertices(c: NurbsCurve, shape: Shape, tol: number): NurbsCurve {
  const [a, b] = domain(c);
  const points = c.points.map((q) => [...q] as [number, number, number]);
  const last = points.length - 1;
  for (const [t, at] of [
    [a, 0],
    [b, last],
  ] as const) {
    const p = nurbsPoint(c, t);
    let best: P3 | undefined;
    let bestD = 10 * tol;
    for (const v of shape.vertices) {
      const d = dist3(v.p, p);
      if (d <= bestD) {
        best = v.p;
        bestD = d;
      }
    }
    if (best !== undefined) points[at] = [best[0], best[1], best[2]];
  }
  return { ...c, points };
}

function near(a: P3, b: P3, tol: number): boolean {
  return dist3(a, b) <= 10 * tol;
}

function nurbsLoopEdges(cp: Copier, shape: Shape, loop: number): LoopEdge[] {
  return (shape.loops[loop]?.coedges ?? []).map((c) => {
    const co = shape.coedges[c] as Coedge;
    return { edge: cp.edge(co.edge), pcurve: co.pcurve };
  });
}

/** One boundary item of a planar plate cycle: a copied plate edge, or a section chord. */
type Item =
  | { readonly kind: 'edge'; readonly edge: number; readonly from: P3 }
  | {
      readonly kind: 'chord';
      readonly section: number;
      readonly reversed: boolean;
      readonly from: P3;
    };

function arc(items: readonly Item[], from: number, to: number): Item[] {
  const out: Item[] = [];
  for (let i = from; i !== to; i = (i + 1) % items.length) out.push(items[i] as Item);
  return out;
}

/**
 * Split a planar cycle along chords whose ends are cycle vertices. A chord cuts the cycle into the
 * arc from its start to its end plus the chord back, and the remaining arc plus the chord forward.
 */
function splitCycle(
  items: readonly Item[],
  chords: readonly number[],
  sections: readonly NurbsSection[],
  tol: number,
): Result<Item[][], ModelingError> {
  if (chords.length === 0) return ok([items.slice()]);
  const s = chords[0] as number;
  const sec = sections[s] as NurbsSection;
  const a = items.findIndex((i) => near(i.from, sec.p0, tol));
  const b = items.findIndex((i) => near(i.from, sec.p1, tol));
  if (a < 0 || b < 0) return refuse('chord-end-not-on-cycle', { section: s });
  const arcA = arc(items, a, b);
  const arcB = arc(items, b, a);
  const onArc = (pts: readonly P3[], q: P3) => pts.some((x) => near(x, q, tol));
  const ptsA = arcA.map((i) => i.from);
  const ptsB = arcB.map((i) => i.from);
  const inA: number[] = [];
  const inB: number[] = [];
  for (const c of chords.slice(1)) {
    const cs = sections[c] as NurbsSection;
    const inAll = onArc(ptsA, cs.p0) && onArc(ptsA, cs.p1);
    const inBAll = onArc(ptsB, cs.p0) && onArc(ptsB, cs.p1);
    if (inAll) inA.push(c);
    else if (inBAll) inB.push(c);
    else return refuse('chord-crosses-chord', { section: c });
  }
  const back: Item = { kind: 'chord', section: s, reversed: true, from: sec.p1 };
  const fwd: Item = { kind: 'chord', section: s, reversed: false, from: sec.p0 };
  const first = splitCycle([...arcA, back], inA, sections, tol);
  if (!first.ok) return first;
  const second = splitCycle([...arcB, fwd], inB, sections, tol);
  if (!second.ok) return second;
  return ok([...first.value, ...second.value]);
}

/** Boundary samples of one piece, used for its interior test in the plate plane. */
function boundarySamples(
  items: readonly Item[],
  sections: readonly NurbsSection[],
  curves: readonly Curve[],
): P3[] {
  const pts: P3[] = [];
  for (const i of items) {
    if (i.kind === 'edge') {
      pts.push(i.from);
      continue;
    }
    const c = curves[i.section] as Curve;
    const sec = sections[i.section] as NurbsSection;
    for (let k = 0; k < CHORD_SAMPLES; k++) {
      const f = i.reversed ? 1 - k / CHORD_SAMPLES : k / CHORD_SAMPLES;
      pts.push(curvePoint(c, sec.t0 + (sec.t1 - sec.t0) * f));
    }
  }
  return pts;
}

/**
 * A point of the piece far from its chords. The solid's tessellation is coarse near a curved wall,
 * so a centroid lying close to a chord can classify wrongly; the plate boundary farthest from the
 * chords classifies reliably.
 */
function interiorProbe(
  piece: readonly Item[],
  sections: readonly NurbsSection[],
  curves: readonly Curve[],
  fallback: P3,
): P3 {
  const chordPts: P3[] = [];
  piece.forEach((i) => {
    if (i.kind !== 'chord') return;
    const sec = sections[i.section] as NurbsSection;
    const c = curves[i.section] as Curve;
    for (let k = 0; k <= CHORD_SAMPLES; k++) {
      const f = k / CHORD_SAMPLES;
      chordPts.push(curvePoint(c, sec.t0 + (sec.t1 - sec.t0) * f));
    }
  });
  let best: P3 | undefined;
  let bestD = -1;
  piece.forEach((i, k) => {
    if (i.kind !== 'edge') return;
    const nxt = piece[(k + 1) % piece.length] as Item;
    const mid: P3 = [
      (i.from[0] + nxt.from[0]) / 2,
      (i.from[1] + nxt.from[1]) / 2,
      (i.from[2] + nxt.from[2]) / 2,
    ];
    const d = chordPts.reduce((m, q) => Math.min(m, dist3(q, mid)), Infinity);
    if (d > bestD) {
      bestD = d;
      best = mid;
    }
  });
  return best ?? fallback;
}

/** Ray-parity point-in-polygon in the plane frame of a plate face. */
function inPolygon(frame: Frame, poly: readonly P3[], p: P3): boolean {
  const pt = (q: P3): [number, number] => {
    const d = sub3(q, frame.o);
    return [dot3(d, frame.x), dot3(d, frame.y)];
  };
  const [px, py] = pt(p);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = pt(poly[i] as P3);
    const [bx, by] = pt(poly[j] as P3);
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function centroid(pts: readonly P3[]): P3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const q of pts) {
    x += q[0];
    y += q[1];
    z += q[2];
  }
  const n = pts.length;
  return [x / n, y / n, z / n];
}

/**
 * Give the pcurve ends that meet at one 3D joint a single (u, v). Marched sections meeting at a
 * corner carry ends that differ by solver noise, which the assembler's (u, v) chain test rejects.
 */
function pinSharedEnds(
  pcs: readonly NurbsCurve[],
  pts: readonly (readonly [P3, P3])[],
  keys: readonly number[],
  tol: number,
  exact?: (i: number, p: P3) => [number, number] | undefined,
): NurbsCurve[] {
  const ends = pcs.flatMap((pc, i) => {
    const [a, b] = domain(pc);
    return [0, 1].map((w) => ({
      i,
      w,
      key: keys[i] as number,
      p: (pts[i] as readonly [P3, P3])[w] as P3,
      uv: nurbsPoint(pc, w === 0 ? a : b),
    }));
  });
  const target = new Map<number, [number, number]>();
  ends.forEach((e, k) => {
    if (target.has(k)) return;
    const closed = exact?.(e.i, e.p);
    if (closed !== undefined) {
      target.set(k, closed);
      return;
    }
    const group = ends.flatMap((f, j) => (f.key === e.key && near(f.p, e.p, tol) ? [j] : []));
    const u =
      group.reduce((acc, j) => acc + (ends[j] as (typeof ends)[number]).uv[0], 0) / group.length;
    const v =
      group.reduce((acc, j) => acc + (ends[j] as (typeof ends)[number]).uv[1], 0) / group.length;
    for (const j of group) target.set(j, [u, v]);
  });
  return pcs.map((pc, i) => {
    const points = pc.points.map((q) => [...q] as [number, number, number]);
    const last = points.length - 1;
    for (const w of [0, 1] as const) {
      const j = ends.findIndex((e) => e.i === i && e.w === w);
      const uv = target.get(j) as [number, number];
      const at = w === 0 ? 0 : last;
      points[at] = [uv[0], uv[1], (points[at] as P3)[2]];
    }
    return { ...pc, points };
  });
}

export function unionNurbsPlane(input: NurbsPlaneUnionInput): Result<Shape, ModelingError> {
  const { solids, wallSide, sections, diag, tol, inside } = input;
  const plateSide = (1 - wallSide) as Side;
  const wall = solids[wallSide];
  let plate = solids[plateSide];
  for (const s of sections) {
    for (const p of [s.p0, s.p1]) {
      const r = splitPlateAt(plate, s.plateFace, p, tol);
      if (!r.ok) return r;
      plate = r.value;
    }
  }

  const asm = ShapeAssembler.create(Math.max(diag, tol));
  if (!asm.ok) return asm;
  const out = asm.value;
  const cw = new Copier(wall, out);
  const cp = new Copier(plate, out);

  // Each section is one edge, shared by the wall hole loop and the plate piece it bounds.
  const secEdge: number[] = [];
  const secCurve: Curve[] = [];
  const secWall: NurbsCurve[] = [];
  const secPlate: NurbsCurve[] = [];
  const secSpan: (readonly [P3, P3])[] = [];
  for (const s of sections) {
    const c3raw = subNurbs(s.curve, s.t0, s.t1);
    if (!c3raw.ok) return c3raw;
    const c3 = ok(snapToVertices(c3raw.value, plate, tol));
    const w = subNurbs(s.onWall, s.t0, s.t1);
    if (!w.ok) return w;
    const p = subNurbs(s.onPlate, s.t0, s.t1);
    if (!p.ok) return p;
    const curve: Curve = { kind: 'nurbs', curve: c3.value };
    secEdge.push(out.edge(out.curve(curve), s.t0, s.t1));
    secCurve.push(curve);
    secSpan.push([nurbsPoint(c3.value, s.t0), nurbsPoint(c3.value, s.t1)]);
    secWall.push(w.value);
    secPlate.push(p.value);
  }
  const wallKeys = sections.map((s) => s.wallFace);
  const plateKeys = sections.map((s) => s.plateFace);
  const pinnedWall = pinSharedEnds(secWall, secSpan, wallKeys, tol);
  const pinnedPlate = pinSharedEnds(secPlate, secSpan, plateKeys, tol, (i, p) => {
    const face = plate.faces[sections[i]?.plateFace ?? -1];
    const surf = face === undefined ? undefined : plate.surfaces[face.surface];
    if (surf?.kind !== 'plane') return undefined;
    const d = sub3(p, surf.frame.o);
    return [dot3(d, surf.frame.x), dot3(d, surf.frame.y)];
  });
  replaceAll(secWall, pinnedWall);
  replaceAll(secPlate, pinnedPlate);

  const faces: number[] = [];

  for (let f = 0; f < wall.faces.length; f++) {
    const face = wall.faces[f] as Face;
    const surf = cw.surface(face.surface);
    const mine = sections.flatMap((s, i) => (s.wallFace === f ? [i] : []));
    if (mine.length === 0) {
      const corners = face.loops.flatMap((l) =>
        (wall.loops[l]?.coedges ?? []).map((c) => {
          const co = wall.coedges[c] as Coedge;
          const e = wall.edges[co.edge];
          return wall.vertices[co.reversed ? (e?.v1 ?? 0) : (e?.v0 ?? 0)]?.p ?? ([0, 0, 0] as P3);
        }),
      );
      if (corners.length > 0 && inside(plateSide, centroid(corners)))
        return refuse('wall-face-inside-plate', { face: f });
      const ids: number[] = [];
      for (const l of face.loops) {
        const id = out.loop(surf, nurbsLoopEdges(cw, wall, l), wall.loops[l]?.outer ?? true);
        if (!id.ok) return id;
        ids.push(id.value);
      }
      faces.push(out.face(surf, ids, face.reversed, face.label, face.role));
      continue;
    }
    if (face.loops.length !== 1) return refuse('section-on-multi-loop-wall', { face: f });
    // Chain the sections into one closed hole loop on the wall.
    const first = mine[0] as number;
    const hole: LoopEdge[] = [
      {
        edge: secEdge[first] as number,
        pcurve: { kind: 'nurbs', curve: secWall[first] as NurbsCurve },
      },
    ];
    const used = new Set<number>([first]);
    const start = (sections[first] as NurbsSection).p0;
    let cur = (sections[first] as NurbsSection).p1;
    while (used.size < mine.length) {
      const fwd = mine.find(
        (i) => !used.has(i) && near((sections[i] as NurbsSection).p0, cur, tol),
      );
      const rev = mine.find(
        (i) => !used.has(i) && near((sections[i] as NurbsSection).p1, cur, tol),
      );
      const pick = fwd ?? rev;
      if (pick === undefined) return refuse('hole-chain-open', { face: f });
      used.add(pick);
      hole.push({
        edge: secEdge[pick] as number,
        pcurve: { kind: 'nurbs', curve: secWall[pick] as NurbsCurve },
      });
      cur =
        fwd !== undefined
          ? (sections[pick] as NurbsSection).p1
          : (sections[pick] as NurbsSection).p0;
    }
    if (!near(cur, start, tol)) return refuse('hole-chain-open', { face: f });
    const outer = out.loop(surf, nurbsLoopEdges(cw, wall, face.loops[0] as number), true);
    const holeId = out.loop(surf, hole, false);
    if (!outer.ok) return outer;
    if (!holeId.ok) return holeId;
    faces.push(out.face(surf, [outer.value, holeId.value], face.reversed, face.label, face.role));
  }

  for (let f = 0; f < plate.faces.length; f++) {
    const face = plate.faces[f] as Face;
    const surf = cp.surface(face.surface);
    const plateSurf = plate.surfaces[face.surface];
    if (plateSurf?.kind !== 'plane' || face.loops.length !== 1)
      return refuse('plate-face-kind', { face: f });
    const frame = plateSurf.frame;
    const mine = sections.flatMap((s, i) => (s.plateFace === f ? [i] : []));
    const loop = face.loops[0] as number;
    const items: Item[] = (plate.loops[loop]?.coedges ?? []).map((c) => {
      const co = plate.coedges[c] as Coedge;
      const e = plate.edges[co.edge] as NonNullable<(typeof plate.edges)[number]>;
      return {
        kind: 'edge',
        edge: co.edge,
        from: plate.vertices[co.reversed ? e.v1 : e.v0]?.p as P3,
      };
    });
    if (mine.length === 0) {
      if (inside(wallSide, centroid(items.map((i) => i.from)))) continue;
      const id = out.loop(surf, cp.loopEdges(loop), true);
      if (!id.ok) return id;
      faces.push(out.face(surf, [id.value], face.reversed, face.label, face.role));
      continue;
    }
    const pieces = splitCycle(items, mine, sections, tol);
    if (!pieces.ok) return pieces;
    for (const piece of pieces.value) {
      const poly = boundarySamples(piece, sections, secCurve);
      const c = centroid(poly);
      if (!inPolygon(frame, poly, c)) return refuse('piece-interior', { face: f });
      if (inside(wallSide, interiorProbe(piece, sections, secCurve, c))) continue;
      const edges: LoopEdge[] = piece.map((i) =>
        i.kind === 'edge'
          ? { edge: cp.edge(i.edge) }
          : {
              edge: secEdge[i.section] as number,
              pcurve: { kind: 'nurbs', curve: secPlate[i.section] as NurbsCurve },
            },
      );
      const lid = out.loop(surf, edges, true);
      if (!lid.ok) return lid;
      faces.push(out.face(surf, [lid.value], face.reversed, face.label, face.role));
    }
  }

  out.shell(faces);
  return out.finish();
}
