import type { Tuple3 } from '../../geom';
import { type NurbsSurface, surfaceDomain, surfacePoint } from '../../nurbs';

export type Side = 'u0' | 'u1' | 'v0' | 'v1';
export const SIDES: readonly Side[] = ['u0', 'u1', 'v0', 'v1'];

/** The slice of a session the audit reads: the mesh, its validate report and the recorded seams. */
export interface Audited {
  readonly editMesh: {
    edges(): number[];
    vertices(): number[];
    isBoundaryEdge(e: number): boolean;
    edgeVertices(e: number): [number, number];
    position(v: number): readonly [number, number, number];
  };
  validate(): { readonly issues: readonly { readonly code: string }[] };
}

export interface Named {
  readonly name: string;
  readonly surface: NurbsSurface;
  /** A trimmed patch declares holes in its domain; their open edges are not judged. */
  readonly trims?: readonly unknown[];
}

const DENSE = 1024;

/** Points of one patch side at equal parameter steps. */
export function sidePoints(s: NurbsSurface, side: Side, n: number): Tuple3[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const alongU = side === 'v0' || side === 'v1';
  const fixed = side === 'u0' ? u0 : side === 'u1' ? u1 : side === 'v0' ? v0 : v1;
  const [lo, hi] = alongU ? [u0, u1] : [v0, v1];
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = lo + ((hi - lo) * k) / n;
    return alongU ? surfacePoint(s, t, fixed) : surfacePoint(s, fixed, t);
  });
}

function distanceToSegment(p: readonly number[], a: Tuple3, b: Tuple3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [(p[0] as number) - a[0], (p[1] as number) - a[1], (p[2] as number) - a[2]];
  const len2 = (d[0] as number) ** 2 + (d[1] as number) ** 2 + (d[2] as number) ** 2;
  const t =
    len2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((w[0] as number) * (d[0] as number) +
              (w[1] as number) * (d[1] as number) +
              (w[2] as number) * (d[2] as number)) /
              len2,
          ),
        );
  return Math.hypot(
    (w[0] as number) - t * (d[0] as number),
    (w[1] as number) - t * (d[1] as number),
    (w[2] as number) - t * (d[2] as number),
  );
}

export function distanceToPolyline(p: readonly number[], line: readonly Tuple3[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k + 1 < line.length; k++) {
    best = Math.min(best, distanceToSegment(p, line[k] as Tuple3, line[k + 1] as Tuple3));
  }
  return best;
}

export interface GeometricSeam {
  readonly a: string;
  readonly sideA: Side;
  readonly b: string;
  readonly sideB: Side;
  readonly line: readonly Tuple3[];
}

/**
 * Sides of two different patches that are the same curve (every sample of one lies on the other
 * within `tolerance`). Derived from the patch geometry alone, so it does not trust the seam
 * table it audits.
 */
export function geometricSeams(patches: readonly Named[], tolerance = 1e-4): GeometricSeam[] {
  const dense = patches.map((p) => SIDES.map((side) => sidePoints(p.surface, side, DENSE)));
  const coarse = patches.map((p) => SIDES.map((side) => sidePoints(p.surface, side, 16)));
  const out: GeometricSeam[] = [];
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      for (const [si, sideA] of SIDES.entries()) {
        for (const [sj, sideB] of SIDES.entries()) {
          const line = dense[j]?.[sj] as Tuple3[];
          const same = (coarse[i]?.[si] as Tuple3[]).every(
            (p) => distanceToPolyline(p, line) <= tolerance,
          );
          const back = (coarse[j]?.[sj] as Tuple3[]).every(
            (p) => distanceToPolyline(p, dense[i]?.[si] as Tuple3[]) <= tolerance,
          );
          if (same && back) {
            out.push({
              a: (patches[i] as Named).name,
              sideA,
              b: (patches[j] as Named).name,
              sideB,
              line: dense[i]?.[si] as Tuple3[],
            });
          }
        }
      }
    }
  }
  return out;
}

export interface SeamAudit {
  readonly seams: number;
  readonly openEdges: number;
  /** Open edges lying on a seam curve: the seam did not close. */
  readonly openOnSeam: readonly string[];
  /** Open edges away from every patch side: a hole the patches did not declare. */
  readonly openOffBoundary: readonly string[];
  /** Pairs of distinct vertices at (nearly) the same place: a seam joined by position, not identity. */
  readonly duplicates: number;
  readonly issues: readonly string[];
}

const SEAM_ON = 1e-5;
const DUPLICATE = 1e-7;

const label = (s: { a: string; sideA: string; b: string; sideB: string }) =>
  [`${s.a}:${s.sideA}`, `${s.b}:${s.sideB}`].sort().join('|');

/**
 * The seam audit of a surface-built session: the geometric seams of `patches` are closed (no open
 * edge on them), every remaining open edge lies on a patch side unless some patch declares trims
 * (holes), no two distinct vertices coincide, and validate() reports nothing but the open
 * boundary itself.
 */
export function auditSeams(
  m: Audited,
  patches: readonly Named[],
  boundaryTolerance = 1e-5,
): SeamAudit {
  const holes = patches.some((p) => p.trims !== undefined && p.trims.length > 0);
  const mesh = m.editMesh;
  const seams = geometricSeams(patches);
  const sides = patches.flatMap((p) => SIDES.map((side) => sidePoints(p.surface, side, DENSE)));
  const open = mesh.edges().filter((e) => mesh.isBoundaryEdge(e));
  const openOnSeam: string[] = [];
  const openOffBoundary: string[] = [];
  for (const e of open) {
    const ends = mesh.edgeVertices(e).map((v) => mesh.position(v));
    const where = ends.map((p) => p.map((x) => x.toFixed(5)).join(',')).join(' - ');
    const onSeam = seams.find((s) => ends.every((p) => distanceToPolyline(p, s.line) <= SEAM_ON));
    if (onSeam !== undefined) openOnSeam.push(`${label(onSeam)} at ${where}`);
    else if (
      !holes &&
      !ends.every((p) => sides.some((line) => distanceToPolyline(p, line) <= boundaryTolerance))
    ) {
      openOffBoundary.push(where);
    }
  }
  const cells = new Map<string, number[]>();
  let duplicates = 0;
  const key = (p: readonly number[]) => p.map((x) => Math.round(x / DUPLICATE)).join(',');
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    const near: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const probe = [p[0] + dx * DUPLICATE, p[1] + dy * DUPLICATE, p[2] + dz * DUPLICATE];
          for (const w of cells.get(key(probe)) ?? []) near.push(w);
        }
      }
    }
    duplicates += near.filter((w) => {
      const q = mesh.position(w);
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < DUPLICATE;
    }).length;
    const k = key(p);
    cells.set(k, [...(cells.get(k) ?? []), v]);
  }
  return {
    seams: seams.length,
    openEdges: open.length,
    openOnSeam,
    openOffBoundary,
    duplicates,
    issues: m
      .validate()
      .issues.map((i) => i.code)
      .filter((c) => c !== 'mesh-open'),
  };
}
