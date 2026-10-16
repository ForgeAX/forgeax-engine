import { err, type NavigationMeshAsset, ok, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';
import { createNavigationGraph, type NavigationEdge, type NavigationGraph } from './graph';

export type NavigationPoint = readonly [number, number, number];
export interface NavigationProjection {
  readonly polygon: number;
  readonly point: NavigationPoint;
  readonly distance: number;
}
export interface NavigationMeshPath {
  readonly points: Float32Array;
  readonly polygons: readonly number[];
  readonly visited: number;
  readonly sourceDigest: string;
}
type Bounds = readonly [number, number, number, number, number, number];
type Branch =
  | { bounds: Bounds; polygons: number[] }
  | { bounds: Bounds; left: Branch; right: Branch };
const MAX_POLYGONS = 131072;
const finitePoint = (p: ArrayLike<number>) =>
  p.length === 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
const point = (v: readonly number[], i: number): NavigationPoint => [
  v[i * 3] as number,
  v[i * 3 + 1] as number,
  v[i * 3 + 2] as number,
];
const squared = (a: NavigationPoint, b: NavigationPoint) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
function distanceBox(p: NavigationPoint, b: Bounds): number {
  let d = 0;
  for (let i = 0; i < 3; i++)
    d +=
      Math.max((b[i] as number) - (p[i] as number), 0, (p[i] as number) - (b[i + 3] as number)) **
      2;
  return d;
}
function tree(ids: number[], boxes: Bounds[]): Branch {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const id of ids)
    for (let a = 0; a < 3; a++) {
      b[a] = Math.min(b[a] as number, boxes[id]?.[a] as number);
      b[a + 3] = Math.max(b[a + 3] as number, boxes[id]?.[a + 3] as number);
    }
  const bounds = b as unknown as Bounds;
  if (ids.length <= 8) return { bounds, polygons: ids };
  let axis = 0;
  for (let a = 1; a < 3; a++)
    if ((b[a + 3] as number) - (b[a] as number) > (b[axis + 3] as number) - (b[axis] as number))
      axis = a;
  ids.sort(
    (i, j) =>
      (boxes[i]?.[axis] as number) +
        (boxes[i]?.[axis + 3] as number) -
        ((boxes[j]?.[axis] as number) + (boxes[j]?.[axis + 3] as number)) || i - j,
  );
  const mid = Math.floor(ids.length / 2);
  return { bounds, left: tree(ids.slice(0, mid), boxes), right: tree(ids.slice(mid), boxes) };
}
/** Closest point on a triangle; private output preserves double precision without temporary vectors. */
function closest(
  p: NavigationPoint,
  vertices: readonly number[],
  ai: number,
  bi: number,
  ci: number,
  out: [number, number, number],
): void {
  const ax = vertices[ai * 3] as number,
    ay = vertices[ai * 3 + 1] as number,
    az = vertices[ai * 3 + 2] as number,
    bx = vertices[bi * 3] as number,
    by = vertices[bi * 3 + 1] as number,
    bz = vertices[bi * 3 + 2] as number,
    cx = vertices[ci * 3] as number,
    cy = vertices[ci * 3 + 1] as number,
    cz = vertices[ci * 3 + 2] as number,
    abx = bx - ax,
    aby = by - ay,
    abz = bz - az,
    acx = cx - ax,
    acy = cy - ay,
    acz = cz - az,
    apx = p[0] - ax,
    apy = p[1] - ay,
    apz = p[2] - az,
    d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return;
  }
  const bpx = p[0] - bx,
    bpy = p[1] - by,
    bpz = p[2] - bz,
    d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    out[0] = ax + t * (bx - ax);
    out[1] = ay + t * (by - ay);
    out[2] = az + t * (bz - az);
    return;
  }
  const cpx = p[0] - cx,
    cpy = p[1] - cy,
    cpz = p[2] - cz,
    d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    out[0] = ax + t * (cx - ax);
    out[1] = ay + t * (cy - ay);
    out[2] = az + t * (cz - az);
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + t * (cx - bx);
    out[1] = by + t * (cy - by);
    out[2] = bz + t * (cz - bz);
    return;
  }
  const inv = 1 / (va + vb + vc),
    v = vb * inv,
    w = vc * inv;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}
function verticalPoint(
  p: NavigationPoint,
  vertices: readonly number[],
  ai: number,
  bi: number,
  ci: number,
  out: [number, number, number],
): boolean {
  const ax = vertices[ai * 3] as number,
    ay = vertices[ai * 3 + 1] as number,
    az = vertices[ai * 3 + 2] as number,
    bx = (vertices[bi * 3] as number) - ax,
    bz = (vertices[bi * 3 + 2] as number) - az,
    cx = (vertices[ci * 3] as number) - ax,
    cz = (vertices[ci * 3 + 2] as number) - az,
    x = p[0] - ax,
    z = p[2] - az;
  const determinant = bx * cz - bz * cx;
  if (Math.abs(determinant) < 1e-12) return false;
  const u = (x * cz - z * cx) / determinant,
    v = (bx * z - bz * x) / determinant;
  if (u < -1e-5 || v < -1e-5 || u + v > 1 + 1e-5) return false;
  out[0] = p[0];
  out[1] =
    ay + u * ((vertices[bi * 3 + 1] as number) - ay) + v * ((vertices[ci * 3 + 1] as number) - ay);
  out[2] = p[2];
  return true;
}
/** String-pull one selected polygon corridor in XZ; endpoints retain their baked height. */
function pullCorridor(
  portals: readonly (readonly [NavigationPoint, NavigationPoint])[],
): Result<number[], NavigationError> {
  let apex = (portals[0] as readonly [NavigationPoint, NavigationPoint])[0],
    left = apex,
    right = apex;
  let apexIndex = 0,
    leftIndex = 0,
    rightIndex = 0,
    work = 0;
  const points: number[] = [...apex];
  const area = (a: NavigationPoint, b: NavigationPoint, c: NavigationPoint) =>
    (c[0] - a[0]) * (b[2] - a[2]) - (b[0] - a[0]) * (c[2] - a[2]);
  const same = (a: NavigationPoint, b: NavigationPoint) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]) < 1e-8;
  for (let i = 1; i < portals.length; i++) {
    if (++work > MAX_POLYGONS * 8)
      return err(
        invalidInput('corridor work', work, 'A corridor within the bounded string-pulling budget'),
      );
    const [nextLeft, nextRight] = portals[i] as readonly [NavigationPoint, NavigationPoint];
    if (area(apex, right, nextRight) <= 0) {
      if (same(apex, right) || area(apex, left, nextRight) > 0) {
        right = nextRight;
        rightIndex = i;
      } else {
        points.push(...left);
        apex = left;
        apexIndex = leftIndex;
        left = apex;
        right = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
    if (area(apex, left, nextLeft) >= 0) {
      if (same(apex, left) || area(apex, right, nextLeft) < 0) {
        left = nextLeft;
        leftIndex = i;
      } else {
        points.push(...right);
        apex = right;
        apexIndex = rightIndex;
        left = apex;
        right = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
      }
    }
  }
  const end = (portals[portals.length - 1] as readonly [NavigationPoint, NavigationPoint])[0];
  const last = points.slice(-3) as unknown as NavigationPoint;
  if (squared(last, end) > 1e-16) points.push(...end);
  return ok(points);
}
/** Immutable, realm-local query workspace; no compiler or native handles. */
class NavigationMesh {
  readonly sourceDigest: string;
  readonly settings: NavigationMeshAsset['settings'];
  #asset: NavigationMeshAsset;
  #tree: Branch;
  #graph: NavigationGraph;
  #portals: Map<string, readonly [NavigationPoint, NavigationPoint]>;
  constructor(
    asset: NavigationMeshAsset,
    branch: Branch,
    graph: NavigationGraph,
    portals: Map<string, readonly [NavigationPoint, NavigationPoint]>,
  ) {
    this.#asset = asset;
    this.#tree = branch;
    this.#graph = graph;
    this.#portals = portals;
    this.sourceDigest = asset.sourceDigest;
    this.settings = Object.freeze({ ...asset.settings });
  }
  /** Euclidean 3D limit; BVH work is separately bounded, including vertical layers. */
  project(
    position: NavigationPoint,
    maxDistance: number,
    maxPolygons = MAX_POLYGONS,
  ): Result<NavigationProjection, NavigationError> {
    return this.#project(position, maxDistance, maxPolygons, false);
  }
  /** Vertical ground sample at the exact XZ; used for slope/step-safe physical steering. */
  ground(
    position: NavigationPoint,
    maxHeight: number,
    maxPolygons = MAX_POLYGONS,
  ): Result<NavigationProjection, NavigationError> {
    return this.#project(position, maxHeight, maxPolygons, true);
  }
  #project(
    position: NavigationPoint,
    maxDistance: number,
    maxPolygons: number,
    vertical: boolean,
  ): Result<NavigationProjection, NavigationError> {
    if (
      !finitePoint(position) ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0 ||
      !Number.isInteger(maxPolygons) ||
      maxPolygons < 1 ||
      maxPolygons > MAX_POLYGONS
    )
      return err(
        invalidInput(
          'projection',
          { position, maxDistance, maxPolygons },
          'Finite XYZ, finite nonnegative distance, bounded positive polygon budget',
        ),
      );
    let best = maxDistance ** 2,
      polygon = -1,
      visited = 0;
    const result: [number, number, number] = [position[0], position[1], position[2]],
      q: [number, number, number] = [0, 0, 0];
    const stack = [this.#tree],
      { vertices, polygons } = this.#asset;
    while (stack.length) {
      const branch = stack.pop() as Branch;
      if (
        vertical &&
        (position[0] < branch.bounds[0] - 1e-5 ||
          position[0] > branch.bounds[3] + 1e-5 ||
          position[2] < branch.bounds[2] - 1e-5 ||
          position[2] > branch.bounds[5] + 1e-5)
      )
        continue;
      if (distanceBox(position, branch.bounds) > best + 1e-12) continue;
      if ('polygons' in branch) {
        for (const id of branch.polygons) {
          if (++visited > maxPolygons)
            return err({
              code: 'navigation-projection-limit',
              expected: 'projection within its polygon budget',
              hint: 'Increase maxPolygons or subdivide the authored mesh.',
              detail: { visited: visited - 1, maxPolygons },
            });
          const poly = polygons[id] as readonly number[],
            a = poly[0] as number;
          for (let i = 1; i < poly.length - 1; i++) {
            const b = poly[i] as number,
              c = poly[i + 1] as number;
            if (vertical) {
              if (!verticalPoint(position, vertices, a, b, c, q)) continue;
            } else closest(position, vertices, a, b, c, q);
            const d = squared(position, q);
            if (d <= best + 1e-12 && (d < best - 1e-12 || polygon < 0 || id < polygon)) {
              best = d;
              polygon = id;
              result[0] = q[0];
              result[1] = q[1];
              result[2] = q[2];
            }
          }
        }
      } else {
        const dl = distanceBox(position, branch.left.bounds),
          dr = distanceBox(position, branch.right.bounds);
        if (dl < dr) stack.push(branch.right, branch.left);
        else stack.push(branch.left, branch.right);
      }
    }
    return polygon < 0
      ? err({
          code: 'navigation-projection-miss',
          expected: 'a walkable surface within maxDistance',
          hint: 'Choose a nearer point or rebuild clearance for this agent.',
          detail: { position, maxDistance },
        })
      : ok({ polygon, point: result, distance: Math.sqrt(best) });
  }
  findPath(
    start: NavigationPoint,
    goal: NavigationPoint,
    options: {
      readonly maxProjection: number;
      readonly maxVisited?: number;
      readonly maxPolygons?: number;
    },
  ): Result<NavigationMeshPath, NavigationError> {
    if (
      options.maxVisited !== undefined &&
      (!Number.isInteger(options.maxVisited) ||
        options.maxVisited < 1 ||
        options.maxVisited > MAX_POLYGONS)
    )
      return err(invalidInput('maxVisited', options.maxVisited, `Integer 1..${MAX_POLYGONS}`));
    const from = this.project(start, options.maxProjection, options.maxPolygons);
    if (!from.ok) return from;
    const to = this.project(goal, options.maxProjection, options.maxPolygons);
    if (!to.ok) return to;
    const path = this.#graph.findPath(
      from.value.polygon,
      to.value.polygon,
      options.maxVisited === undefined
        ? {}
        : { maxVisited: Math.min(options.maxVisited, this.#graph.nodeCount) },
    );
    if (!path.ok) return path;
    const corridor: (readonly [NavigationPoint, NavigationPoint])[] = [
      [from.value.point, from.value.point],
    ];
    for (let i = 1; i < path.value.nodes.length; i++) {
      const previous = path.value.nodes[i - 1] as number,
        next = path.value.nodes[i] as number;
      corridor.push(
        this.#portals.get(`${previous}:${next}`) as readonly [NavigationPoint, NavigationPoint],
      );
    }
    corridor.push([to.value.point, to.value.point]);
    const route = pullCorridor(corridor);
    if (!route.ok) return route;
    const points = route.value;
    return ok({
      points: Float32Array.from(points),
      polygons: path.value.nodes,
      visited: path.value.visited,
      sourceDigest: this.sourceDigest,
    });
  }
}
export function createNavigationMesh(
  input: NavigationMeshAsset,
): Result<NavigationMesh, NavigationError> {
  if (
    !input ||
    input.kind !== 'navigation-mesh' ||
    input.version !== 'recast-poly/1' ||
    typeof input.sourceDigest !== 'string' ||
    !input.sourceDigest ||
    !Array.isArray(input.vertices) ||
    input.vertices.length < 9 ||
    input.vertices.length % 3 !== 0 ||
    input.vertices.length > 786432 ||
    !input.vertices.every(Number.isFinite) ||
    !Array.isArray(input.polygons) ||
    !input.polygons.every((p) => Array.isArray(p)) ||
    input.polygons.length < 1 ||
    input.polygons.length > MAX_POLYGONS
  )
    return err(invalidInput('navigation-mesh', input, 'Versioned bounded polygon data'));
  const s = input.settings;
  if (
    !s ||
    ![s.radius, s.height, s.maxSlopeDeg, s.maxStep, s.cellSize, s.cellHeight].every(
      Number.isFinite,
    ) ||
    s.radius < 0 ||
    s.height <= 0 ||
    s.maxSlopeDeg < 0 ||
    s.maxSlopeDeg >= 90 ||
    s.maxStep < 0 ||
    s.cellSize <= 0 ||
    s.cellHeight <= 0
  )
    return err(invalidInput('settings', s, 'Finite ground-agent bake settings'));
  const asset: NavigationMeshAsset = {
    ...input,
    settings: { ...s },
    vertices: [...input.vertices],
    polygons: input.polygons.map((p) => [...p]),
  };
  const centres: number[] = [],
    boxes: Bounds[] = [],
    edges: NavigationEdge[] = [],
    portals = new Map<string, readonly [NavigationPoint, NavigationPoint]>();
  const shared = new Map<string, { polygon: number; paired: boolean }>();
  for (let id = 0; id < asset.polygons.length; id++) {
    const p = asset.polygons[id] as readonly number[];
    if (
      p.length < 3 ||
      p.length > 6 ||
      new Set(p).size !== p.length ||
      p.some((n) => !Number.isInteger(n) || n < 0 || n >= asset.vertices.length / 3)
    )
      return err(invalidInput('polygon', p, '3..6 distinct in-range indices'));
    const centre = [0, 0, 0],
      b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let sign = 0;
    for (let i = 0; i < p.length; i++) {
      const a = point(asset.vertices, p[i] as number),
        q = point(asset.vertices, p[(i + 1) % p.length] as number),
        r = point(asset.vertices, p[(i + 2) % p.length] as number);
      const cross = (q[0] - a[0]) * (r[2] - q[2]) - (q[2] - a[2]) * (r[0] - q[0]);
      if (Math.abs(cross) > 1e-10) {
        if (sign && sign * cross < 0)
          return err(invalidInput('polygon', p, 'Convex nondegenerate XZ polygon'));
        sign = Math.sign(cross);
      }
      for (let axis = 0; axis < 3; axis++) {
        (centre[axis] as number) += (a[axis] as number) / p.length;
        b[axis] = Math.min(b[axis] as number, a[axis] as number);
        b[axis + 3] = Math.max(b[axis + 3] as number, a[axis] as number);
      }
      const ia = p[i] as number,
        ib = p[(i + 1) % p.length] as number,
        key = `${Math.min(ia, ib)}:${Math.max(ia, ib)}`,
        previous = shared.get(key);
      if (previous) {
        if (previous.paired) return err(invalidInput('polygon', p, 'Manifold shared edges'));
        previous.paired = true;
        edges.push({ from: previous.polygon, to: id }, { from: id, to: previous.polygon });
        portals.set(`${id}:${previous.polygon}`, [a, q]);
        portals.set(`${previous.polygon}:${id}`, [a, q]);
      } else shared.set(key, { polygon: id, paired: false });
    }
    if (!sign) return err(invalidInput('polygon', p, 'Nonzero XZ area'));
    centres.push(...centre);
    boxes.push(b as unknown as Bounds);
  }
  const graph = createNavigationGraph({ positions: centres, edges });
  if (!graph.ok) return graph;
  for (const [key, [a, b]] of portals) {
    const [from, to] = key.split(':').map(Number),
      p = point(centres, from as number),
      q = point(centres, to as number);
    const cross = (q[0] - p[0]) * (a[2] - b[2]) - (q[2] - p[2]) * (a[0] - b[0]);
    portals.set(key, cross >= 0 ? [a, b] : [b, a]);
  }
  return ok(
    new NavigationMesh(
      asset,
      tree(
        asset.polygons.map((_, i) => i),
        boxes,
      ),
      graph.value,
      portals,
    ),
  );
}

export type { NavigationMesh };
