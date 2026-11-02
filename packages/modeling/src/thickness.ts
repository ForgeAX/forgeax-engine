import {
  cross,
  dot,
  faceCentroid,
  faceNormal,
  sub,
  type Tuple3,
  triangulateLoop,
  windingNumber,
} from './geom';
import { type EditMesh, NONE } from './mesh';

interface Triangle {
  readonly face: number;
  readonly a: Tuple3;
  readonly b: Tuple3;
  readonly c: Tuple3;
}

/** Ray parameter of the hit with a triangle (Moller-Trumbore), or undefined. */
function hit(origin: Tuple3, direction: Tuple3, t: Triangle): number | undefined {
  const e1 = sub(t.b, t.a);
  const e2 = sub(t.c, t.a);
  const p = cross(direction, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-15) return undefined;
  const s = sub(origin, t.a);
  const u = dot(s, p) / det;
  if (u < 0 || u > 1) return undefined;
  const q = cross(s, e1);
  const v = dot(direction, q) / det;
  if (v < 0 || u + v > 1) return undefined;
  return dot(e2, q) / det;
}

/** Nearest ray hits against a mesh's triangles, bucketed in a uniform grid. */
export interface RayGrid {
  /**
   * Nearest hit along `direction` (unit) within `(minimum, maxDistance]`, ignoring
   * faces for which `skip` is true.
   */
  cast(
    origin: Tuple3,
    direction: Tuple3,
    maxDistance: number,
    skip: (face: number) => boolean,
    minimum?: number,
  ): { readonly distance: number; readonly face: number } | undefined;
}

/**
 * Bucket the triangles of `faces` (default: every face) in a uniform grid whose cells
 * are at least `reach` wide, so a ray of that length visits a few cells.
 */
export function rayGrid(mesh: EditMesh, reach: number, faces = mesh.faces()): RayGrid {
  const triangles: Triangle[] = [];
  for (const f of faces) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => points[indices[i + k] as number] as Tuple3) as [
        Tuple3,
        Tuple3,
        Tuple3,
      ];
      triangles.push({ face: f, a, b, c });
    }
  }
  // Cells follow the ray reach and the typical triangle, so a short ray visits a few
  // small buckets; the hit test and the nearest distance do not depend on the cell.
  let extent = 0;
  const sizes: number[] = [];
  for (const t of triangles) {
    let size = 0;
    for (let k = 0; k < 3; k++) {
      const span =
        Math.max(t.a[k] as number, t.b[k] as number, t.c[k] as number) -
        Math.min(t.a[k] as number, t.b[k] as number, t.c[k] as number);
      size = Math.max(size, span);
    }
    sizes.push(size);
    extent = Math.max(extent, size);
  }
  sizes.sort((a, b) => a - b);
  const typical = sizes[sizes.length >> 1] ?? 0;
  const cell = Math.max(reach, typical / 2, extent / 1024, 1e-9);
  const OFFSET = 1 << 20;
  const key = (x: number, y: number, z: number) =>
    ((x + OFFSET) * 2097152 + (y + OFFSET)) * 2097152 + (z + OFFSET);
  const grid = new Map<number, Triangle[]>();
  const range = (lo: number, hi: number) => [Math.floor(lo / cell), Math.floor(hi / cell)];
  for (const t of triangles) {
    const [x0, x1] = range(Math.min(t.a[0], t.b[0], t.c[0]), Math.max(t.a[0], t.b[0], t.c[0]));
    const [y0, y1] = range(Math.min(t.a[1], t.b[1], t.c[1]), Math.max(t.a[1], t.b[1], t.c[1]));
    const [z0, z1] = range(Math.min(t.a[2], t.b[2], t.c[2]), Math.max(t.a[2], t.b[2], t.c[2]));
    for (let x = x0 as number; x <= (x1 as number); x++) {
      for (let y = y0 as number; y <= (y1 as number); y++) {
        for (let z = z0 as number; z <= (z1 as number); z++) {
          const list = grid.get(key(x, y, z));
          if (list === undefined) grid.set(key(x, y, z), [t]);
          else list.push(t);
        }
      }
    }
  }
  return {
    cast(origin, direction, maxDistance, skip, minimum = 1e-12) {
      const end: Tuple3 = [
        origin[0] + direction[0] * maxDistance,
        origin[1] + direction[1] * maxDistance,
        origin[2] + direction[2] * maxDistance,
      ];
      const [x0, x1] = range(Math.min(origin[0], end[0]), Math.max(origin[0], end[0]));
      const [y0, y1] = range(Math.min(origin[1], end[1]), Math.max(origin[1], end[1]));
      const [z0, z1] = range(Math.min(origin[2], end[2]), Math.max(origin[2], end[2]));
      let best = Infinity;
      let face = -1;
      for (let x = x0 as number; x <= (x1 as number); x++) {
        for (let y = y0 as number; y <= (y1 as number); y++) {
          for (let z = z0 as number; z <= (z1 as number); z++) {
            for (const t of grid.get(key(x, y, z)) ?? []) {
              if (skip(t.face)) continue;
              const d = hit(origin, direction, t);
              if (d !== undefined && d > minimum && d < best) {
                best = d;
                face = t.face;
              }
            }
          }
        }
      }
      return best <= maxDistance ? { distance: best, face } : undefined;
    },
  };
}

/**
 * Distance from each face centroid to the nearest other face along the reversed
 * face normal, up to `maxWidth` (absent beyond it). Only faces the ray leaves through
 * their back count, except walls of another part whose solid contains the start
 * (overlapping parts); hits within `minimum` are the face's own contact (a part resting
 * within tolerance) and are ignored.
 */
export function faceThickness(
  mesh: EditMesh,
  maxWidth: number,
  minimum = 1e-12,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!(maxWidth > 0)) return out;
  const grid = rayGrid(mesh, maxWidth);
  const normals = new Map(mesh.faces().map((f) => [f, faceNormal(mesh, f)] as const));
  const part = components(mesh);
  for (const f of mesh.faces()) {
    const n = normals.get(f) as Tuple3;
    const back: Tuple3 = [-n[0], -n[1], -n[2]];
    const origin = faceCentroid(mesh, f);
    const own = part.of.get(f) as number;
    const inside = new Map<number, boolean>();
    // The far side of this wall is a face the ray leaves through its back. A face hit
    // from the front, or the wall of another part whose solid already contains the
    // start (overlapping parts), measures that other body, not this wall.
    const foreign = (g: number) => {
      const c = part.of.get(g) as number;
      if (c === own) return false;
      let known = inside.get(c);
      if (known === undefined) {
        known = windingNumber(mesh, part.faces[c] as number[], origin) > 0.5;
        inside.set(c, known);
      }
      return known;
    };
    const found = grid.cast(
      origin,
      back,
      maxWidth,
      (g) => g === f || dot(back, normals.get(g) as Tuple3) <= 0 || foreign(g),
      minimum,
    );
    if (found !== undefined) out.set(f, found.distance);
  }
  return out;
}

/** Edge-connected face components. */
function components(mesh: EditMesh): { of: Map<number, number>; faces: number[][] } {
  const of = new Map<number, number>();
  const faces: number[][] = [];
  for (const seed of mesh.faces()) {
    if (of.has(seed)) continue;
    const list: number[] = [];
    const stack = [seed];
    of.set(seed, faces.length);
    while (stack.length > 0) {
      const f = stack.pop() as number;
      list.push(f);
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g !== NONE && !of.has(g)) {
          of.set(g, faces.length);
          stack.push(g);
        }
      }
    }
    faces.push(list);
  }
  return { of, faces };
}
