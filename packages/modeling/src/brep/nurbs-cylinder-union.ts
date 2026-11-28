import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { domain, type NurbsCurve, curvePoint as nurbsPoint } from '../nurbs';
import { type LoopEdge, ShapeAssembler } from './assembler';
import { Copier } from './copier';
import { measure } from './measure';
import { type Side, subNurbs } from './nurbs-plane-union';
import { brepFail, type Coedge, type Face, type Shape, type Surface } from './types';
import { dist3, dot3, type P3, sub3, TWO_PI } from './vec';

/**
 * Union of one NURBS wall face with one analytic cylinder whose intersection is a single closed
 * section. The section splits the lateral into two bands, one per cap circle. A band is kept only
 * when its cap centre lies outside the wall. The section is cut once at the cylinder seam, so each
 * band boundary is a single chain: circle, seam, section arc pair, seam.
 */

export interface CylinderLateral {
  readonly surface: Surface & { readonly kind: 'cylinder' };
  readonly lo: { readonly h: number; readonly edge: number };
  readonly hi: { readonly h: number; readonly edge: number };
  readonly face: number;
}

export interface NurbsCylinderSection {
  readonly wallFace: number;
  /** The 3D section curve; its parameter range is [t0, t1] and it wraps the cylinder once. */
  readonly curve: NurbsCurve;
  readonly onWall: NurbsCurve;
  readonly onCylinder: NurbsCurve;
  readonly t0: number;
  readonly t1: number;
}

export interface NurbsCylinderUnionInput {
  readonly solids: readonly [Shape, Shape];
  readonly wallSide: Side;
  readonly lateralSide: Side;
  readonly lateral: CylinderLateral;
  readonly sections: readonly NurbsCylinderSection[];
  readonly diag: number;
  readonly tol: number;
  readonly inside: (side: Side, p: P3) => boolean;
}

function refuse(
  reason: string,
  detail: Record<string, unknown> = {},
): Result<never, ModelingError> {
  return brepFail(
    'brep-ssi-unsupported',
    'a NURBS-wall union with a cylinder in the supported family',
    {
      reason,
      ...detail,
    },
  );
}

interface Arc {
  readonly curve: NurbsCurve;
  readonly onWall: NurbsCurve;
  readonly onCylinder: NurbsCurve;
}

interface Split {
  readonly first: Arc;
  readonly second: Arc;
  readonly hStar: number;
  readonly hMin: number;
  readonly hMax: number;
}

export function unionNurbsCylinder(input: NurbsCylinderUnionInput): Result<Shape, ModelingError> {
  const { solids, wallSide, lateralSide, lateral, sections, diag, tol, inside } = input;
  if (sections.length === 0) return refuse('section-count', { count: 0 });
  const frame = lateral.surface.frame;
  const radius = lateral.surface.radius;
  const height = (p: P3): number => dot3(sub3(p, frame.o), frame.z);
  const seamPoint = (h: number): P3 => [
    frame.o[0] + h * frame.z[0] + radius * frame.x[0],
    frame.o[1] + h * frame.z[1] + radius * frame.x[1],
    frame.o[2] + h * frame.z[2] + radius * frame.x[2],
  ];

  const splits: Split[] = [];
  for (const sec of sections) {
    const s = splitAtSeam(sec, height);
    if (!s.ok) return s;
    splits.push(s.value);
  }

  // Bands run between consecutive boundaries ordered by height; the two cap circles bound the ends.
  type Boundary =
    | {
        readonly kind: 'circle';
        readonly lo: number;
        readonly hi: number;
        readonly root: number;
        readonly edge: number;
      }
    | {
        readonly kind: 'section';
        readonly idx: number;
        readonly lo: number;
        readonly hi: number;
        readonly root: number;
      };
  const boundaries: Boundary[] = [
    {
      kind: 'circle',
      lo: lateral.lo.h,
      hi: lateral.lo.h,
      root: lateral.lo.h,
      edge: lateral.lo.edge,
    },
    {
      kind: 'circle',
      lo: lateral.hi.h,
      hi: lateral.hi.h,
      root: lateral.hi.h,
      edge: lateral.hi.edge,
    },
    ...splits.map(
      (s, idx): Boundary => ({
        kind: 'section',
        idx,
        lo: s.hMin,
        hi: s.hMax,
        root: s.hStar,
      }),
    ),
  ];
  boundaries.sort((a, b) => a.lo + a.hi - (b.lo + b.hi));
  for (let i = 1; i < boundaries.length; i++) {
    const prev = boundaries[i - 1] as Boundary;
    const cur = boundaries[i] as Boundary;
    if (cur.lo <= prev.hi) return refuse('section-heights-overlap');
  }

  const asm = ShapeAssembler.create(Math.max(diag, tol));
  if (!asm.ok) return asm;
  const out = asm.value;
  const cw = new Copier(solids[wallSide], out);
  const cl = new Copier(solids[lateralSide], out);
  const arcs = splits.map((s) => ({
    first: edgeOf(out, s.first.curve),
    second: edgeOf(out, s.second.curve),
  }));
  const boundaryEdges = (b: Boundary): LoopEdge[] =>
    b.kind === 'circle'
      ? [{ edge: cl.edge(b.edge) }]
      : [
          {
            edge: (arcs[b.idx] as { second: number }).second,
            pcurve: { kind: 'nurbs', curve: (splits[b.idx] as Split).second.onCylinder },
          },
          {
            edge: (arcs[b.idx] as { first: number }).first,
            pcurve: { kind: 'nurbs', curve: (splits[b.idx] as Split).first.onCylinder },
          },
        ];

  const lateralFace = solids[lateralSide].faces[lateral.face] as Face;
  const lateralSurf = cl.surface(lateralFace.surface);
  const faces: number[] = [];

  for (let i = 0; i + 1 < boundaries.length; i++) {
    const lower = boundaries[i] as Boundary;
    const upper = boundaries[i + 1] as Boundary;
    const mid = seamPoint((lower.hi + upper.lo) / 2);
    if (inside(wallSide, mid)) continue;
    const seamEdge = seamLine(out, seamPoint(lower.root), seamPoint(upper.root));
    const loop: LoopEdge[] = [
      ...boundaryEdges(lower),
      { edge: seamEdge },
      ...boundaryEdges(upper),
      { edge: seamEdge },
    ];
    let id = out.loop(lateralSurf, loop, true);
    if (!id.ok) id = out.loop(lateralSurf, loop, false);
    if (!id.ok) return id;
    faces.push(
      out.face(lateralSurf, [id.value], lateralFace.reversed, lateralFace.label, lateralFace.role),
    );
  }

  for (let f = 0; f < solids[wallSide].faces.length; f++) {
    const face = solids[wallSide].faces[f] as Face;
    const surf = cw.surface(face.surface);
    const surfaceRef = solids[wallSide].surfaces[face.surface];
    const mine = sections.flatMap((s, i) => (s.wallFace === f ? [i] : []));
    if (mine.length === 0) {
      const corners = wallCorners(solids[wallSide], face);
      if (corners.length > 0 && inside(lateralSide, centroidOf(corners)))
        return refuse('wall-face-inside-cylinder', { face: f });
      const ids: number[] = [];
      for (const l of face.loops) {
        const edges =
          surfaceRef?.kind === 'nurbs' ? nurbsEdges(cw, solids[wallSide], l) : cw.loopEdges(l);
        const id = out.loop(surf, edges, solids[wallSide].loops[l]?.outer ?? true);
        if (!id.ok) return id;
        ids.push(id.value);
      }
      faces.push(out.face(surf, ids, face.reversed, face.label, face.role));
      continue;
    }
    if (surfaceRef?.kind !== 'nurbs' || face.loops.length !== 1)
      return refuse('section-wall-kind', { face: f });
    const outer = out.loop(surf, nurbsEdges(cw, solids[wallSide], face.loops[0] as number), true);
    if (!outer.ok) return outer;
    const holes: number[] = [outer.value];
    for (const i of mine) {
      const sp = splits[i] as Split;
      const hole = out.loop(
        surf,
        [
          {
            edge: (arcs[i] as { second: number }).second,
            pcurve: { kind: 'nurbs', curve: sp.second.onWall },
          },
          {
            edge: (arcs[i] as { first: number }).first,
            pcurve: { kind: 'nurbs', curve: sp.first.onWall },
          },
        ],
        false,
      );
      if (!hole.ok) return hole;
      holes.push(hole.value);
    }
    faces.push(out.face(surf, holes, face.reversed, face.label, face.role));
  }

  for (let f = 0; f < solids[lateralSide].faces.length; f++) {
    if (f === lateral.face) continue;
    const face = solids[lateralSide].faces[f] as Face;
    const surfaceRef = solids[lateralSide].surfaces[face.surface];
    if (surfaceRef?.kind !== 'plane' || face.loops.length !== 1)
      return refuse('cylinder-cap-kind', { face: f });
    const corners = wallCorners(solids[lateralSide], face);
    if (corners.length > 0 && inside(wallSide, centroidOf(corners))) continue;
    const surf = cl.surface(face.surface);
    const id = out.loop(surf, cl.loopEdges(face.loops[0] as number), true);
    if (!id.ok) return id;
    faces.push(out.face(surf, [id.value], face.reversed, face.label, face.role));
  }

  out.shell(faces);
  const shape = out.finish();
  if (!shape.ok) return shape;
  return volumeChecked(shape.value, solids, wallSide, lateralSide, diag, tol);
}

/**
 * Fail closed unless the union volume lies between the larger operand and the operand sum. Both
 * operands are measured with the same kernel so the bound is self-consistent.
 */
function volumeChecked(
  result: Shape,
  solids: readonly [Shape, Shape],
  wallSide: Side,
  lateralSide: Side,
  diag: number,
  tol: number,
): Result<Shape, ModelingError> {
  const va = measure(solids[wallSide]);
  const vb = measure(solids[lateralSide]);
  const v = measure(result);
  if (!va.ok) return va;
  if (!vb.ok) return vb;
  if (!v.ok) return v;
  const slack = Math.max(1e-6, diag * diag * diag * 1e-6, tol * diag * diag);
  const lo = Math.max(va.value.volume, vb.value.volume) - slack;
  const hi = va.value.volume + vb.value.volume + slack;
  if (v.value.volume < lo || v.value.volume > hi)
    return refuse('volume-outside-bounds', {
      volume: v.value.volume,
      lo,
      hi,
    });
  return ok(result);
}

/** Cut the closed section once where its u crosses the seam angle (a multiple of 2 pi). */
function splitAtSeam(
  sec: NurbsCylinderSection,
  height: (p: P3) => number,
): Result<Split, ModelingError> {
  const uOf = (t: number): number => nurbsPoint(sec.onCylinder, t)[0];
  const u0 = uOf(sec.t0);
  const u1 = uOf(sec.t1);
  if (Math.abs(Math.abs(u1 - u0) - TWO_PI) > 1e-6)
    return refuse('section-not-wrapping', { u0, u1 });
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  const target = Math.ceil(lo / TWO_PI) * TWO_PI;
  if (target - lo < 1e-9 || hi - target < 1e-9) return refuse('section-at-seam');
  const g = (t: number): number => uOf(t) - target;
  const N = 256;
  const at = (i: number): number => sec.t0 + ((sec.t1 - sec.t0) * i) / N;
  let root: number | undefined;
  for (let i = 0; i < N && root === undefined; i++) {
    const ta = at(i);
    const tb = at(i + 1);
    const ga = g(ta);
    if (Math.sign(ga) === Math.sign(g(tb))) continue;
    let x = ta;
    let y = tb;
    for (let k = 0; k < 100; k++) {
      const m = (x + y) / 2;
      if (Math.sign(g(m)) === Math.sign(ga)) x = m;
      else y = m;
    }
    root = (x + y) / 2;
  }
  if (root === undefined || Math.abs(g(root)) > 1e-7) return refuse('seam-crossing-missing');
  const first = subArc(sec, sec.t0, root);
  if (!first.ok) return first;
  const second = subArc(sec, root, sec.t1);
  if (!second.ok) return second;
  let hMin = Infinity;
  let hMax = -Infinity;
  const [a0, a1] = domain(sec.curve);
  for (let i = 0; i <= 64; i++) {
    const h = height(nurbsPoint(sec.curve, a0 + ((a1 - a0) * i) / 64));
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
  }
  return ok({
    first: first.value,
    second: second.value,
    hStar: height(nurbsPoint(sec.curve, root)),
    hMin,
    hMax,
  });
}

function subArc(sec: NurbsCylinderSection, lo: number, hi: number): Result<Arc, ModelingError> {
  const c = subNurbs(sec.curve, lo, hi);
  if (!c.ok) return c;
  const w = subNurbs(sec.onWall, lo, hi);
  if (!w.ok) return w;
  const cy = subNurbs(sec.onCylinder, lo, hi);
  if (!cy.ok) return cy;
  return ok({ curve: c.value, onWall: w.value, onCylinder: cy.value });
}

function edgeOf(out: ShapeAssembler, curve: NurbsCurve): number {
  const [a, b] = domain(curve);
  return out.edge(out.curve({ kind: 'nurbs', curve }), a, b);
}

function seamLine(out: ShapeAssembler, p: P3, q: P3): number {
  const len = dist3(p, q);
  const d: P3 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len, (q[2] - p[2]) / len];
  return out.edge(out.curve({ kind: 'line', o: p, d }), 0, len);
}

function nurbsEdges(cw: Copier, shape: Shape, loop: number): LoopEdge[] {
  return (shape.loops[loop]?.coedges ?? []).map((c) => {
    const co = shape.coedges[c] as Coedge;
    return { edge: cw.edge(co.edge), pcurve: co.pcurve };
  });
}

function wallCorners(shape: Shape, face: Face): P3[] {
  return face.loops.flatMap((l) =>
    (shape.loops[l]?.coedges ?? []).map((c) => {
      const co = shape.coedges[c] as Coedge;
      const e = shape.edges[co.edge];
      return shape.vertices[co.reversed ? (e?.v1 ?? 0) : (e?.v0 ?? 0)]?.p ?? ([0, 0, 0] as P3);
    }),
  );
}

function centroidOf(pts: readonly P3[]): P3 {
  const n = pts.length;
  return [
    pts.reduce((acc, q) => acc + q[0], 0) / n,
    pts.reduce((acc, q) => acc + q[1], 0) / n,
    pts.reduce((acc, q) => acc + q[2], 0) / n,
  ];
}
