import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { splitEdgeAt } from './edge-split';
import { splitFaceAtVertices } from './face-chord';
import type { Curve, Edge, Face, Loop, Shape, Vertex } from './types';
import { dot3, type P3, sub3 } from './vec';

/**
 * G2 section cap: a tool solid whose straight edges pierce a host planar cap (a disc bounded by a
 * single circle) at interior points, so the tool's section with that plane is a closed polygon
 * strictly inside the cap. The tool's edges are split at the piercings, each tool face crossed
 * twice is chorded, and the closed polygon becomes an inner loop of the cap. Union only; any other
 * configuration returns null and stays on the existing refusal path (fail closed).
 */

type Side = 0 | 1;

export interface CapHole {
  /** Side whose edges form the hole loop. */
  readonly tool: Side;
  /** Edges of the tool shape in cyclic order around the hole. */
  readonly edges: readonly number[];
}

export interface SectionPlan {
  readonly solids: readonly [Shape, Shape];
  /** Key `${side}:${face}` of a host cap, mapped to its inner loop. */
  readonly holes: ReadonlyMap<string, CapHole>;
  /** Keys of tool faces that the section split; the host cap and these never meet as plane pairs. */
  readonly pieces: ReadonlySet<string>;
  readonly capKey: string;
}

function circleCap(shape: Shape, face: Face): { o: P3; x: P3; y: P3; r: number } | null {
  if (face.loops.length !== 1) return null;
  const loop = shape.loops[face.loops[0] as number] as Loop;
  if (loop.coedges.length !== 1) return null;
  const co = shape.coedges[loop.coedges[0] as number];
  if (!co) return null;
  const e = shape.edges[co.edge] as Edge;
  if (e.curve < 0) return null;
  const c = shape.curves[e.curve] as Curve;
  if (c.kind !== 'circle') return null;
  return { o: c.frame.o, x: c.frame.x, y: c.frame.y, r: c.radius };
}

function lineParam(c: Extract<Curve, { kind: 'line' }>, p: P3): number {
  return dot3(sub3(p, c.o), c.d) / dot3(c.d, c.d);
}

function vertexP(shape: Shape, v: number): P3 {
  return (shape.vertices[v] as Vertex).p;
}

/** Plan the single section cap for `a` (host) and `b` (tool), or null when the pattern does not apply. */
function planFor(host: Shape, tool: Shape, hostSide: Side, tol: number): SectionPlan | null {
  const toolSide = (1 - hostSide) as Side;
  for (let hf = 0; hf < host.faces.length; hf++) {
    const hface = host.faces[hf] as Face;
    if (host.surfaces[hface.surface]?.kind !== 'plane') continue;
    const cap = circleCap(host, hface);
    if (cap === null) continue;
    const hs = host.surfaces[hface.surface] as Extract<
      Shape['surfaces'][number],
      { kind: 'plane' }
    >;
    const n = hs.frame.z;
    const signed = (p: P3): number => dot3(sub3(p, cap.o), n);

    // Piercing edges: straight tool edges whose endpoints lie strictly on opposite sides.
    const pierce: { edge: number; p: P3; t: number }[] = [];
    let applicable = true;
    for (let ei = 0; ei < tool.edges.length && applicable; ei++) {
      const e = tool.edges[ei] as Edge;
      if (e.curve < 0) continue;
      const c = tool.curves[e.curve] as Curve;
      const p0 = vertexP(tool, e.v0);
      const p1 = vertexP(tool, e.v1);
      const s0 = signed(p0);
      const s1 = signed(p1);
      if (!(s0 * s1 < 0 && Math.abs(s0) > tol && Math.abs(s1) > tol)) continue;
      if (c.kind !== 'line') {
        applicable = false;
        break;
      }
      const k = s0 / (s0 - s1);
      const p: P3 = [
        p0[0] + (p1[0] - p0[0]) * k,
        p0[1] + (p1[1] - p0[1]) * k,
        p0[2] + (p1[2] - p0[2]) * k,
      ];
      const d = sub3(p, cap.o);
      const along = dot3(d, n);
      const inPlane: P3 = [d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]];
      if (Math.sqrt(dot3(inPlane, inPlane)) >= cap.r - tol) {
        applicable = false;
        break;
      }
      pierce.push({ edge: ei, p, t: lineParam(c, p) });
    }
    if (!applicable || pierce.length < 3) continue;
    if (tool.faces.length === 0) continue;

    // Split each piercing edge at its crossing; the vertex of each crossing is kept by id.
    let shape = tool;
    const crossing = new Set<number>();
    for (const pc of pierce) {
      const r = splitEdgeAt(shape, pc.edge, pc.t);
      if (!r.ok) return null;
      shape = r.value.shape;
      crossing.add(r.value.vertex);
    }

    // Chord every tool planar face that now has exactly two crossing vertices on its outer loop.
    const chordEdges = new Set<number>();
    for (let guard = 0; guard < 4 * pierce.length; guard++) {
      let target = -1;
      let pair: [number, number] = [-1, -1];
      for (let f = 0; f < shape.faces.length && target < 0; f++) {
        const face = shape.faces[f] as Face;
        if (shape.surfaces[face.surface]?.kind !== 'plane' || face.loops.length !== 1) continue;
        const loop = shape.loops[face.loops[0] as number] as Loop;
        const hits: number[] = [];
        let chorded = false;
        for (const ci of loop.coedges) {
          const co = shape.coedges[ci];
          if (!co) continue;
          if (chordEdges.has(co.edge)) chorded = true;
          const e = shape.edges[co.edge] as Edge;
          const start = co.reversed ? e.v1 : e.v0;
          if (crossing.has(start)) hits.push(start);
        }
        if (chorded || hits.length === 0) continue;
        if (hits.length === 2) {
          target = f;
          pair = [hits[0] as number, hits[1] as number];
        } else {
          return null;
        }
      }
      if (target < 0) break;
      const r = splitFaceAtVertices(shape, target, pair[0], pair[1]);
      if (!r.ok) return null;
      shape = r.value.shape;
      chordEdges.add(shape.edges.length - 1);
    }
    if (chordEdges.size !== pierce.length) return null;

    // The chords must close into one cycle through every crossing vertex.
    const chords = [...chordEdges].map((e) => ({ id: e, e: shape.edges[e] as Edge }));
    const first = chords[0];
    if (!first) return null;
    const cycle: number[] = [];
    let at = first.e.v1;
    const used = new Set<number>([first.id]);
    cycle.push(first.id);
    while (cycle.length < chords.length) {
      const next = chords.find((c) => !used.has(c.id) && (c.e.v0 === at || c.e.v1 === at));
      if (!next) return null;
      used.add(next.id);
      cycle.push(next.id);
      at = next.e.v0 === at ? next.e.v1 : next.e.v0;
    }
    if (at !== first.e.v0) return null;

    // Inner loops are clockwise in the cap plane.
    const pts = cycle.map((id) => vertexP(shape, (shape.edges[id] as Edge).v0));
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as P3;
      const q = pts[(i + 1) % pts.length] as P3;
      const pu = dot3(sub3(p, cap.o), cap.x);
      const pv = dot3(sub3(p, cap.o), cap.y);
      const qu = dot3(sub3(q, cap.o), cap.x);
      const qv = dot3(sub3(q, cap.o), cap.y);
      area += pu * qv - qu * pv;
    }
    const order = area > 0 ? [...cycle].reverse() : cycle;

    // Pieces: tool faces that carry a chord.
    const pieces = new Set<string>();
    shape.faces.forEach((face, fi) => {
      const loop = shape.loops[face.loops[0] as number] as Loop | undefined;
      if (!loop) return;
      if (loop.coedges.some((ci) => chordEdges.has((shape.coedges[ci] as { edge: number }).edge)))
        pieces.add(`${toolSide}:${fi}`);
    });

    const solids: [Shape, Shape] = hostSide === 0 ? [host, shape] : [shape, host];
    return {
      solids,
      holes: new Map([[`${hostSide}:${hf}`, { tool: toolSide, edges: order }]]),
      pieces,
      capKey: `${hostSide}:${hf}`,
    };
  }
  return null;
}

/**
 * Plan the section cap for a union of `a` and `b`. Returns null when neither side has the pattern,
 * so the caller keeps its existing handling; never a partial result.
 */
export function planSectionCap(
  a: Shape,
  b: Shape,
  tol: number,
): Result<SectionPlan | null, ModelingError> {
  const pa = planFor(a, b, 0, tol);
  if (pa !== null) return ok(pa);
  const pb = planFor(b, a, 1, tol);
  return ok(pb);
}
