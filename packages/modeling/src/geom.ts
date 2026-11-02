import { maxOf } from './arrays';
import { atan2, hypot3 } from './dmath';
import type { EditMesh } from './mesh';
import { orient2d } from './predicates';

export { orient2d };

export type Tuple3 = [number, number, number];

export function sub(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Tuple3, s: number): Tuple3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Tuple3): number {
  return hypot3(a[0], a[1], a[2]);
}

export function normalize(a: Tuple3): Tuple3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Newell normal scaled by twice the polygon area; robust for non-planar loops. */
/**
 * Least-squares displacement `x` with `dot(n, x) = distance` for every unit normal `n`
 * (minimum norm when the normals span fewer than three directions): exact for up to
 * three independent planes, a compromise on curved neighbourhoods.
 */
export function planeOffset(normals: readonly Tuple3[], distance: number): Tuple3 {
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b: Tuple3 = [0, 0, 0];
  for (const n of normals) {
    for (let i = 0; i < 3; i++) {
      b[i] = (b[i] as number) + distance * (n[i] as number);
      for (let j = 0; j < 3; j++)
        a[i * 3 + j] = (a[i * 3 + j] as number) + (n[i] as number) * (n[j] as number);
    }
  }
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const)
      off += Math.abs(a[p * 3 + q] as number);
    if (off < 1e-15) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + q] as number;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = ((a[q * 3 + q] as number) - (a[p * 3 + p] as number)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p] as number;
        const akq = a[k * 3 + q] as number;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k] as number;
        const aqk = a[q * 3 + k] as number;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p] as number;
        const vkq = v[k * 3 + q] as number;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const eigen = [a[0] as number, a[4] as number, a[8] as number];
  const cutoff = maxOf(eigen) * 1e-9;
  const x: Tuple3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const lambda = eigen[k] as number;
    if (lambda <= cutoff) continue;
    const col: Tuple3 = [v[k] as number, v[3 + k] as number, v[6 + k] as number];
    const coefficient = dot(col, b) / lambda;
    for (let i = 0; i < 3; i++) x[i] = (x[i] as number) + coefficient * (col[i] as number);
  }
  return x;
}

export function newell(points: readonly Tuple3[]): Tuple3 {
  const n: Tuple3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Tuple3;
    const b = points[(i + 1) % points.length] as Tuple3;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

export function facePoints(mesh: EditMesh, f: number): Tuple3[] {
  return mesh.faceVertices(f).map((v) => mesh.position(v));
}

export function faceNormal(mesh: EditMesh, f: number): Tuple3 {
  return normalize(newell(facePoints(mesh, f)));
}

export function faceArea(mesh: EditMesh, f: number): number {
  return length(newell(facePoints(mesh, f))) / 2;
}

export function faceCentroid(mesh: EditMesh, f: number): Tuple3 {
  const points = facePoints(mesh, f);
  const c: Tuple3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return scale(c, 1 / points.length);
}

/** Signed volume of a closed, consistently oriented mesh (outward normals give a positive value). */
export function meshVolume(mesh: EditMesh): number {
  return facesVolume(mesh, mesh.faces());
}

/**
 * Signed volume enclosed by the given faces; meaningful when they form a closed shell.
 * The tetrahedra share the apex `reference` (default: the first face's first point), not
 * the world origin, so a part far from the origin keeps its precision; an open set's
 * result depends on that apex.
 */
export function facesVolume(
  mesh: EditMesh,
  faces: readonly number[],
  reference: Tuple3 | undefined = faces.length === 0
    ? undefined
    : (facePoints(mesh, faces[0] as number)[0] as Tuple3),
): number {
  if (reference === undefined) return 0;
  let volume = 0;
  for (const f of faces) {
    const points = facePoints(mesh, f).map((p) => sub(p, reference));
    const o = points[0] as Tuple3;
    for (let i = 1; i + 1 < points.length; i++) {
      volume += dot(o, cross(points[i] as Tuple3, points[i + 1] as Tuple3)) / 6;
    }
  }
  return volume;
}

export type Axis = 'x' | 'y' | 'z';
export type SignedAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export function axisVector(axis: SignedAxis | Axis): Tuple3 {
  const sign = axis.startsWith('-') ? -1 : 1;
  const name = axis.slice(-1) as Axis;
  return name === 'x' ? [sign, 0, 0] : name === 'y' ? [0, sign, 0] : [0, 0, sign];
}

export function axisIndex(axis: Axis): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

/**
 * Triangulate one polygon loop into local corner index triples. Strictly convex
 * loops (every corner turns by more than SLIVER) use a fan from corner 0, or, when
 * that fan has a triangle thinner than F32_SAFE_STEPS f32 steps at the loop's
 * coordinates, from the corner whose fan's thinnest triangle is highest; other
 * loops, including loops with collinear or near-collinear corners left by edge
 * splits, use ear clipping in the plane of their Newell normal that always clips
 * the best-shaped ear, so it never emits a zero-area ear and keeps slivers that
 * would collapse in f32 for last resort.
 */
/** Normalized area below which a corner counts as straight (relative sine about 4e-6). */
const SLIVER = 1e-6;
/**
 * A fan triangle lower than this many f32 steps (2^-23 of the largest coordinate) can
 * flip once the part is exported or moved into another frame (a joint's): wide enough
 * for the rounding of a rigid transform to a few times the loop's distance from the origin.
 */
const F32_SAFE_STEPS = 64;
const F32_STEP = 1.1920928955078125e-7;

export function triangulateLoop(points: readonly Tuple3[]): number[] | undefined {
  const n = points.length;
  if (n === 3) return [0, 1, 2];
  const normal = newell(points);
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  // Cyclic successors (y,z), (z,x), (x,y) form a right-handed frame around +drop.
  let u = (drop + 1) % 3;
  let w = (drop + 2) % 3;
  if ((normal[drop] as number) < 0) [u, w] = [w, u];
  const reach = maxOf(points.flatMap((p) => p.map(Math.abs)));
  const safe = F32_SAFE_STEPS * F32_STEP * reach;
  const dropped = triangulateProjected(
    points.map((p) => p[u] as number),
    points.map((p) => p[w] as number),
    safe,
  );
  if (dropped === undefined || agrees(points, dropped, normal)) return dropped;
  // A twisted loop whose normal has no clear dominant axis (two components tie) projects
  // at a steep angle onto the dropped-axis plane, where a zigzag can turn an ear against
  // the face normal; the Newell plane itself keeps every counter-clockwise ear positive.
  const e1 = normalize(
    Math.abs(normal[0]) <= Math.abs(normal[1]) && Math.abs(normal[0]) <= Math.abs(normal[2])
      ? cross(normal, [1, 0, 0])
      : Math.abs(normal[1]) <= Math.abs(normal[2])
        ? cross(normal, [0, 1, 0])
        : cross(normal, [0, 0, 1]),
  );
  const e2 = normalize(cross(normal, e1));
  const planar = triangulateProjected(
    points.map((p) => dot(p, e1)),
    points.map((p) => dot(p, e2)),
    safe,
  );
  return planar ?? dropped;
}

/** Every triangle of a loop triangulation faces along the loop's normal. */
function agrees(points: readonly Tuple3[], triangles: readonly number[], normal: Tuple3): boolean {
  for (let i = 0; i < triangles.length; i += 3) {
    const a = points[triangles[i] as number] as Tuple3;
    const b = points[triangles[i + 1] as number] as Tuple3;
    const c = points[triangles[i + 2] as number] as Tuple3;
    if (dot(cross(sub(b, a), sub(c, a)), normal) <= 0) return false;
  }
  return true;
}

/**
 * Fan or best-ear clipping of a loop given its counter-clockwise 2D projection; a fan
 * triangle lower than `safe` (in projection, at most its true height) is too thin.
 */
function triangulateProjected(
  xs: readonly number[],
  ys: readonly number[],
  safe: number,
): number[] | undefined {
  const n = xs.length;
  const turn = (a: number, b: number, c: number): number =>
    orient2d(
      xs[a] as number,
      ys[a] as number,
      xs[b] as number,
      ys[b] as number,
      xs[c] as number,
      ys[c] as number,
    );
  // Normalized ear area: twice the area over the summed squared edges. Corners below
  // SLIVER (inserted points an ulp off their edge) count as straight: an f64-positive
  // sliver collapses or inverts once export converts positions to f32.
  const quality = (a: number, b: number, c: number): number => {
    const d2 = (i: number, j: number) => {
      const dx = (xs[i] as number) - (xs[j] as number);
      const dy = (ys[i] as number) - (ys[j] as number);
      return dx * dx + dy * dy;
    };
    const span = d2(a, b) + d2(b, c) + d2(c, a);
    return span === 0 ? 0 : turn(a, b, c) / span;
  };
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    if (quality(i, (i + 1) % n, (i + 2) % n) <= SLIVER) convex = false;
  }
  if (convex) {
    // Height of triangle a, b, c over its longest edge.
    const height = (a: number, b: number, c: number): number => {
      const d = (i: number, j: number) => {
        const dx = (xs[i] as number) - (xs[j] as number);
        const dy = (ys[i] as number) - (ys[j] as number);
        return Math.sqrt(dx * dx + dy * dy);
      };
      const longest = Math.max(d(a, b), d(b, c), d(c, a));
      return longest === 0 ? 0 : turn(a, b, c) / longest;
    };
    const thinnest = (apex: number): number => {
      let low = Number.POSITIVE_INFINITY;
      for (let i = 1; i + 1 < n; i++) {
        low = Math.min(low, height(apex, (apex + i) % n, (apex + i + 1) % n));
      }
      return low;
    };
    let apex = 0;
    if (thinnest(0) < safe) {
      let best = thinnest(0);
      for (let k = 1; k < n; k++) {
        const low = thinnest(k);
        if (low > best) [apex, best] = [k, low];
      }
    }
    const out: number[] = [];
    for (let i = 1; i + 1 < n; i++) out.push(apex, (apex + i) % n, (apex + i + 1) % n);
    return out;
  }
  // Ear clipping on a linked ring. Every clip takes the best-scored ear (lowest index
  // on ties); a clip changes only the scores of the two corners on each side, only
  // reflex or straight corners can lie in an ear, and an ear closed by a corner is
  // rescored only when that corner stops blocking.
  const prev = Int32Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const next = Int32Array.from({ length: n }, (_, i) => (i + 1) % n);
  const alive = new Uint8Array(n).fill(1);
  const blocking = new Set<number>();
  const classify = (i: number) => {
    const a = prev[i] as number;
    const c = next[i] as number;
    if (turn(a, i, c) <= 0 || quality(a, i, c) <= SLIVER) blocking.add(i);
    else blocking.delete(i);
  };
  for (let i = 0; i < n; i++) classify(i);
  // Static uniform grid over all corners: an ear tests only the blocking corners in
  // the cells its bounding box covers.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i] as number);
    maxX = Math.max(maxX, xs[i] as number);
    minY = Math.min(minY, ys[i] as number);
    maxY = Math.max(maxY, ys[i] as number);
  }
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cellX = (maxX - minX) / side || 1;
  const cellY = (maxY - minY) / side || 1;
  const column = (x: number) => Math.min(side - 1, Math.max(0, Math.floor((x - minX) / cellX)));
  const row = (y: number) => Math.min(side - 1, Math.max(0, Math.floor((y - minY) / cellY)));
  const cells: number[][] = Array.from({ length: side * side }, () => []);
  for (let i = 0; i < n; i++) {
    (cells[row(ys[i] as number) * side + column(xs[i] as number)] as number[]).push(i);
  }
  const score = new Float64Array(n);
  /** Ears closed by a blocking corner inside them, keyed by that corner. */
  const closedBy = new Map<number, number[]>();
  const blocker = (a: number, b: number, c: number): number => {
    const x0 = column(Math.min(xs[a] as number, xs[b] as number, xs[c] as number));
    const x1 = column(Math.max(xs[a] as number, xs[b] as number, xs[c] as number));
    const y0 = row(Math.min(ys[a] as number, ys[b] as number, ys[c] as number));
    const y1 = row(Math.max(ys[a] as number, ys[b] as number, ys[c] as number));
    let found = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const p of cells[y * side + x] as number[]) {
          if (p === a || p === b || p === c || alive[p] === 0 || !blocking.has(p)) continue;
          if (turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0) {
            // The lowest index keeps results independent of the grid shape.
            if (found < 0 || p < found) found = p;
          }
        }
      }
    }
    return found;
  };
  const rescore = (b: number) => {
    const a = prev[b] as number;
    const c = next[b] as number;
    score[b] = Number.NEGATIVE_INFINITY;
    if (turn(a, b, c) <= 0) return;
    const p = blocker(a, b, c);
    if (p >= 0) {
      const list = closedBy.get(p) ?? [];
      list.push(b);
      closedBy.set(p, list);
      return;
    }
    // Score the ear by its own shape and by the two corners clipping it creates: a
    // clip that leaves a straight run without an apex would force a sliver later.
    score[b] = Math.min(
      quality(a, b, c),
      Math.abs(quality(prev[a] as number, a, c)),
      Math.abs(quality(a, c, next[c] as number)),
    );
  };
  for (let i = 0; i < n; i++) rescore(i);
  const reopen = (p: number) => {
    const ears = closedBy.get(p);
    if (ears === undefined) return;
    closedBy.delete(p);
    for (const i of ears) if (alive[i] === 1) rescore(i);
  };
  const out: number[] = [];
  for (let left = n; left > 3; left--) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (alive[i] === 1 && score[i] !== Number.NEGATIVE_INFINITY) {
        if (best < 0 || (score[i] as number) > (score[best] as number)) best = i;
      }
    }
    if (best < 0) return undefined;
    const a = prev[best] as number;
    const c = next[best] as number;
    out.push(a, best, c);
    alive[best] = 0;
    next[a] = c;
    prev[c] = a;
    for (const corner of [a, c]) {
      const was = blocking.has(corner);
      classify(corner);
      if (was && !blocking.has(corner)) reopen(corner);
    }
    blocking.delete(best);
    reopen(best);
    for (const i of [prev[a] as number, a, c, next[c] as number]) rescore(i);
  }
  const first = alive.indexOf(1);
  out.push(first, next[first] as number, next[next[first] as number] as number);
  return out;
}

/** Generalized winding number of `faces` around `p` (Van Oosterom and Strackee solid angles). */
export function windingNumber(mesh: EditMesh, faces: readonly number[], p: Tuple3): number {
  let total = 0;
  for (const f of faces) {
    const points = mesh.faceVertices(f).map((v) => sub(mesh.position(v), p));
    for (let i = 1; i + 1 < points.length; i++) {
      const a = points[0] as Tuple3;
      const b = points[i] as Tuple3;
      const c = points[i + 1] as Tuple3;
      const la = length(a);
      const lb = length(b);
      const lc = length(c);
      const num = dot(a, cross(b, c));
      const den = la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la;
      total += 2 * atan2(num, den);
    }
  }
  return total / (4 * Math.PI);
}
