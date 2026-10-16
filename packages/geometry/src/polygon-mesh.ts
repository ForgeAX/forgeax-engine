import type { AssetError, MeshAsset, Result } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import { meshFromInterleaved } from './box';
import { geometryError, triangulatePolygon } from './contour';
import type { Vec2Point, Vec3Point } from './procedural';

export interface PolygonRing {
  readonly v: number;
  readonly points: readonly Vec3Point[];
  readonly section: readonly (readonly Vec2Point[])[];
}
const sub = (a: Vec3Point, b: Vec3Point): Vec3Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross3 = (a: Vec3Point, b: Vec3Point): Vec3Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function unit3(a: Vec3Point): Vec3Point {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Triangle wall strips and independent cap normals, sharing canonical mesh preparation. */
export function polygonMesh(
  rings: readonly PolygonRing[],
  capped: boolean,
): Result<MeshAsset, AssetError> {
  const first = rings[0];
  if (!first || first.points.length * rings.length > 262144)
    return err(geometryError('mesh', 'at most 262144 ring vertices'));
  const vertices: number[] = [],
    indices: number[] = [];
  const vertex = (p: Vec3Point, n: Vec3Point, u: number, v: number) => {
    const index = vertices.length / 8;
    vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v);
    return index;
  };
  for (let row = 0; row < rings.length - 1; row++) {
    const lower = rings[row] as PolygonRing,
      upper = rings[row + 1] as PolygonRing;
    let base = 0;
    for (const loop of lower.section) {
      let distance = 0;
      const perimeter = loop.reduce((sum, p, i) => {
        const q = loop[(i + 1) % loop.length] as Vec2Point;
        return sum + Math.hypot(q.x - p.x, q.y - p.y);
      }, 0);
      for (let i = 0; i < loop.length; i++) {
        const j = (i + 1) % loop.length;
        const a = lower.points[base + i] as Vec3Point,
          b = lower.points[base + j] as Vec3Point;
        const c = upper.points[base + j] as Vec3Point,
          d = upper.points[base + i] as Vec3Point;
        const n1 = cross3(sub(b, a), sub(c, a)),
          n2 = cross3(sub(c, a), sub(d, a));
        if (!(Math.hypot(...n1) > 0) || !(Math.hypot(...n2) > 0))
          return err(geometryError('mesh', 'collapsed wall triangle'));
        // Each triangle retains its geometric normal, including non-planar path quads.
        const edge = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const u = distance / perimeter,
          v = (distance + edge) / perimeter;
        const t = lower.v,
          s = upper.v;
        const normal1 = unit3(n1),
          normal2 = unit3(n2);
        indices.push(
          vertex(a, normal1, u, t),
          vertex(b, normal1, v, t),
          vertex(c, normal1, v, s),
          vertex(a, normal2, u, t),
          vertex(c, normal2, v, s),
          vertex(d, normal2, u, s),
        );
        distance += edge;
      }
      base += loop.length;
    }
  }
  if (capped)
    for (const [end, ring] of [
      [false, first],
      [true, rings.at(-1) as PolygonRing],
    ] as const) {
      const triangulated = triangulatePolygon(ring.section);
      if (!triangulated.ok) return triangulated;
      const triangles = triangulated.value,
        flat = ring.section.flat();
      for (let i = 0; i < triangles.length; i += 3) {
        const order = triangles.slice(i, i + 3);
        if (!end) order.reverse();
        const p = order.map((index) => ring.points[index] as Vec3Point);
        const n = unit3(
          cross3(
            sub(p[1] as Vec3Point, p[0] as Vec3Point),
            sub(p[2] as Vec3Point, p[0] as Vec3Point),
          ),
        );
        for (const index of order) {
          const uv = flat[index] as Vec2Point;
          indices.push(vertex(ring.points[index] as Vec3Point, n, uv.x, uv.y));
        }
      }
    }
  const packed = new Float32Array(vertices);
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] as number) * 8,
      b = (indices[i + 1] as number) * 8,
      c = (indices[i + 2] as number) * 8;
    const abx = (packed[b] as number) - (packed[a] as number),
      aby = (packed[b + 1] as number) - (packed[a + 1] as number),
      abz = (packed[b + 2] as number) - (packed[a + 2] as number);
    const acx = (packed[c] as number) - (packed[a] as number),
      acy = (packed[c + 1] as number) - (packed[a + 1] as number),
      acz = (packed[c + 2] as number) - (packed[a + 2] as number);
    const nx = aby * acz - abz * acy,
      ny = abz * acx - abx * acz,
      nz = abx * acy - aby * acx;
    const size = Math.hypot(nx, ny, nz);
    if (
      !Number.isFinite(size) ||
      size === 0 ||
      nx * (packed[a + 3] as number) +
        ny * (packed[a + 4] as number) +
        nz * (packed[a + 5] as number) <=
        0
    )
      return err(geometryError('mesh', 'triangle collapses, reverses or overflows in f32'));
  }
  return meshFromInterleaved(packed, new Uint32Array(indices));
}
