import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { type Flow, type FlowGuide, flowAt, lineAngle } from './compute/line-field';
import { atan2, hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';

/**
 * Triangle tiling quality: how even, well
 * shaped and regularly connected a triangulated region is. Unlike the edge-flow check
 * (quads, valence 4), the ideal here is the equilateral tiling: aspect 1.15, angles
 * 60 degrees, interior valence 6. N-gons are counted and skipped.
 */
export interface MeshQualityLimits {
  /** Median aspect (longest edge squared over twice the area; 1.155 equilateral). */
  readonly aspectP50: number;
  /** 90th-percentile aspect. */
  readonly aspectP90: number;
  /** Largest share of triangles with aspect above 6. */
  readonly over6: number;
  /** Least 10th-percentile smallest angle (degrees). */
  readonly minAngleP10: number;
  /** Largest share of interior vertices of valence 3 or at least 9. */
  readonly badValence: number;
  /** Largest 95th-percentile ratio of the mean edge lengths of two faces sharing an edge. */
  readonly sizeRatioP95: number;
  /** With `flow`: largest 75th-percentile angle (degrees) of the long edges to the flow. */
  readonly flowP75: number;
  /** With `flow`: largest share of triangles too round to have a long edge (aspect below 1.5). */
  readonly flowSkipped: number;
  /** With a flow guide's `border`: largest share of the measured triangles in border rows. */
  readonly flowBorderShare: number;
}

/** Thresholds. */
export const MESH_QUALITY_LIMITS: MeshQualityLimits = {
  aspectP50: 2,
  aspectP90: 4,
  over6: 0.02,
  minAngleP10: 20,
  badValence: 0.01,
  sizeRatioP95: 2,
  flowP75: 20,
  flowSkipped: 0.4,
  flowBorderShare: 0.25,
};

/** @internal Flow guides with their selectors resolved on `mesh`. */
export function resolveFlowGuides(
  mesh: EditMesh,
  guides: readonly FlowGuide[] | undefined,
): Result<ResolvedFlowGuide[] | undefined, ModelingError> {
  if (guides === undefined) return ok(undefined);
  const out: ResolvedFlowGuide[] = [];
  for (const [i, g] of guides.entries()) {
    const crossing = g.border?.crossing;
    if (
      g.border !== undefined &&
      !(typeof crossing === 'number' && crossing > 0 && crossing <= 90)
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a guide border.crossing is within (0, 90] degrees',
          {
            guide: i,
            crossing,
          },
        ),
      );
    }
    const border = crossing === undefined ? {} : { crossing };
    if (g.faces === undefined) {
      out.push({ flow: g.flow, ...border });
      continue;
    }
    const ids = g.faces.resolve(mesh);
    if (!ids.ok) return ids;
    out.push({ faces: new Set(ids.value), flow: g.flow, ...border });
  }
  return ok(out);
}

/** Triangles rounder than this have no long edge to align: the flow measure skips them. */
const FLOW_ASPECT = 1.5;

/** Resolved flow guides: each covers its face ids, or every face without `faces`. */
export type ResolvedFlowGuide = {
  readonly faces?: ReadonlySet<number>;
  readonly flow: Flow;
  /** Border rows cross the flow by more than this (degrees). */
  readonly crossing?: number;
};

export interface MeshQualityReport {
  readonly triangles: number;
  readonly ngons: number;
  /** Triangle area (square meters) and triangles per square meter. */
  readonly area: number;
  readonly density: number;
  readonly aspect: {
    readonly p50: number;
    readonly p90: number;
    readonly max: number;
    readonly over6: number;
  };
  readonly minAngle: { readonly p10: number; readonly min: number };
  /** Interior vertices (every incident face measured) and the share of valence 3 or at least 9. */
  readonly valence: {
    readonly interior: number;
    readonly bad: number;
    readonly byValence: Readonly<Record<string, number>>;
  };
  readonly sizeRatio: { readonly p95: number; readonly max: number };
  /**
   * With `flow`: the angle (degrees, at most 90) between each triangle's longest edge and its
   * guide's flow at the centroid, over the triangles of aspect 1.5 or more (`measured`); the
   * rounder ones are the `skipped` share (gated, so a near-isotropic tiling cannot pass by
   * skipping). The one owner of the flow measure: remesh reports and plan gates call it.
   * With a guide's `border`, the measured triangles split into `border` rows (`share` of the
   * measured) and the `interior`; `p75` stays over every measured triangle, and the gate
   * takes the interior's.
   */
  readonly flow?: {
    readonly p50: number;
    readonly p75: number;
    readonly measured: number;
    readonly skipped: number;
    readonly interior?: { readonly p75: number; readonly n: number };
    readonly border?: { readonly p75: number; readonly n: number; readonly share: number };
  };
  readonly limits: MeshQualityLimits;
  /** Limits the region exceeds (names of `MeshQualityLimits`); empty when it passes. */
  readonly failed: readonly (keyof MeshQualityLimits)[];
}

const EPSILON = 1e-9;

function flowSummary(
  angles: number[],
  skipped: number,
  rows?: { interior: number[]; border: number[] },
): NonNullable<MeshQualityReport['flow']> {
  angles.sort((x, y) => x - y);
  const total = angles.length + skipped;
  const summary = {
    p50: quantile(angles, 0.5),
    p75: quantile(angles, 0.75),
    measured: angles.length,
    skipped: total === 0 ? 0 : skipped / total,
  };
  if (rows === undefined) return summary;
  rows.interior.sort((x, y) => x - y);
  rows.border.sort((x, y) => x - y);
  return {
    ...summary,
    interior: { p75: quantile(rows.interior, 0.75), n: rows.interior.length },
    border: {
      p75: quantile(rows.border, 0.75),
      n: rows.border.length,
      share: angles.length === 0 ? 0 : rows.border.length / angles.length,
    },
  };
}

/**
 * A structure line's direction at edge h of face f, or undefined when the edge is not one:
 * an open edge, a sharp edge, or one between faces of different labels or materials.
 */
function structureEdge(mesh: EditMesh, f: number, h: number): Tuple3 | undefined {
  const g = mesh.hFace[h ^ 1] as number;
  const line =
    g === NONE ||
    ((mesh.eFlags[h >> 1] as number) & EDGE_SHARP) !== 0 ||
    mesh.fLabel[f] !== mesh.fLabel[g] ||
    mesh.fMaterial[f] !== mesh.fMaterial[g];
  if (!line) return undefined;
  const p = mesh.position(mesh.hVert[h] as number);
  const q = mesh.position(mesh.hVert[mesh.hNext[h] as number] as number);
  return [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
}

/** The value at fraction `q` of the sorted values (index floor(q (n - 1))). */
function quantile(sorted: readonly number[], q: number): number {
  return sorted.length === 0 ? 0 : (sorted[Math.floor(q * (sorted.length - 1))] as number);
}

export function meshQuality(
  mesh: EditMesh,
  faces: readonly number[],
  limits: Partial<MeshQualityLimits> = {},
  flow?: readonly ResolvedFlowGuide[],
): Result<MeshQualityReport, ModelingError> {
  const merged: MeshQualityLimits = { ...MESH_QUALITY_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      return err(
        modelingError('model-invalid-argument', `limits.${name} is a finite number >= 0`, {
          [name]: value,
        }),
      );
    }
  }
  const region = new Set(faces);
  const aspects: number[] = [];
  const angles: number[] = [];
  const scale = new Map<number, number>();
  let area = 0;
  let ngons = 0;
  const flowAngles: number[] = [];
  let flowSkipped = 0;
  const rows = flow?.some((g) => g.crossing !== undefined)
    ? { interior: [] as number[], border: [] as number[] }
    : undefined;
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    if (vs.length !== 3) {
      ngons++;
      continue;
    }
    const [a, b, c] = vs.map((v) => mesh.position(v)) as unknown as [Tuple3, Tuple3, Tuple3];
    const dist = (p: Tuple3, q: Tuple3) => hypot3(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const e = [dist(b, c), dist(c, a), dist(a, b)] as [number, number, number];
    const s = (e[0] + e[1] + e[2]) / 2;
    const A = Math.sqrt(Math.max(0, s * (s - e[0]) * (s - e[1]) * (s - e[2])));
    area += A;
    const longest = maxOf(e);
    aspects.push(A > 0 ? (longest * longest) / (2 * A) : Number.POSITIVE_INFINITY);
    // Law of cosines per corner; the smallest angle faces the shortest edge.
    let smallest = 180;
    for (let i = 0; i < 3; i++) {
      const opposite = e[i] as number;
      const p = e[(i + 1) % 3] as number;
      const q = e[(i + 2) % 3] as number;
      const cos = p > 0 && q > 0 ? (p * p + q * q - opposite * opposite) / (2 * p * q) : 1;
      const k = Math.min(1, Math.max(-1, cos));
      smallest = Math.min(smallest, (atan2(Math.sqrt(1 - k * k), k) * 180) / Math.PI);
    }
    angles.push(smallest);
    scale.set(f, (e[0] + e[1] + e[2]) / 3);
    const guide = flow?.find((g) => g.faces === undefined || g.faces.has(f));
    if (guide !== undefined && A > 0) {
      const ab: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = ab[1] * ac[2] - ab[2] * ac[1];
      const ny = ab[2] * ac[0] - ab[0] * ac[2];
      const nz = ab[0] * ac[1] - ab[1] * ac[0];
      const nl = hypot3(nx, ny, nz);
      const normal: Tuple3 = [nx / nl, ny / nl, nz / nl];
      const centroid: Tuple3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      const d = flowAt(guide.flow, centroid, normal);
      if (d !== undefined) {
        if ((longest * longest) / (2 * A) < FLOW_ASPECT) flowSkipped++;
        else {
          // The longest edge is opposite the corner whose edge length e[i] is largest.
          const i = e.indexOf(longest);
          const [p, q] = i === 0 ? [b, c] : i === 1 ? [c, a] : [a, b];
          const angle = lineAngle([q[0] - p[0], q[1] - p[1], q[2] - p[2]], d);
          flowAngles.push(angle);
          if (rows !== undefined) {
            // A border row: an edge on a structure line crossing the flow at its midpoint.
            const crossing = guide.crossing;
            const border =
              crossing !== undefined &&
              mesh.faceHalves(f).some((h) => {
                const line = structureEdge(mesh, f, h);
                if (line === undefined) return false;
                const m = mesh.position(mesh.hVert[h] as number);
                const at: Tuple3 = [m[0] + line[0] / 2, m[1] + line[1] / 2, m[2] + line[2] / 2];
                const there = flowAt(guide.flow, at, normal);
                return there !== undefined && lineAngle(line, there) > crossing;
              });
            (border ? rows.border : rows.interior).push(angle);
          }
        }
      }
    }
  }
  aspects.sort((x, y) => x - y);
  angles.sort((x, y) => x - y);
  // Interior vertices: off any open boundary, every face around them (in the whole mesh) in
  // the region; their valence is the number of distinct neighbours.
  const around = new Map<number, number[]>();
  const open = new Set<number>();
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      if ((mesh.hFace[h ^ 1] as number) !== NONE) continue;
      open.add(mesh.hVert[h] as number);
      open.add(mesh.hVert[mesh.hNext[h] as number] as number);
    }
    for (const v of mesh.faceVertices(f)) {
      const list = around.get(v);
      if (list === undefined) around.set(v, [f]);
      else list.push(f);
    }
  }
  const byValence: Record<string, number> = {};
  let interior = 0;
  let bad = 0;
  const seen = new Set<number>();
  for (const f of faces) {
    for (const v of mesh.faceVertices(f)) {
      if (seen.has(v)) continue;
      seen.add(v);
      const incident = around.get(v) ?? [];
      if (open.has(v) || !incident.every((g) => region.has(g))) continue;
      const neighbours = new Set<number>();
      for (const g of incident) {
        const vs = mesh.faceVertices(g);
        const i = vs.indexOf(v);
        neighbours.add(vs[(i + 1) % vs.length] as number);
        neighbours.add(vs[(i + vs.length - 1) % vs.length] as number);
      }
      const valence = neighbours.size;
      interior++;
      byValence[valence] = (byValence[valence] ?? 0) + 1;
      if (valence === 3 || valence >= 9) bad++;
    }
  }
  // Size ratio across the region's interior edges.
  const ratios: number[] = [];
  for (const f of faces) {
    const own = scale.get(f);
    if (own === undefined) continue;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      const other = g > f ? scale.get(g) : undefined;
      if (other !== undefined && own > 0 && other > 0)
        ratios.push(Math.max(own, other) / Math.min(own, other));
    }
  }
  ratios.sort((x, y) => x - y);
  const triangles = aspects.length;
  const report = {
    triangles,
    ngons,
    area,
    density: area > 0 ? triangles / area : 0,
    aspect: {
      p50: quantile(aspects, 0.5),
      p90: quantile(aspects, 0.9),
      max: aspects.at(-1) ?? 0,
      over6: triangles === 0 ? 0 : aspects.filter((x) => x > 6).length / triangles,
    },
    minAngle: { p10: quantile(angles, 0.1), min: angles[0] ?? 0 },
    valence: { interior, bad: interior === 0 ? 0 : bad / interior, byValence },
    sizeRatio: { p95: quantile(ratios, 0.95), max: ratios.at(-1) ?? 0 },
    ...(flow === undefined ? {} : { flow: flowSummary(flowAngles, flowSkipped, rows) }),
    limits: merged,
  };
  // Limits hold up to rounding (a right isosceles triangle measures 2 + 1e-15).
  const above = (value: number, limit: number) => value > limit + EPSILON * Math.max(1, limit);
  const failed: (keyof MeshQualityLimits)[] = [];
  if (above(report.aspect.p50, merged.aspectP50)) failed.push('aspectP50');
  if (above(report.aspect.p90, merged.aspectP90)) failed.push('aspectP90');
  if (above(report.aspect.over6, merged.over6)) failed.push('over6');
  if (above(merged.minAngleP10, report.minAngle.p10)) failed.push('minAngleP10');
  if (above(report.valence.bad, merged.badValence)) failed.push('badValence');
  if (above(report.sizeRatio.p95, merged.sizeRatioP95)) failed.push('sizeRatioP95');
  if (report.flow !== undefined) {
    // With border rows the gate takes the interior; the border share is gated too.
    const gated = report.flow.interior ?? { p75: report.flow.p75, n: report.flow.measured };
    if (gated.n === 0 || above(gated.p75, merged.flowP75)) failed.push('flowP75');
    if (above(report.flow.skipped, merged.flowSkipped)) failed.push('flowSkipped');
    if (report.flow.border !== undefined && above(report.flow.border.share, merged.flowBorderShare))
      failed.push('flowBorderShare');
  }
  return ok({ ...report, failed });
}
