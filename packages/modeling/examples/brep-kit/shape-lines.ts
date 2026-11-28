// B-rep line layers: classified feature edges and per-face (u, v) iso-parameter lines.
// Both read the exact Shape (curves, pcurves, surfaces), never the tessellation.

import { curvePoint, curveTangent, pcurvePoint } from '../../src/brep/curves.ts';
import { surfaceNormal, surfacePoint } from '../../src/brep/surfaces.ts';
import type { Face, Shape } from '../../src/brep/types.ts';
import type { P2, P3 } from '../../src/brep/vec.ts';
import { cross3, dot3, len3, neg3, unit3 } from '../../src/brep/vec.ts';
import { EDGE_STYLES, type EdgeKind, FACE_PALETTE, paletteAt, scaleColor } from './colors.ts';
import type { SceneLine } from './scene.ts';

const ARC_STEP = Math.PI / 48;
const NURBS_STEPS = 48;
const ISO_ARC_SAMPLES = 64;

export interface ClassifiedEdge {
  readonly edge: number;
  readonly kind: EdgeKind;
  readonly points: readonly P3[];
  /** Largest angle between the two face normals sampled along the edge, radians (0 for one-sided edges). */
  readonly angle: number;
}

export interface FeatureOptions {
  /** Edges whose face normals differ by more than this, radians, are sharp (default pi / 6). */
  readonly crease?: number;
}

function edgeSteps(kind: string, span: number): number {
  if (kind === 'line') return 1;
  if (kind === 'nurbs') return NURBS_STEPS;
  return Math.max(2, Math.ceil(Math.abs(span) / ARC_STEP));
}

function sampleEdge(shape: Shape, e: number): P3[] {
  const edge = shape.edges[e];
  const curve = edge === undefined ? undefined : shape.curves[edge.curve];
  if (edge === undefined || curve === undefined) return [];
  const n = edgeSteps(curve.kind, edge.t1 - edge.t0);
  const points: P3[] = [];
  for (let i = 0; i <= n; i++)
    points.push(curvePoint(curve, edge.t0 + ((edge.t1 - edge.t0) * i) / n));
  return points;
}

interface Use {
  readonly face: number;
  readonly coedge: number;
}

function edgeUses(shape: Shape): Use[][] {
  const uses: Use[][] = shape.edges.map(() => []);
  shape.faces.forEach((face, f) => {
    for (const l of face.loops)
      for (const c of shape.loops[l]?.coedges ?? []) {
        const ce = shape.coedges[c];
        if (ce !== undefined) uses[ce.edge]?.push({ face: f, coedge: c });
      }
  });
  return uses;
}

/** Outward face normal and inward in-surface direction at edge parameter `t` along the coedge's travel. */
function sideAt(shape: Shape, use: Use, t: number): { normal: P3; inward: P3 } | undefined {
  const ce = shape.coedges[use.coedge];
  const face = shape.faces[use.face] as Face;
  const surface = shape.surfaces[face.surface];
  const edge = ce === undefined ? undefined : shape.edges[ce.edge];
  const curve = edge === undefined ? undefined : shape.curves[edge.curve];
  if (ce === undefined || surface === undefined || curve === undefined) return undefined;
  const [u, v] = pcurvePoint(ce.pcurve, t);
  let normal = surfaceNormal(surface, u, v);
  if (len3(normal) === 0) return undefined;
  if (face.reversed) normal = neg3(normal);
  let tangent = curveTangent(curve, t);
  if (len3(tangent) === 0) return undefined;
  if (ce.reversed) tangent = neg3(tangent);
  // Loops keep the face on the left of travel when seen from the outward normal.
  return { normal, inward: unit3(cross3(normal, tangent)) };
}

/** Classifies every non-degenerate edge. Convex/concave follow from where the second face lies relative to the first. */
export function classifyEdges(shape: Shape, options: FeatureOptions = {}): ClassifiedEdge[] {
  const crease = options.crease ?? Math.PI / 6;
  const uses = edgeUses(shape);
  const out: ClassifiedEdge[] = [];
  shape.edges.forEach((edge, e) => {
    if (edge.curve < 0) return;
    const points = sampleEdge(shape, e);
    const list = uses[e] ?? [];
    if (list.length === 1) {
      out.push({ edge: e, kind: 'boundary', points, angle: 0 });
      return;
    }
    if (list.length !== 2) {
      out.push({ edge: e, kind: 'non-manifold', points, angle: 0 });
      return;
    }
    const [a, b] = list as [Use, Use];
    if (a.face === b.face) {
      out.push({ edge: e, kind: 'seam', points, angle: 0 });
      return;
    }
    let best = -1;
    let kind: EdgeKind = 'smooth';
    for (const k of [0.2, 0.5, 0.8]) {
      const t = edge.t0 + (edge.t1 - edge.t0) * k;
      const sa = sideAt(shape, a, t);
      const sb = sideAt(shape, b, t);
      if (sa === undefined || sb === undefined) continue;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot3(sa.normal, sb.normal))));
      if (angle > best) {
        best = angle;
        kind = dot3(sb.inward, sa.normal) < 0 ? 'convex' : 'concave';
      }
    }
    if (best < 0) {
      out.push({ edge: e, kind: 'smooth', points, angle: 0 });
      return;
    }
    out.push({ edge: e, kind: best > crease ? kind : 'smooth', points, angle: best });
  });
  return out;
}

export function featureLines(
  shape: Shape,
  options: FeatureOptions & { readonly kinds?: ReadonlySet<EdgeKind> } = {},
): SceneLine[] {
  return classifyEdges(shape, options)
    .filter((c) => options.kinds === undefined || options.kinds.has(c.kind))
    .map((c) => {
      const style = EDGE_STYLES[c.kind];
      const line: SceneLine = {
        points: c.points,
        color: style.color,
        width: style.width,
        ...(style.dash === undefined ? {} : { dash: style.dash }),
        bias: c.kind === 'smooth' ? 0.6 : 1,
      };
      return line;
    });
}

export function countByKind(edges: readonly ClassifiedEdge[]): Record<EdgeKind, number> {
  const counts: Record<EdgeKind, number> = {
    convex: 0,
    concave: 0,
    smooth: 0,
    boundary: 0,
    seam: 0,
    'non-manifold': 0,
  };
  for (const c of edges) counts[c.kind]++;
  return counts;
}

function pcurveSteps(kind: string, span: number): number {
  if (kind === 'line') return 1;
  if (kind === 'nurbs') return NURBS_STEPS;
  return Math.max(2, Math.ceil(Math.abs(span) / ARC_STEP));
}

/** The face's trim loops as (u, v) polylines, each coedge traversed in loop order. */
export function faceUvLoops(shape: Shape, f: number): P2[][] {
  const face = shape.faces[f] as Face;
  return face.loops.map((l) => {
    const pts: P2[] = [];
    for (const c of shape.loops[l]?.coedges ?? []) {
      const ce = shape.coedges[c];
      const edge = ce === undefined ? undefined : shape.edges[ce.edge];
      if (ce === undefined || edge === undefined) continue;
      const n = pcurveSteps(ce.pcurve.kind, edge.t1 - edge.t0);
      for (let i = 0; i < n; i++) {
        const k = ce.reversed ? n - i : i;
        pts.push(pcurvePoint(ce.pcurve, edge.t0 + ((edge.t1 - edge.t0) * k) / n));
      }
    }
    return pts;
  });
}

/** Even-odd interior intervals of the line `coord[axis] = c` across all loops, as sorted [lo, hi] pairs on the other axis. */
function crossings(loops: readonly (readonly P2[])[], axis: 0 | 1, c: number): [number, number][] {
  const other = axis === 0 ? 1 : 0;
  const hits: number[] = [];
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i] as P2;
      const q = loop[(i + 1) % loop.length] as P2;
      if (p[axis] <= c !== q[axis] <= c) {
        const k = (c - p[axis]) / (q[axis] - p[axis]);
        hits.push(p[other] + k * (q[other] - p[other]));
      }
    }
  hits.sort((a, b) => a - b);
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2)
    pairs.push([hits[i] as number, hits[i + 1] as number]);
  return pairs;
}

export type IsoCount = number | { readonly u: number; readonly v: number };

export interface IsoOptions {
  /** Lines per parameter direction per face (default 8); a function chooses per face, for example fewer on narrow facets. */
  readonly count?: IsoCount | ((face: Face, index: number, shape: Shape) => IsoCount);
  readonly width?: number;
  /** Brightness factor applied to the face colour (default 1.15). */
  readonly brighten?: number;
}

/** Iso-parameter lines of every face, clipped to the trimmed (u, v) domain, one colour per face. */
export function isoLines(shape: Shape, options: IsoOptions = {}): SceneLine[] {
  const out: SceneLine[] = [];
  shape.faces.forEach((face, f) => {
    const wanted =
      typeof options.count === 'function' ? options.count(face, f, shape) : (options.count ?? 8);
    const nu = typeof wanted === 'object' ? wanted.u : wanted;
    const nv = typeof wanted === 'object' ? wanted.v : wanted;
    const surface = shape.surfaces[face.surface];
    if (surface === undefined) return;
    const loops = faceUvLoops(shape, f);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const loop of loops)
      for (const [u, v] of loop) {
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
    if (!(u1 > u0 && v1 > v0)) return;
    const color = scaleColor(paletteAt(FACE_PALETTE, f), options.brighten ?? 1.15);
    const width = options.width ?? 1;
    for (const axis of [0, 1] as const) {
      const n = axis === 0 ? nu : nv;
      const [lo, hi] = axis === 0 ? [u0, u1] : [v0, v1];
      const [vlo, vhi] = axis === 0 ? [v0, v1] : [u0, u1];
      for (let i = 1; i <= n; i++) {
        const c = lo + ((hi - lo) * i) / (n + 1);
        for (const [a, b] of crossings(loops, axis, c)) {
          if (b - a < 1e-9 * (vhi - vlo)) continue;
          const steps =
            surface.kind === 'plane'
              ? 1
              : Math.max(2, Math.ceil((ISO_ARC_SAMPLES * (b - a)) / (vhi - vlo)));
          const points: P3[] = [];
          for (let s = 0; s <= steps; s++) {
            const w = a + ((b - a) * s) / steps;
            points.push(axis === 0 ? surfacePoint(surface, c, w) : surfacePoint(surface, w, c));
          }
          out.push({ points, color, width, bias: 0.8 });
        }
      }
    }
  });
  return out;
}
