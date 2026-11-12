import { maxOf, minOf } from './arrays';
import { cos, sin } from './dmath';
import { add, dot, length, normalize, scale, sub, type Tuple3 } from './geom';

/**
 * Points of a round profile from `x` to `y` with `segments` segments, ends included.
 * Each end is tangent to its face: the tangent at `x` is `y` projected onto the plane
 * through `x` with normal `nx` (the tangent-plane construction), and the
 * corner `q` is where the two tangent lines pass closest. The arc is the affine image of
 * a quarter circle on the frame (x - q, y - q), so a right-angle frame with equal legs
 * gives a circular arc centred at x + y - q. Without a corner ahead of both tangents the
 * profile is straight.
 */
export function roundProfile(
  x: Tuple3,
  y: Tuple3,
  nx: Tuple3,
  ny: Tuple3,
  segments: number,
): { readonly points: Tuple3[]; readonly center?: Tuple3 } {
  const straight = () => ({
    points: Array.from({ length: segments + 1 }, (_, i) => add(x, scale(sub(y, x), i / segments))),
  });
  const span = length(sub(y, x));
  if (span === 0) return straight();
  const tx = tangentToward(x, y, nx);
  const ty = tangentToward(y, x, ny);
  const a = dot(tx, tx);
  const b = dot(tx, ty);
  const c = dot(ty, ty);
  const denominator = a * c - b * b;
  if (a < span * span * 1e-12 || c < span * span * 1e-12 || denominator <= a * c * 1e-9) {
    return straight();
  }
  const w0 = sub(x, y);
  const d = dot(tx, w0);
  const e = dot(ty, w0);
  const s = (b * e - c * d) / denominator;
  const t = (a * e - b * d) / denominator;
  if (s <= 0 || t <= 0) return straight();
  const q = scale(add(add(x, scale(tx, s)), add(y, scale(ty, t))), 0.5);
  const legX = sub(x, q);
  const legY = sub(y, q);
  const points: Tuple3[] = [x];
  for (let i = 1; i < segments; i++) {
    const phi = (Math.PI / 2) * (i / segments);
    points.push(add(q, add(scale(legX, 1 - sin(phi)), scale(legY, 1 - cos(phi)))));
  }
  points.push(y);
  return { points, center: add(legX, y) };
}

function tangentToward(from: Tuple3, to: Tuple3, normal: Tuple3): Tuple3 {
  const n = normalize(normal);
  const d = sub(to, from);
  return sub(d, scale(n, dot(d, n)));
}

/**
 * Faces of a corner patch over a closed ring of `sides` profiles with `segments`
 * segments each. Indices below sides * segments are ring positions in order (side s
 * starts at index s * segments); larger indices are interior points, created here.
 * Four sides make a segments x segments grid; three sides make three corner grids
 * meeting at a centre, with one-quad strips and a centre triangle for odd counts.
 * Faces run in the ring direction.
 */
export function patchTopology(
  sides: 3 | 4,
  segments: number,
): { readonly interior: number; readonly faces: number[][] } {
  const n = segments;
  const ringSize = sides * n;
  let next = ringSize;
  const fresh = () => next++;
  const ring = (s: number, i: number) => (((s % sides) + sides) % sides) * n + i;
  const at = (s: number, i: number) => (i === n ? ring(s + 1, 0) : ring(s, i));
  const faces: number[][] = [];
  const quads = (grid: number[][], size: number) => {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        faces.push([
          grid[i]?.[j] as number,
          grid[i + 1]?.[j] as number,
          grid[i + 1]?.[j + 1] as number,
          grid[i]?.[j + 1] as number,
        ]);
      }
    }
  };
  if (sides === 4) {
    const grid: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= n; j++) {
        if (j === 0) row.push(at(0, i));
        else if (i === n) row.push(at(1, j));
        else if (j === n) row.push(at(2, n - i));
        else if (i === 0) row.push(at(3, n - j));
        else row.push(fresh());
      }
      grid.push(row);
    }
    quads(grid, n);
    return { interior: next - ringSize, faces };
  }
  const q = Math.floor(n / 2);
  const odd = n % 2 === 1;
  // Inward curves from the side midpoints: one per side (even) or a left/right pair (odd).
  const center = odd ? -1 : fresh();
  const inner = [0, 1, 2].map((s) => (odd ? (q === 0 ? at(s, 0) : fresh()) : center));
  const curve = (start: number, end: number) => {
    const out = [start];
    for (let j = 1; j < q; j++) out.push(fresh());
    out.push(end);
    return out;
  };
  const left = [0, 1, 2].map((s) => curve(at(s, q), inner[s] as number));
  const right = odd
    ? [0, 1, 2].map((s) => curve(at(s, q + 1), inner[(s + 1) % 3] as number))
    : left;
  if (q > 0) {
    for (let s = 0; s < 3; s++) {
      const leftCurve = left[s] as number[];
      const rightCurve = right[(s + 2) % 3] as number[];
      const grid: number[][] = [];
      for (let i = 0; i <= q; i++) {
        const row: number[] = [];
        for (let j = 0; j <= q; j++) {
          if (j === 0) row.push(at(s, i));
          else if (i === q) row.push(leftCurve[j] as number);
          else if (j === q) row.push(rightCurve[i] as number);
          else if (i === 0) row.push(at(s - 1, n - j));
          else row.push(fresh());
        }
        grid.push(row);
      }
      quads(grid, q);
    }
  }
  if (odd) {
    for (let s = 0; s < 3; s++) {
      const l = left[s] as number[];
      const r = right[s] as number[];
      for (let j = 0; j < q; j++) {
        faces.push([l[j] as number, r[j] as number, r[j + 1] as number, l[j + 1] as number]);
      }
    }
    faces.push([inner[0] as number, inner[1] as number, inner[2] as number]);
  }
  return { interior: next - ringSize, faces };
}

/**
 * Interior positions of a corner patch. Four-sided patches start from the Coons
 * patch of their sides, three-sided ones relax from the ring centroid (fixed sweep
 * count, so the result is deterministic). When the ring lies on a common sphere
 * around `center` (equal round widths), interior points are projected onto it,
 * blending the ring radii by inverse squared distance.
 */
export function patchPositions(
  sides: 3 | 4,
  segments: number,
  ringPoints: readonly Tuple3[],
  topology: { readonly interior: number; readonly faces: readonly (readonly number[])[] },
  center: Tuple3 | undefined,
): Tuple3[] {
  const n = segments;
  const ringSize = ringPoints.length;
  const total = ringSize + topology.interior;
  const points: Tuple3[] = [...ringPoints];
  const centroid = scale(
    ringPoints.reduce<Tuple3>((sum, p) => add(sum, p), [0, 0, 0]),
    1 / ringSize,
  );
  for (let i = ringSize; i < total; i++) points.push(centroid);
  if (sides === 4) {
    const face = (i: number, j: number) => topology.faces[i * n + j] as readonly number[];
    const node = (i: number, j: number) =>
      i < n && j < n
        ? (face(i, j)[0] as number)
        : i === n && j < n
          ? (face(n - 1, j)[1] as number)
          : i < n
            ? (face(i, n - 1)[3] as number)
            : (face(n - 1, n - 1)[2] as number);
    const p = (i: number, j: number) => points[node(i, j)] as Tuple3;
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < n; j++) {
        const u = i / n;
        const v = j / n;
        const ruled = add(
          add(scale(p(i, 0), 1 - v), scale(p(i, n), v)),
          add(scale(p(0, j), 1 - u), scale(p(n, j), u)),
        );
        const corners = add(
          add(scale(p(0, 0), (1 - u) * (1 - v)), scale(p(n, 0), u * (1 - v))),
          add(scale(p(0, n), (1 - u) * v), scale(p(n, n), u * v)),
        );
        points[node(i, j)] = sub(ruled, corners);
      }
    }
  } else {
    relax(points, ringSize, topology.faces, 200);
  }
  const sphere = center === undefined ? undefined : sphereFit(ringPoints, center);
  if (sphere === undefined) return points;
  const project = () => {
    for (let i = ringSize; i < total; i++) {
      const p = points[i] as Tuple3;
      let weight = 0;
      let radius = 0;
      for (const [k, r] of sphere.radii.entries()) {
        const d = sub(p, ringPoints[k] as Tuple3);
        const w = 1 / (dot(d, d) + 1e-30);
        weight += w;
        radius += w * r;
      }
      points[i] = add(sphere.center, scale(normalize(sub(p, sphere.center)), radius / weight));
    }
  };
  project();
  if (sides === 3) {
    for (let round = 0; round < 3; round++) {
      relax(points, ringSize, topology.faces, 40);
      project();
    }
  }
  return points;
}

/** Ring radii about `center`, when the ring plausibly lies on one sphere around it. */
function sphereFit(
  ring: readonly Tuple3[],
  center: Tuple3,
): { readonly center: Tuple3; readonly radii: number[] } | undefined {
  const radii = ring.map((p) => length(sub(p, center)));
  const lo = minOf(radii);
  const hi = maxOf(radii);
  if (!(lo > 0) || hi > lo * 3) return undefined;
  const mean = normalize(
    ring.reduce<Tuple3>((sum, p) => add(sum, normalize(sub(p, center))), [0, 0, 0]),
  );
  if (ring.some((p) => dot(normalize(sub(p, center)), mean) < 0.2)) return undefined;
  return { center, radii };
}

/** Gauss-Seidel umbrella smoothing of the points after `fixed`, over the face edges. */
function relax(
  points: Tuple3[],
  fixed: number,
  faces: readonly (readonly number[])[],
  sweeps: number,
): void {
  const neighbours = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (a < fixed) return;
    const list = neighbours.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    neighbours.set(a, list);
  };
  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i] as number;
      const b = face[(i + 1) % face.length] as number;
      link(a, b);
      link(b, a);
    }
  }
  const order = [...neighbours.keys()].sort((a, b) => a - b);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (const i of order) {
      const list = neighbours.get(i) as number[];
      let sum: Tuple3 = [0, 0, 0];
      for (const j of list) sum = add(sum, points[j] as Tuple3);
      points[i] = scale(sum, 1 / list.length);
    }
  }
}
