import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2 } from '../dmath';
import type { ModelingError } from '../errors';
import { edgeUses } from './adjacency';
import { curvePoint, curveTangent, pcurvePoint } from './curves';
import { structureError } from './structure';
import { surfaceDerivatives, surfaceNormal, surfacePoint } from './surfaces';
import type { Coedge, Curve, Face, Shape, Surface } from './types';
import { cross3, dist3, dot3, len3, madd3, neg3, type P3, scale3, unit3 } from './vec';

/**
 * How well two faces join along an edge, worst to best:
 * `open` the two faces do not meet; `G0` they meet in a crease; `G1` the normals agree;
 * `G2` the normals and the normal curvature across the edge agree.
 */
export type Continuity = 'open' | 'G0' | 'G1' | 'G2';

const RANK: Record<Continuity, number> = { open: 0, G0: 1, G1: 2, G2: 3 };

export interface ContinuityOptions {
  /** Face-to-face distance above which an edge is `open`; default `shape.maxTol`. */
  readonly gapTol?: number;
  /** Normal angle in radians above which an edge is a crease (`G0`); default 1e-4. */
  readonly angleTol?: number;
  /** Relative cross-edge normal curvature difference above which a tangent edge is only `G1`; default 0.02. */
  readonly curvatureTol?: number;
  /** Samples per edge, at the midpoints of equal parameter intervals; default 9. */
  readonly samples?: number;
}

export interface ContinuitySample {
  /** Edge parameter. */
  readonly t: number;
  readonly point: P3;
  /** Distance between the two faces' surface points at the edge's pcurves. */
  readonly gap: number;
  /** Angle between the two outward face normals, radians. */
  readonly angle: number;
  /** Signed normal curvature across the edge on each face (positive where the outward normal diverges, convex); undefined at a degenerate parametrisation. */
  readonly curvature: readonly [number, number] | undefined;
  readonly grade: Continuity;
}

export interface EdgeContinuity {
  readonly edge: number;
  readonly faces: readonly [number, number];
  /** Both uses belong to one face (a periodic seam). */
  readonly seam: boolean;
  /** The worst sample's grade. */
  readonly grade: Continuity;
  readonly gap: number;
  readonly angle: number;
  /** Largest absolute curvature difference over the samples that could evaluate curvature. */
  readonly curvatureJump: number | undefined;
  /** Samples whose curvature could not be evaluated; they count as `G1` at best. */
  readonly unevaluated: number;
  readonly samples: readonly ContinuitySample[];
}

export interface ContinuitySkip {
  readonly edge: number;
  readonly reason: 'boundary' | 'non-manifold' | 'degenerate';
}

export interface ContinuityReport {
  readonly edges: readonly EdgeContinuity[];
  /** Edges that carry no pair of faces to compare. */
  readonly skipped: readonly ContinuitySkip[];
  readonly counts: Readonly<Record<Continuity, number>>;
}

interface Side {
  readonly normal: P3;
  readonly curvature: number | undefined;
  readonly point: P3;
}

function extent(shape: Shape): number {
  let size = 1;
  for (const a of shape.vertices)
    for (const b of shape.vertices) size = Math.max(size, dist3(a.p, b.p));
  return size;
}

/** Signed normal curvature of `surface` along the world tangent direction `w`, by a central difference of the normal. */
function normalCurvature(
  surface: Surface,
  u: number,
  v: number,
  w: P3,
  sign: number,
  step: number,
): number | undefined {
  const { du, dv } = surfaceDerivatives(surface, u, v);
  const g00 = dot3(du, du);
  const g01 = dot3(du, dv);
  const g11 = dot3(dv, dv);
  const det = g00 * g11 - g01 * g01;
  if (!(g00 > 0) || !(g11 > 0) || !(det > 1e-12 * g00 * g11)) return undefined;
  const r0 = dot3(w, du);
  const r1 = dot3(w, dv);
  const a = (g11 * r0 - g01 * r1) / det;
  const b = (g00 * r1 - g01 * r0) / det;
  const hp = surfaceNormal(surface, u + step * a, v + step * b);
  const hm = surfaceNormal(surface, u - step * a, v - step * b);
  if (len3(hp) === 0 || len3(hm) === 0) return undefined;
  const dn = scale3(madd3(hp, hm, -1), 1 / (2 * step));
  return sign * dot3(dn, w);
}

function sideAt(
  shape: Shape,
  curve: Curve,
  coedge: number,
  face: number,
  t: number,
  step: number,
): Side | undefined {
  const ce = shape.coedges[coedge] as Coedge;
  const f = shape.faces[face] as Face;
  const surface = shape.surfaces[f.surface] as Surface;
  const [u, v] = pcurvePoint(ce.pcurve, t);
  const raw = surfaceNormal(surface, u, v);
  if (len3(raw) === 0) return undefined;
  const sign = f.reversed ? -1 : 1;
  const normal = scale3(raw, sign);
  let tangent = curveTangent(curve, t);
  if (len3(tangent) === 0) return undefined;
  if (ce.reversed) tangent = neg3(tangent);
  const across = unit3(cross3(normal, tangent));
  return {
    normal,
    curvature: normalCurvature(surface, u, v, across, sign, step),
    point: surfacePoint(surface, u, v),
  };
}

function worse(a: Continuity, b: Continuity): Continuity {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * Per edge G0 / G1 / G2 measure straight from the exact surfaces and pcurves, never a tessellation.
 * G2 compares the normal curvature of each face in the direction across the edge, the usual cross-boundary
 * curvature continuity; it is a measurement at sample points, not a proof between them.
 */
export function measureContinuity(
  shape: Shape,
  options: ContinuityOptions = {},
): Result<ContinuityReport, ModelingError> {
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const gapTol = options.gapTol ?? shape.maxTol;
  const angleTol = options.angleTol ?? 1e-4;
  const curvatureTol = options.curvatureTol ?? 0.02;
  const n = Math.max(1, Math.floor(options.samples ?? 9));
  const scale = extent(shape);
  const step = 1e-5 * scale;
  const floor = 1e-6 / scale;
  const uses = edgeUses(shape);
  const edges: EdgeContinuity[] = [];
  const skipped: ContinuitySkip[] = [];
  const counts: Record<Continuity, number> = { open: 0, G0: 0, G1: 0, G2: 0 };
  shape.edges.forEach((edge, e) => {
    const list = uses[e] ?? [];
    if (edge.curve < 0) {
      skipped.push({ edge: e, reason: 'degenerate' });
      return;
    }
    if (list.length === 1) {
      skipped.push({ edge: e, reason: 'boundary' });
      return;
    }
    if (list.length !== 2) {
      skipped.push({ edge: e, reason: 'non-manifold' });
      return;
    }
    const [a, b] = list as [(typeof list)[number], (typeof list)[number]];
    const curve = shape.curves[edge.curve] as Curve;
    const samples: ContinuitySample[] = [];
    for (let i = 0; i < n; i++) {
      const t = edge.t0 + ((edge.t1 - edge.t0) * (i + 0.5)) / n;
      const sa = sideAt(shape, curve, a.coedge, a.face, t, step);
      const sb = sideAt(shape, curve, b.coedge, b.face, t, step);
      if (sa === undefined || sb === undefined) continue;
      const gap = dist3(sa.point, sb.point);
      const angle = atan2(len3(cross3(sa.normal, sb.normal)), dot3(sa.normal, sb.normal));
      const curvature =
        sa.curvature === undefined || sb.curvature === undefined
          ? undefined
          : ([sa.curvature, sb.curvature] as const);
      let grade: Continuity = 'G2';
      if (gap > gapTol) grade = 'open';
      else if (angle > angleTol) grade = 'G0';
      else if (curvature === undefined) grade = 'G1';
      else if (
        Math.abs(curvature[0] - curvature[1]) >
        curvatureTol * Math.max(Math.abs(curvature[0]), Math.abs(curvature[1])) + floor
      )
        grade = 'G1';
      samples.push({ t, point: curvePoint(curve, t), gap, angle, curvature, grade });
    }
    if (samples.length === 0) {
      skipped.push({ edge: e, reason: 'degenerate' });
      return;
    }
    let grade: Continuity = 'G2';
    let gap = 0;
    let angle = 0;
    let jump: number | undefined;
    let unevaluated = 0;
    for (const s of samples) {
      grade = worse(grade, s.grade);
      gap = Math.max(gap, s.gap);
      angle = Math.max(angle, s.angle);
      if (s.curvature === undefined) unevaluated++;
      else jump = Math.max(jump ?? 0, Math.abs(s.curvature[0] - s.curvature[1]));
    }
    counts[grade]++;
    edges.push({
      edge: e,
      faces: [a.face, b.face],
      seam: a.face === b.face,
      grade,
      gap,
      angle,
      curvatureJump: jump,
      unevaluated,
      samples,
    });
  });
  return ok({ edges, skipped, counts });
}
