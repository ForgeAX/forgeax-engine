// Sampled fidelity metrics: symmetric Hausdorff distance and sharp-edge coverage.
// Independent of the kernel's mesh-query helpers on purpose (see design note, method sources).

import {
  type Bounds,
  boundsOf,
  cross,
  dot,
  type EvalMesh,
  length,
  normalize,
  sub,
  type Vec3,
} from './mesh.ts';
import { elementInfo, quantile } from './metrics.ts';

export interface Tri {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
}

export interface Seg {
  readonly a: Vec3;
  readonly b: Vec3;
}

export const HAUSDORFF_SAMPLE_CAP = 200_000;
export const SHARP_DIHEDRAL_DEG = 30;
export const SHARP_SAMPLES_PER_EDGE = 8;
export const SHARP_TOL_REL = 1e-3;

/** Fan-triangulate every face of the mesh (faces are 3 or 4 sides in the JSON contract; n-gons fan too). */
export function fanTriangles(mesh: EvalMesh): Tri[] {
  const out: Tri[] = [];
  for (const loop of mesh.faces) {
    const p0 = mesh.positions[loop[0] as number] as [number, number, number];
    for (let i = 1; i + 1 < loop.length; i++)
      out.push({
        a: p0,
        b: mesh.positions[loop[i] as number] as [number, number, number],
        c: mesh.positions[loop[i + 1] as number] as [number, number, number],
      });
  }
  return out;
}

export function segmentsOf(mesh: EvalMesh): Seg[] {
  const out: Seg[] = [];
  for (const loop of mesh.faces)
    for (let i = 0; i < loop.length; i++)
      out.push({
        a: mesh.positions[loop[i] as number] as [number, number, number],
        b: mesh.positions[loop[(i + 1) % loop.length] as number] as [number, number, number],
      });
  return out;
}

/** Distance from p to segment ab. */
export function segmentDistance(p: Vec3, s: Seg): number {
  const ab = sub(s.b, s.a);
  const ap = sub(p, s.a);
  const denom = dot(ab, ab);
  const t = denom > 0 ? Math.min(1, Math.max(0, dot(ap, ab) / denom)) : 0;
  return length(sub(p, [s.a[0] + ab[0] * t, s.a[1] + ab[1] * t, s.a[2] + ab[2] * t]));
}

/** Exact distance from p to triangle abc (Ericson, Real-Time Collision Detection, 5.1.5). */
export function triangleDistance(p: Vec3, t: Tri): number {
  const { a, b, c } = t;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return length(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return length(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return length(sub(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return length(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return length(sub(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return length(sub(p, [b[0] + bc[0] * w, b[1] + bc[1] * w, b[2] + bc[2] * w]));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const q: Vec3 = [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ];
  return length(sub(p, q));
}

/**
 * Uniform grid over bounded primitives. A primitive is registered in every cell its bounding box overlaps.
 * nearest() expands Chebyshev rings and stops once the best distance is within the ring's guaranteed clearance.
 */
export class UniformGrid<T> {
  private readonly cells = new Map<number, T[]>();
  private readonly min: Vec3;
  private readonly cell: number;
  private readonly dims: readonly [number, number, number];
  private readonly distance: (p: Vec3, item: T) => number;

  /** `region` must contain every query point, or the clearance bound in nearest() does not hold. */
  constructor(
    items: readonly T[],
    boxOf: (item: T) => readonly [Vec3, Vec3],
    distance: (p: Vec3, item: T) => number,
    region: Bounds,
    perAxis = Math.min(64, Math.max(1, Math.ceil(2 * Math.cbrt(items.length)))),
  ) {
    this.distance = distance;
    this.min = region.min;
    const extent = sub(region.max, region.min);
    const diag = region.diag;
    const span = Math.max(extent[0], extent[1], extent[2], diag * 1e-9, 1e-12);
    this.cell = span / perAxis;
    this.dims = [
      Math.max(1, Math.floor(extent[0] / this.cell) + 1),
      Math.max(1, Math.floor(extent[1] / this.cell) + 1),
      Math.max(1, Math.floor(extent[2] / this.cell) + 1),
    ];
    for (const item of items) {
      const [lo, hi] = boxOf(item);
      const i0 = this.index(lo);
      const i1 = this.index(hi);
      for (let z = i0[2]; z <= i1[2]; z++)
        for (let y = i0[1]; y <= i1[1]; y++)
          for (let x = i0[0]; x <= i1[0]; x++) {
            const key = this.key(x, y, z);
            let list = this.cells.get(key);
            if (list === undefined) {
              list = [];
              this.cells.set(key, list);
            }
            list.push(item);
          }
    }
  }

  private index(p: Vec3): [number, number, number] {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    return [
      clamp(Math.floor((p[0] - this.min[0]) / this.cell), this.dims[0]),
      clamp(Math.floor((p[1] - this.min[1]) / this.cell), this.dims[1]),
      clamp(Math.floor((p[2] - this.min[2]) / this.cell), this.dims[2]),
    ];
  }

  private key(x: number, y: number, z: number): number {
    return x + this.dims[0] * (y + this.dims[1] * z);
  }

  /** Smallest distance from p to any stored primitive; Infinity when the grid is empty. */
  nearest(p: Vec3): number {
    const [cx, cy, cz] = this.index(p);
    const [nx, ny, nz] = this.dims;
    const maxR = Math.max(nx, ny, nz);
    let best = Infinity;
    const visit = (x: number, y: number, z: number): void => {
      for (const item of this.cells.get(this.key(x, y, z)) ?? [])
        best = Math.min(best, this.distance(p, item));
    };
    for (let r = 0; r <= maxR; r++) {
      // Enumerate only in-bounds cells on the Chebyshev shell of radius r (cost is the shell, not the cube).
      for (let dz = -r; dz <= r; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= nz) continue;
        const faceZ = Math.abs(dz) === r;
        for (let dy = -r; dy <= r; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= ny) continue;
          if (faceZ || Math.abs(dy) === r) {
            for (let dx = -r; dx <= r; dx++) {
              const x = cx + dx;
              if (x >= 0 && x < nx) visit(x, y, z);
            }
          } else {
            if (cx - r >= 0) visit(cx - r, y, z);
            if (cx + r < nx && r > 0) visit(cx + r, y, z);
          }
        }
      }
      if (best <= r * this.cell) break;
      const covered =
        cx - r <= 0 &&
        cy - r <= 0 &&
        cz - r <= 0 &&
        cx + r >= nx - 1 &&
        cy + r >= ny - 1 &&
        cz + r >= nz - 1;
      if (covered) break;
    }
    return best;
  }
}

function triangleBox(t: Tri): [Vec3, Vec3] {
  return [
    [
      Math.min(t.a[0], t.b[0], t.c[0]),
      Math.min(t.a[1], t.b[1], t.c[1]),
      Math.min(t.a[2], t.b[2], t.c[2]),
    ],
    [
      Math.max(t.a[0], t.b[0], t.c[0]),
      Math.max(t.a[1], t.b[1], t.c[1]),
      Math.max(t.a[2], t.b[2], t.c[2]),
    ],
  ];
}

function segmentBox(s: Seg): [Vec3, Vec3] {
  return [
    [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.min(s.a[2], s.b[2])],
    [Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1]), Math.max(s.a[2], s.b[2])],
  ];
}

function triangleArea(t: Tri): number {
  return 0.5 * length(cross(sub(t.b, t.a), sub(t.c, t.a)));
}

/** Barycentric grid points on triangles at roughly one sample per h^2 of area. */
function samplePoints(tris: readonly Tri[], h: number): Vec3[] {
  const out: Vec3[] = [];
  for (const t of tris) {
    const k = Math.max(1, Math.ceil(Math.sqrt(2 * triangleArea(t)) / h));
    for (let i = 0; i <= k; i++)
      for (let j = 0; j <= k - i; j++) {
        const u = i / k;
        const v = j / k;
        const w = 1 - u - v;
        out.push([
          t.a[0] * w + t.b[0] * u + t.c[0] * v,
          t.a[1] * w + t.b[1] * u + t.c[1] * v,
          t.a[2] * w + t.b[2] * u + t.c[2] * v,
        ]);
      }
  }
  return out;
}

function pointCount(tris: readonly Tri[], h: number): number {
  let n = 0;
  for (const t of tris) {
    const k = Math.max(1, Math.ceil(Math.sqrt(2 * triangleArea(t)) / h));
    n += ((k + 1) * (k + 2)) / 2;
  }
  return n;
}

export interface Hausdorff {
  readonly max: number;
  readonly mean: number;
  readonly samples: number;
  /** Sample spacing actually used (diag / 150 unless the 200 000 per-side cap widened it). */
  readonly spacing: number;
}

export function hausdorff(a: EvalMesh, b: EvalMesh, diag: number): Hausdorff {
  const triA = fanTriangles(a);
  const triB = fanTriangles(b);
  const scale = diag > 0 ? diag : 1;
  let h = scale / 150;
  while (Math.max(pointCount(triA, h), pointCount(triB, h)) > HAUSDORFF_SAMPLE_CAP) h *= 1.1;

  const region = boundsOf([...a.positions, ...b.positions]);
  const gridA = new UniformGrid(triA, triangleBox, triangleDistance, region);
  const gridB = new UniformGrid(triB, triangleBox, triangleDistance, region);
  const dirAB = directed(samplePoints(triA, h), gridB);
  const dirBA = directed(samplePoints(triB, h), gridA);
  return {
    max: Math.max(dirAB.max, dirBA.max),
    mean: (dirAB.mean + dirBA.mean) / 2,
    samples: dirAB.n + dirBA.n,
    spacing: h,
  };
}

function directed(
  points: readonly Vec3[],
  grid: UniformGrid<Tri>,
): { max: number; mean: number; n: number } {
  let max = 0;
  let sum = 0;
  for (const p of points) {
    const d = grid.nearest(p);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: points.length === 0 ? 0 : sum / points.length, n: points.length };
}

export interface SharpEdge {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly dihedralDeg: number;
}

/** Reference edges shared by two faces whose unoriented normals differ by more than the threshold. */
export function sharpEdges(
  ref: EvalMesh,
  diag: number,
  thresholdDeg = SHARP_DIHEDRAL_DEG,
): SharpEdge[] {
  const normals = elementInfo(ref, diag).map((e) => e.normal);
  const byEdge = new Map<string, { a: number; b: number; faces: number[] }>();
  ref.faces.forEach((loop, face) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      if (a === b) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}:${hi}`;
      let rec = byEdge.get(key);
      if (rec === undefined) {
        rec = { a: lo, b: hi, faces: [] };
        byEdge.set(key, rec);
      }
      rec.faces.push(face);
    }
  });
  const out: SharpEdge[] = [];
  for (const rec of byEdge.values()) {
    if (rec.faces.length !== 2) continue;
    const n1 = normals[rec.faces[0] as number] as [number, number, number];
    const n2 = normals[rec.faces[1] as number] as [number, number, number];
    if (length(n1) === 0 || length(n2) === 0) continue;
    const cos = Math.min(1, Math.abs(dot(normalize(n1), normalize(n2))));
    const deg = (Math.acos(cos) * 180) / Math.PI;
    if (deg > thresholdDeg)
      out.push({
        a: ref.positions[rec.a] as [number, number, number],
        b: ref.positions[rec.b] as [number, number, number],
        dihedralDeg: deg,
      });
  }
  return out;
}

export interface SharpCoverage {
  readonly edges: number;
  readonly samples: number;
  readonly max: number;
  readonly p95: number;
  readonly covered: number;
}

/** Distance from each sharp-edge sample to the producer's nearest edge, and the share within tolerance. */
export function sharpCoverage(
  producer: EvalMesh,
  diag: number,
  sharp: readonly SharpEdge[],
): SharpCoverage | null {
  if (sharp.length === 0) return null;
  const region = boundsOf([...producer.positions, ...sharp.flatMap((e) => [e.a, e.b])]);
  const grid = new UniformGrid(segmentsOf(producer), segmentBox, segmentDistance, region);
  const distances: number[] = [];
  for (const e of sharp)
    for (let i = 0; i < SHARP_SAMPLES_PER_EDGE; i++) {
      const t = i / (SHARP_SAMPLES_PER_EDGE - 1);
      const p: Vec3 = [
        e.a[0] + (e.b[0] - e.a[0]) * t,
        e.a[1] + (e.b[1] - e.a[1]) * t,
        e.a[2] + (e.b[2] - e.a[2]) * t,
      ];
      distances.push(grid.nearest(p));
    }
  const sorted = [...distances].sort((x, y) => x - y);
  const tol = SHARP_TOL_REL * (diag > 0 ? diag : 1);
  const within = distances.filter((d) => d <= tol).length;
  return {
    edges: sharp.length,
    samples: distances.length,
    max: sorted[sorted.length - 1] ?? 0,
    p95: quantile(sorted, 0.95),
    covered: within / distances.length,
  };
}
