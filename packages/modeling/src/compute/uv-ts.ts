import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from '../arrays';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { UnionFind } from '../finish';
import { decodeSnapshot } from '../fxem';
import { cross, dot, length, normalize, sub, type Tuple3, triangulateLoop } from '../geom';
import { type CornerChannelName, EDGE_SEAM, type EditMesh, NONE } from '../mesh';
import type {
  BackendOutput,
  ComputeJobRequest,
  UvIslandMetrics,
  UvPackJobParams,
  UvPlacement,
  UvRefineStatus,
  UvUnwrapJobParams,
} from './job';
import { WorkMeter } from './job';
import { leastSquaresCholesky, solveSparse, TripletList } from './sparse';
import { acceptRefinement, overlapPairs, type RefineVerdict, slim, slimEnergy } from './uv-slim';

type Uv = [number, number];

/** Corner UVs of every face in face order, corners in loop order, as little-endian f32 pairs. */
export function encodeCornerUvs(mesh: EditMesh, uv: (h: number) => readonly number[]): Uint8Array {
  const halves = mesh.faces().flatMap((f) => mesh.faceHalves(f));
  const bytes = new Uint8Array(halves.length * 8);
  const view = new DataView(bytes.buffer);
  for (const [i, h] of halves.entries()) {
    const value = uv(h);
    view.setFloat32(i * 8, value[0] as number, true);
    view.setFloat32(i * 8 + 4, value[1] as number, true);
  }
  return bytes;
}

/** Inverse of encodeCornerUvs: half-edge -> value for the same mesh. */
export function decodeCornerUvs(mesh: EditMesh, bytes: Uint8Array): Map<number, Uv> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<number, Uv>();
  let i = 0;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      out.set(h, [view.getFloat32(i * 8, true), view.getFloat32(i * 8 + 4, true)]);
      i++;
    }
  }
  return out;
}

/** One island: faces, their corner elements and the canonical triangles over elements. */
export interface Island {
  readonly faces: number[];
  /** Mesh vertex per local element. */
  readonly vertexOf: number[];
  /** Local element per half-edge of the island's faces. */
  readonly element: Map<number, number>;
  /** Element triples, three per triangle. */
  readonly triangles: number[];
  /** Halves whose edge bounds the island (seam, island change or mesh boundary). */
  readonly boundary: number[];
}

/**
 * Islands: faces connected across edges `joined` accepts. Elements: corners of one
 * vertex in one island connected around it across joined edges, so bowties and slit
 * ends split exactly as the UV channel will.
 */
export function islandsOf(
  mesh: EditMesh,
  joined: (h: number) => boolean,
  work: WorkMeter,
  faces: readonly number[] = mesh.faces(),
): Result<{ islands: Island[]; faceIsland: Int32Array }, ModelingError> {
  // Union-find over the faces' own halves only, so a small face set (a chart candidate)
  // costs its size, not the mesh's. Faces outside the set never join two of its faces.
  const faceLocal = new Map<number, number>();
  const halfLocal = new Map<number, number>();
  for (const f of faces) {
    faceLocal.set(f, faceLocal.size);
    for (const h of mesh.faceHalves(f)) halfLocal.set(h, halfLocal.size);
  }
  if (!work.spend(halfLocal.size)) return err(work.failure as ModelingError);
  const faceSets = new UnionFind(faceLocal.size);
  const corners = new UnionFind(halfLocal.size);
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const t = h ^ 1;
      const g = faceLocal.get(mesh.hFace[t] as number);
      if (g === undefined || !joined(h)) continue;
      faceSets.union(faceLocal.get(f) as number, g);
      corners.union(halfLocal.get(h) as number, halfLocal.get(mesh.hNext[t] as number) as number);
      corners.union(halfLocal.get(mesh.hNext[h] as number) as number, halfLocal.get(t) as number);
    }
  }
  const index = new Map<number, number>();
  const faceIsland = new Int32Array(mesh.faceHighWater).fill(NONE);
  const islands: Island[] = [];
  const locals: Map<number, number>[] = [];
  for (const f of faces) {
    const root = faceSets.find(faceLocal.get(f) as number);
    let i = index.get(root);
    if (i === undefined) {
      i = islands.length;
      index.set(root, i);
      islands.push({ faces: [], vertexOf: [], element: new Map(), triangles: [], boundary: [] });
      locals.push(new Map());
    }
    faceIsland[f] = i;
    const island = islands[i] as Island;
    const local = locals[i] as Map<number, number>;
    island.faces.push(f);
    const halves = mesh.faceHalves(f);
    for (const h of halves) {
      const root = corners.find(halfLocal.get(h) as number);
      let k = local.get(root);
      if (k === undefined) {
        k = island.vertexOf.length;
        local.set(root, k);
        island.vertexOf.push(mesh.hVert[h] as number);
      }
      island.element.set(h, k);
    }
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          'every face triangulates in its best-fit plane',
          { face: f },
          'the face overlaps itself; split or repair it before unwrapping',
        ),
      );
    }
    for (const k of indices)
      island.triangles.push(island.element.get(halves[k] as number) as number);
  }
  for (const island of islands) {
    for (const f of island.faces) {
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g === NONE || !joined(h) || faceIsland[g] !== faceIsland[f]) island.boundary.push(h);
      }
    }
  }
  return ok({ islands, faceIsland });
}

function point(mesh: EditMesh, island: Island, k: number): Tuple3 {
  return mesh.position(island.vertexOf[k] as number);
}

/** Boundary loops in element space, longest (3D length) first by stable order. */
function boundaryLoops(mesh: EditMesh, island: Island): number[][] {
  const out = new Map<number, number>();
  for (const h of island.boundary) {
    const k = island.element.get(h) as number;
    if (!out.has(k)) out.set(k, h);
  }
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (const start of island.boundary) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let h: number | undefined = start;
    while (h !== undefined && !visited.has(h)) {
      visited.add(h);
      loop.push(island.element.get(h) as number);
      h = out.get(island.element.get(mesh.hNext[h] as number) as number);
    }
    loops.push(loop);
  }
  return loops;
}

function loopLength(mesh: EditMesh, island: Island, loop: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    total += length(
      sub(
        point(mesh, island, loop[(i + 1) % loop.length] as number),
        point(mesh, island, loop[i] as number),
      ),
    );
  }
  return total;
}

const EXACT_PAIR_LIMIT = 1024;

/** Farthest-apart pair of elements: exact up to EXACT_PAIR_LIMIT, two sweeps beyond. */
function farthestPair(
  mesh: EditMesh,
  island: Island,
  candidates: readonly number[],
): [number, number] {
  const p = (k: number) => point(mesh, island, k);
  const d2 = (a: number, b: number) => {
    const d = sub(p(a), p(b));
    return dot(d, d);
  };
  let best: [number, number] = [candidates[0] as number, candidates[0] as number];
  let bestDistance = -1;
  if (candidates.length <= EXACT_PAIR_LIMIT) {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const d = d2(candidates[i] as number, candidates[j] as number);
        if (d > bestDistance) {
          bestDistance = d;
          best = [candidates[i] as number, candidates[j] as number];
        }
      }
    }
    return best;
  }
  const farthestFrom = (a: number) => {
    let far = a;
    let distance = -1;
    for (const k of candidates) {
      const d = d2(a, k);
      if (d > distance) {
        distance = d;
        far = k;
      }
    }
    return far;
  };
  const a = farthestFrom(candidates[0] as number);
  return [a, farthestFrom(a)];
}

export interface Solved {
  readonly uv: Float64Array;
  readonly iterations: number;
  readonly residual: number;
}

function islandFailure(
  code: 'model-precondition' | 'model-degenerate',
  expected: string,
  mesh: EditMesh,
  island: Island,
  index: number,
  hint: string,
): ModelingError {
  return modelingError(
    code,
    expected,
    {
      island: index,
      faces: island.faces.length,
      position: mesh.position(island.vertexOf[0] as number),
    },
    hint,
  );
}

/**
 * Least-squares conformal map of one island. Two pinned elements
 * are substituted out (their columns move to the right-hand side), so the reduced
 * least-squares system is solved by solve.sparse CGLS on the TS backend.
 */
function lscm(
  mesh: EditMesh,
  island: Island,
  index: number,
  params: UvUnwrapJobParams,
  work: WorkMeter,
  start?: Float64Array,
): Result<Solved, ModelingError> {
  const loops = boundaryLoops(mesh, island).map((loop) => ({
    loop,
    length: loopLength(mesh, island, loop),
  }));
  if (loops.length === 0) {
    return err(
      islandFailure(
        'model-precondition',
        'every LSCM island has a boundary loop',
        mesh,
        island,
        index,
        'the island is a closed surface: mark a seam (m.markSeam) that opens it, or use method expmap for a small patch',
      ),
    );
  }
  let longest = loops[0] as { loop: number[]; length: number };
  for (const l of loops) if (l.length > longest.length) longest = l;
  const all = island.vertexOf.map((_, k) => k);
  const [a, b] = farthestPair(mesh, island, params.pins === 'boundary' ? longest.loop : all);
  const span = length(sub(point(mesh, island, b), point(mesh, island, a)));
  const n = island.vertexOf.length;
  const tris = island.triangles;
  let reach = 0;
  for (let k = 1; k < n; k++) {
    reach = Math.max(reach, length(sub(point(mesh, island, k), point(mesh, island, 0))));
  }
  if (!(span > 0) || !(reach > 0)) {
    return err(
      islandFailure(
        'model-degenerate',
        'the island spans a positive distance',
        mesh,
        island,
        index,
        'the island collapses to a point; delete or repair it',
      ),
    );
  }
  const pinned = new Map<number, Uv>([
    [a, [0, 0]],
    [b, [span, 0]],
  ]);
  const column = new Int32Array(n).fill(NONE);
  let free = 0;
  for (let k = 0; k < n; k++) if (!pinned.has(k)) column[k] = free++;
  const flatLimit = 1e-12 * reach * reach;
  const good: number[] = [];
  const covered = new Uint8Array(n);
  for (let t = 0; t < tris.length; t += 3) {
    const [p0, p1, p2] = [0, 1, 2].map((j) => point(mesh, island, tris[t + j] as number)) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    if (length(cross(sub(p1, p0), sub(p2, p0))) <= flatLimit) continue;
    good.push(t);
    for (let j = 0; j < 3; j++) covered[tris[t + j] as number] = 1;
  }
  for (let k = 0; k < n; k++) {
    if (covered[k] === 0) {
      return err(
        modelingError(
          'model-degenerate',
          'every island vertex lies on a triangle with positive area',
          { island: index, position: point(mesh, island, k) },
          'remove the zero-area faces around this vertex (m.cleanup) before unwrapping',
        ),
      );
    }
  }
  if (!work.spend(good.length * 12)) return err(work.failure as ModelingError);
  const system = new TripletList(good.length * 2, free * 2);
  const rhs = new Float64Array(good.length * 2);
  for (const [row, t] of good.entries()) {
    const ids = [0, 1, 2].map((j) => tris[t + j] as number);
    const [p0, p1, p2] = ids.map((k) => point(mesh, island, k)) as [Tuple3, Tuple3, Tuple3];
    const e1 = sub(p1, p0);
    const x = normalize(e1);
    const normal = cross(e1, sub(p2, p0));
    const y = normalize(cross(normal, x));
    const z: Uv[] = [
      [0, 0],
      [length(e1), 0],
      [dot(sub(p2, p0), x), dot(sub(p2, p0), y)],
    ];
    const w = 1 / Math.sqrt(length(normal));
    for (let j = 0; j < 3; j++) {
      const za = z[(j + 2) % 3] as Uv;
      const zb = z[(j + 1) % 3] as Uv;
      const re = (za[0] - zb[0]) * w;
      const im = (za[1] - zb[1]) * w;
      const k = ids[j] as number;
      const pin = pinned.get(k);
      if (pin !== undefined) {
        rhs[2 * row] = (rhs[2 * row] as number) - (re * pin[0] - im * pin[1]);
        rhs[2 * row + 1] = (rhs[2 * row + 1] as number) - (im * pin[0] + re * pin[1]);
        continue;
      }
      const c = column[k] as number;
      system.add(2 * row, 2 * c, re);
      system.add(2 * row, 2 * c + 1, -im);
      system.add(2 * row + 1, 2 * c, im);
      system.add(2 * row + 1, 2 * c + 1, re);
    }
  }
  // A start layout enters through the similarity that puts its pins on theirs.
  let initial: Float64Array | undefined;
  if (start !== undefined) {
    const [ax, ay, bx, by] = [start[2 * a], start[2 * a + 1], start[2 * b], start[2 * b + 1]] as [
      number,
      number,
      number,
      number,
    ];
    const dx = bx - ax;
    const dy = by - ay;
    const d2 = dx * dx + dy * dy;
    if (d2 > 0) {
      // (z - za) * span / (zb - za) in complex numbers.
      const re = (span * dx) / d2;
      const im = (-span * dy) / d2;
      initial = new Float64Array(free * 2);
      for (let k = 0; k < n; k++) {
        const c = column[k] as number;
        if (c === NONE) continue;
        const x = (start[2 * k] as number) - ax;
        const y = (start[2 * k + 1] as number) - ay;
        initial[2 * c] = x * re - y * im;
        initial[2 * c + 1] = x * im + y * re;
      }
    }
  }
  const matrix = system.toCsr();
  const direct = leastSquaresCholesky(matrix, rhs, work);
  const solved =
    direct ??
    solveSparse(
      matrix,
      rhs,
      {
        method: 'cgls',
        tolerance: params.tolerance,
        ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
      },
      work,
      initial,
    );
  if (!solved.ok) {
    const cause = solved.error;
    return err(
      modelingError(cause.code, cause.expected, { ...cause.detail, island: index }, cause.hint),
    );
  }
  const uv = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const pin = pinned.get(k);
    const c = column[k] as number;
    uv[2 * k] = pin === undefined ? (solved.value.x[2 * c] as number) : pin[0];
    uv[2 * k + 1] = pin === undefined ? (solved.value.x[2 * c + 1] as number) : pin[1];
  }
  return ok({ uv, iterations: solved.value.iterations, residual: solved.value.residual });
}

/** Above this largest area distortion an LSCM island takes a better ExpMap start. */
const FALLBACK_DISTORTION = 4;

/** Per-element UVs of a solve, mirrored if needed so the island's signed UV area is positive. */
function oriented(island: Island, values: Float64Array): { uv: Uv[]; signed: number } {
  const uv: Uv[] = island.vertexOf.map((_, k) => [
    values[2 * k] as number,
    values[2 * k + 1] as number,
  ]);
  let signed = 0;
  for (let t = 0; t < island.triangles.length; t += 3) {
    signed += signedArea(
      uv[island.triangles[t] as number] as Uv,
      uv[island.triangles[t + 1] as number] as Uv,
      uv[island.triangles[t + 2] as number] as Uv,
    );
  }
  if (signed < 0) for (const p of uv) p[1] = -p[1];
  return { uv, signed };
}

/** Area-weighted element normals of an island. */
function elementNormals(mesh: EditMesh, island: Island): Tuple3[] {
  const normals: Tuple3[] = island.vertexOf.map(() => [0, 0, 0]);
  const tris = island.triangles;
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [0, 1, 2].map((j) => tris[t + j] as number);
    const [p0, p1, p2] = ids.map((k) => point(mesh, island, k)) as [Tuple3, Tuple3, Tuple3];
    const n = cross(sub(p1, p0), sub(p2, p0));
    for (const k of ids) {
      const m = normals[k] as Tuple3;
      normals[k] = [m[0] + n[0], m[1] + n[1], m[2] + n[2]];
    }
  }
  return normals.map((n) => normalize(n));
}

/** Rotate `v` by the minimal rotation taking unit `from` onto unit `to` (Rodrigues, no trig). */
function transport(v: Tuple3, from: Tuple3, to: Tuple3): Tuple3 {
  const c = dot(from, to);
  const axis = cross(from, to);
  if (c <= -1 + 1e-12) return [-v[0], -v[1], -v[2]];
  const k = 1 / (1 + c);
  const ax = cross(axis, v);
  const aav = cross(axis, ax);
  return [v[0] + ax[0] + aav[0] * k, v[1] + ax[1] + aav[1] * k, v[2] + ax[2] + aav[2] * k];
}

/**
 * Discrete exponential map: geodesic polar coordinates grown by
 * Dijkstra from the element nearest the island's area centroid, with tangent frames
 * transported along the shortest-path tree. Suited to small, nearly developable
 * patches (decals, emblems); no pins and no solve.
 */
export function expmap(
  mesh: EditMesh,
  island: Island,
  work: WorkMeter,
): Result<Solved, ModelingError> {
  const n = island.vertexOf.length;
  const tris = island.triangles;
  const normals = elementNormals(mesh, island);
  const neighbors: number[][] = island.vertexOf.map(() => []);
  for (let t = 0; t < tris.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = tris[t + j] as number;
      const b = tris[t + ((j + 1) % 3)] as number;
      (neighbors[a] as number[]).push(b);
      (neighbors[b] as number[]).push(a);
    }
  }
  let centroid: Tuple3 = [0, 0, 0];
  let total = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [p0, p1, p2] = [0, 1, 2].map((j) => point(mesh, island, tris[t + j] as number)) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const area = length(cross(sub(p1, p0), sub(p2, p0)));
    total += area;
    centroid = [0, 1, 2].map(
      (c) =>
        (centroid[c] as number) +
        (area * ((p0[c] as number) + (p1[c] as number) + (p2[c] as number))) / 3,
    ) as Tuple3;
  }
  if (!(total > 0)) return err(modelingError('model-degenerate', 'the island has area', {}));
  centroid = centroid.map((c) => c / total) as Tuple3;
  let seed = 0;
  let near = Infinity;
  for (let k = 0; k < n; k++) {
    const d = length(sub(point(mesh, island, k), centroid));
    if (d < near) {
      near = d;
      seed = k;
    }
  }
  const ns = normals[seed] as Tuple3;
  const helper: Tuple3 =
    Math.abs(ns[0]) <= Math.abs(ns[1]) && Math.abs(ns[0]) <= Math.abs(ns[2])
      ? [1, 0, 0]
      : Math.abs(ns[1]) <= Math.abs(ns[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const frames: (readonly [Tuple3, Tuple3] | undefined)[] = new Array(n).fill(undefined);
  const e1 = normalize(cross(helper, ns));
  frames[seed] = [e1, cross(ns, e1)];
  const distance = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(NONE);
  const done = new Uint8Array(n);
  const uv = new Float64Array(2 * n);
  distance[seed] = 0;
  // Binary heap of [distance, element]; ties settle the lower element first.
  const heap: [number, number][] = [[0, seed]];
  const less = (x: [number, number], y: [number, number]) =>
    x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!less(heap[i] as [number, number], heap[up] as [number, number])) break;
      [heap[i], heap[up]] = [heap[up] as [number, number], heap[i] as [number, number]];
      i = up;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number];
    const last = heap.pop() as [number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l] as [number, number], heap[m] as [number, number]))
          m = l;
        if (r < heap.length && less(heap[r] as [number, number], heap[m] as [number, number]))
          m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as [number, number], heap[i] as [number, number]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [d, k] = pop();
    if (done[k] === 1 || d > (distance[k] as number)) continue;
    done[k] = 1;
    if (!work.spend(8)) return err(work.failure as ModelingError);
    const from = parent[k] as number;
    if (from !== NONE) {
      const [f1, f2] = frames[from] as readonly [Tuple3, Tuple3];
      const nf = normals[from] as Tuple3;
      const step = sub(point(mesh, island, k), point(mesh, island, from));
      const tangent = sub(step, [
        nf[0] * dot(step, nf),
        nf[1] * dot(step, nf),
        nf[2] * dot(step, nf),
      ]);
      const projected = length(tangent);
      const s = projected > 0 ? length(step) / projected : 0;
      uv[2 * k] = (uv[2 * from] as number) + dot(tangent, f1) * s;
      uv[2 * k + 1] = (uv[2 * from + 1] as number) + dot(tangent, f2) * s;
      const nk = normals[k] as Tuple3;
      frames[k] = [transport(f1, nf, nk), transport(f2, nf, nk)];
    }
    for (const q of neighbors[k] as number[]) {
      if (done[q] === 1) continue;
      const next = d + length(sub(point(mesh, island, q), point(mesh, island, k)));
      if (next < (distance[q] as number)) {
        distance[q] = next;
        parent[q] = k;
        push([next, q]);
      }
    }
  }
  return ok({ uv, iterations: 0, residual: 0 });
}

function signedArea(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  return (
    (((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
      ((c[0] as number) - (a[0] as number)) * ((b[1] as number) - (a[1] as number))) /
    2
  );
}

/** Per-triangle facts shared by the unwrap and pack metrics. */
export interface TriangleSample {
  readonly area3d: number;
  readonly areaUv: number;
  readonly l2: number;
  readonly linf: number;
}

function sampleTriangle(q: readonly Tuple3[], p: readonly (readonly number[])[]): TriangleSample {
  const [q0, q1, q2] = q as [Tuple3, Tuple3, Tuple3];
  const [p0, p1, p2] = p as [readonly number[], readonly number[], readonly number[]];
  const area3d = length(cross(sub(q1, q0), sub(q2, q0))) / 2;
  const areaUv = signedArea(p0, p1, p2);
  if (!(areaUv > 0)) return { area3d, areaUv, l2: Infinity, linf: Infinity };
  const [s0, s1, s2] = [p0[0], p1[0], p2[0]] as [number, number, number];
  const [t0, t1, t2] = [p0[1], p1[1], p2[1]] as [number, number, number];
  const ss = [0, 1, 2].map(
    (c) =>
      ((q0[c] as number) * (t1 - t2) +
        (q1[c] as number) * (t2 - t0) +
        (q2[c] as number) * (t0 - t1)) /
      (2 * areaUv),
  ) as Tuple3;
  const st = [0, 1, 2].map(
    (c) =>
      ((q0[c] as number) * (s2 - s1) +
        (q1[c] as number) * (s0 - s2) +
        (q2[c] as number) * (s1 - s0)) /
      (2 * areaUv),
  ) as Tuple3;
  const a = dot(ss, ss);
  const b = dot(ss, st);
  const c = dot(st, st);
  const root = Math.sqrt((a - c) * (a - c) + 4 * b * b);
  return { area3d, areaUv, l2: Math.sqrt((a + c) / 2), linf: Math.sqrt((a + c + root) / 2) };
}

const DISTORTION_CLIP = 100;

/** Sander stretch and relative-area distortion of one island, normalized for its scale. */
function metricsOf(
  samples: readonly TriangleSample[],
): Omit<UvIslandMetrics, 'faces' | 'iterations' | 'residual'> {
  let area3d = 0;
  let areaUv = 0;
  for (const s of samples) {
    area3d += s.area3d;
    areaUv += Math.max(0, s.areaUv);
  }
  const norm = area3d > 0 ? Math.sqrt(areaUv / area3d) : 0;
  let l2 = 0;
  let weight = 0;
  let linf = 0;
  let distortion = 1;
  let flipped = 0;
  let zeroArea = 0;
  for (const s of samples) {
    if (!(s.areaUv > 0)) {
      if (s.areaUv < 0) flipped++;
      else zeroArea++;
      if (s.area3d > 0) distortion = DISTORTION_CLIP;
      continue;
    }
    l2 += s.l2 * s.l2 * s.area3d;
    weight += s.area3d;
    linf = Math.max(linf, s.linf * norm);
    if (s.area3d > 0) {
      const rho = s.areaUv / areaUv / (s.area3d / area3d);
      distortion = Math.max(distortion, Math.min(DISTORTION_CLIP, Math.max(rho, 1 / rho)));
    } else {
      distortion = DISTORTION_CLIP;
    }
  }
  return {
    area3d,
    areaUv,
    stretchL2: weight > 0 ? Math.sqrt(l2 / weight) * norm : Infinity,
    stretchLinf: linf,
    areaDistortion: distortion,
    flipped,
    zeroArea,
  };
}

/** Area of the union of placement rectangles clipped to the atlas (a sweep over y bands). */
function rectUnionArea(rects: readonly UvPlacement[], resolution: number): number {
  const clip = (v: number) => Math.max(0, Math.min(resolution, v));
  const boxes = rects.map((r) => [clip(r.x), clip(r.y), clip(r.x + r.width), clip(r.y + r.height)]);
  const ys = [...new Set(boxes.flatMap((b) => [b[1] as number, b[3] as number]))].sort(
    (a, b) => a - b,
  );
  let area = 0;
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k] as number;
    const y1 = ys[k + 1] as number;
    const spans = boxes
      .filter(
        (b) =>
          (b[1] as number) <= y0 && (b[3] as number) >= y1 && (b[2] as number) > (b[0] as number),
      )
      .map((b) => [b[0] as number, b[2] as number] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [a, b] of spans) {
      if (a > end) {
        covered += b - a;
        end = b;
      } else if (b > end) {
        covered += b - end;
        end = b;
      }
    }
    area += covered * (y1 - y0);
  }
  return area;
}

/** Area-weighted coefficient of variation of texel density sqrt(areaUv / area3d). */
export function densityDispersion(samples: readonly TriangleSample[]): number {
  let weight = 0;
  let sum = 0;
  let squares = 0;
  for (const s of samples) {
    if (!(s.area3d > 0) || !(s.areaUv > 0)) continue;
    const d = Math.sqrt(s.areaUv / s.area3d);
    weight += s.area3d;
    sum += d * s.area3d;
    squares += d * d * s.area3d;
  }
  if (!(weight > 0)) return 0;
  const mean = sum / weight;
  return Math.sqrt(Math.max(0, squares / weight - mean * mean)) / mean;
}

/** Andrew monotone-chain convex hull, counter-clockwise. */
function hull(points: readonly Uv[]): Uv[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const turn = (o: Uv, a: Uv, b: Uv) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Uv[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      turn(lower[lower.length - 2] as Uv, lower[lower.length - 1] as Uv, p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Uv[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Uv;
    while (
      upper.length >= 2 &&
      turn(upper[upper.length - 2] as Uv, upper[upper.length - 1] as Uv, p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Orientation of the minimal-area bounding rectangle (rotating an edge of the hull onto
 * the u axis), turned a quarter so the rectangle is at least as wide as tall: the
 * `uv.orient` rule. Returns the unit direction mapped onto +u.
 */
export function orientation(points: readonly Uv[]): Uv {
  const h = hull(points);
  let best: Uv = [1, 0];
  let bestArea = Infinity;
  let bestWide = true;
  for (let i = 0; i < h.length; i++) {
    const a = h[i] as Uv;
    const b = h[(i + 1) % h.length] as Uv;
    const len = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    if (!(len > 0)) continue;
    const d: Uv = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of h) {
      const x = p[0] * d[0] + p[1] * d[1];
      const y = d[0] * p[1] - d[1] * p[0];
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea * (1 - 1e-9)) {
      bestArea = area;
      best = d;
      bestWide = x1 - x0 >= y1 - y0;
    }
  }
  // A quarter turn maps the old +v direction onto +u.
  return bestWide ? best : [-best[1], best[0]];
}

function rotateInto(points: Uv[], d: Uv): void {
  for (const p of points) {
    const x = p[0] * d[0] + p[1] * d[1];
    const y = d[0] * p[1] - d[1] * p[0];
    p[0] = x;
    p[1] = y;
  }
}

function boundsOf(points: readonly Uv[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

export function samplesOf(
  mesh: EditMesh,
  island: Island,
  uv: readonly (readonly number[])[],
): TriangleSample[] {
  const out: TriangleSample[] = [];
  const tris = island.triangles;
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [0, 1, 2].map((j) => tris[t + j] as number);
    out.push(
      sampleTriangle(
        ids.map((k) => point(mesh, island, k)),
        ids.map((k) => uv[k] as readonly number[]),
      ),
    );
  }
  return out;
}

/** Islands of a complete UV channel: faces joined where both corner values match bit for bit. */
function channelIslands(
  mesh: EditMesh,
  channel: CornerChannelName,
  work: WorkMeter,
): Result<{ islands: Island[]; faceIsland: Int32Array }, ModelingError> {
  const value = (h: number) => mesh.corner(channel, h);
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      if (value(h) === undefined) {
        return err(
          modelingError(
            'model-precondition',
            `every face has ${channel}`,
            { face: f, channel },
            'unwrap (m.uv.unwrap) or project (m.uv.project) the faces first',
          ),
        );
      }
    }
  }
  const same = (a: number, b: number) => {
    const x = value(a) as Float32Array;
    const y = value(b) as Float32Array;
    return x[0] === y[0] && x[1] === y[1];
  };
  return islandsOf(
    mesh,
    (h) => same(h, mesh.hNext[h ^ 1] as number) && same(mesh.hNext[h] as number, h ^ 1),
    work,
  );
}

/** Distortion facts of a whole UV channel (islands from equal corner values). */
export interface UvMeasurement {
  /** Island per face id (NONE for dead ids), in island order of the lowest face. */
  readonly faceIsland: Int32Array;
  readonly islands: readonly Omit<UvIslandMetrics, 'iterations' | 'residual'>[];
  readonly stretchL2: number;
  readonly stretchLinf: number;
  readonly areaDistortion: number;
  /** Area-weighted coefficient of variation of texel density across all islands. */
  readonly texelDensityDispersion: number;
  readonly flipped: number;
  readonly zeroArea: number;
}

/**
 * Measure a UV channel as the unwrap and pack metrics do: Sander L2 / L-infinity
 * stretch and clipped area distortion per island (normalized for the island's scale),
 * and the texel density dispersion of the whole channel. Every face needs the channel.
 */
export function measureUv(
  mesh: EditMesh,
  channel: CornerChannelName = 'uv0',
): Result<UvMeasurement, ModelingError> {
  const found = channelIslands(mesh, channel, new WorkMeter(Infinity));
  if (!found.ok) return found;
  const islands = found.value.islands.map((island) => {
    const uv: Uv[] = island.vertexOf.map(() => [0, 0]);
    for (const [h, k] of island.element) {
      const v = mesh.corner(channel, h) as Float32Array;
      uv[k] = [v[0] as number, v[1] as number];
    }
    return samplesOf(mesh, island, uv);
  });
  const reports = islands.map((samples, i) => ({
    faces: (found.value.islands[i] as Island).faces.length,
    ...metricsOf(samples),
  }));
  let area3d = 0;
  let l2 = 0;
  for (const r of reports) {
    area3d += r.area3d;
    if (Number.isFinite(r.stretchL2)) l2 += r.stretchL2 * r.stretchL2 * r.area3d;
  }
  return ok({
    faceIsland: found.value.faceIsland,
    islands: reports,
    stretchL2: area3d > 0 ? Math.sqrt(l2 / area3d) : 0,
    stretchLinf: Math.max(0, ...reports.map((r) => r.stretchLinf)),
    areaDistortion: Math.max(1, ...reports.map((r) => r.areaDistortion)),
    texelDensityDispersion: densityDispersion(islands.flat()),
    flipped: reports.reduce((n, r) => n + r.flipped, 0),
    zeroArea: reports.reduce((n, r) => n + r.zeroArea, 0),
  });
}

/**
 * Rectify: an island of quads that forms a grid (every interior vertex shared by
 * four faces, consistent across the island) maps each grid line to a straight line: u
 * of column I is the running sum of the average 3D length of the edges between columns,
 * v likewise along rows, so strips and bevel ribbons come out as rectangles. Undefined
 * when the island is not a quad grid.
 */
function rectify(
  mesh: EditMesh,
  island: Island,
  work: WorkMeter,
): Float64Array | undefined | ModelingError {
  if (!work.spend(island.faces.length * 4)) return work.failure as ModelingError;
  const faceOf = new Map<number, number>();
  for (const f of island.faces) {
    if (mesh.faceHalves(f).length !== 4) return undefined;
    faceOf.set(f, 1);
  }
  const coord = new Map<number, [number, number]>();
  const set = (k: number, c: [number, number]) => {
    const old = coord.get(k);
    if (old === undefined) {
      coord.set(k, c);
      return true;
    }
    return old[0] === c[0] && old[1] === c[1];
  };
  const boundary = new Set(island.boundary);
  const done = new Set<number>();
  const first = island.faces[0] as number;
  const h0 = mesh.faceHalves(first);
  const e = (h: number) => island.element.get(h) as number;
  const unit: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const [i, h] of h0.entries()) set(e(h), unit[i] as [number, number]);
  const queue = [first];
  done.add(first);
  while (queue.length > 0) {
    const f = queue.shift() as number;
    const halves = mesh.faceHalves(f);
    for (const [i, h] of halves.entries()) {
      const g = mesh.hFace[h ^ 1] as number;
      if (!faceOf.has(g) || done.has(g) || boundary.has(h)) continue;
      // Shared edge a -> b in f; x precedes a and y follows b, one row away.
      const a = coord.get(e(h)) as [number, number];
      const b = coord.get(e(halves[(i + 1) % 4] as number)) as [number, number];
      const y = coord.get(e(halves[(i + 2) % 4] as number)) as [number, number];
      const step: [number, number] = [y[0] - b[0], y[1] - b[1]];
      const gh = mesh.faceHalves(g);
      const j = gh.indexOf(h ^ 1);
      // In g the twin runs b -> a; the corner after a is a - step, the one after it b - step.
      const ok1 = set(e(gh[j] as number), b) && set(e(gh[(j + 1) % 4] as number), a);
      const ok2 =
        set(e(gh[(j + 2) % 4] as number), [a[0] - step[0], a[1] - step[1]]) &&
        set(e(gh[(j + 3) % 4] as number), [b[0] - step[0], b[1] - step[1]]);
      if (!ok1 || !ok2) return undefined;
      done.add(g);
      queue.push(g);
    }
  }
  if (done.size !== island.faces.length) return undefined;
  // Average edge length per column gap (u) and row gap (v).
  const sums = new Map<string, [number, number]>();
  for (const f of island.faces) {
    const halves = mesh.faceHalves(f);
    for (const [i, h] of halves.entries()) {
      const a = coord.get(e(h)) as [number, number];
      const b = coord.get(e(halves[(i + 1) % 4] as number)) as [number, number];
      const along = a[1] === b[1] ? 'u' : 'v';
      const at = along === 'u' ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
      const p = mesh.position(mesh.hVert[h] as number) as Tuple3;
      const q = mesh.position(mesh.hVert[halves[(i + 1) % 4] as number] as number) as Tuple3;
      const key = `${along}${at}`;
      const s = sums.get(key) ?? [0, 0];
      s[0] += length(sub(q, p));
      s[1] += 1;
      sums.set(key, s);
    }
  }
  const axis = (along: 'u' | 'v', lo: number, hi: number) => {
    const out = new Map<number, number>();
    let run = 0;
    out.set(lo, 0);
    for (let k = lo; k < hi; k++) {
      const s = sums.get(`${along}${k}`);
      if (s === undefined) return undefined;
      run += s[0] / s[1];
      out.set(k + 1, run);
    }
    return out;
  };
  const cs = [...coord.values()];
  const us = axis('u', minOf(cs.map((c) => c[0])), maxOf(cs.map((c) => c[0])));
  const vs = axis('v', minOf(cs.map((c) => c[1])), maxOf(cs.map((c) => c[1])));
  if (us === undefined || vs === undefined) return undefined;
  const out = new Float64Array(island.vertexOf.length * 2);
  for (const [k, [i, j]] of coord) {
    out[2 * k] = us.get(i) as number;
    out[2 * k + 1] = vs.get(j) as number;
  }
  return out;
}

/** What SLIM refinement did to one island (the kept layout is `uv`). */
interface Refinement {
  readonly status: UvRefineStatus;
  readonly iterations: number;
  readonly flippedBefore: number;
  readonly energyBefore: number;
  readonly energyAfter: number;
  readonly overlaps: number;
  readonly uv: Uv[];
  readonly metrics: ReturnType<typeof metricsOf>;
}

/**
 * Refine one island's layout by SLIM and keep it only if it passes the gate
 * (`acceptRefinement`). A folded start of a disk island restarts from its Tutte
 * embedding; any other island that SLIM cannot run on keeps its start (`unavailable`).
 */
function refineIsland(
  mesh: EditMesh,
  island: Island,
  uv: Uv[],
  metrics: ReturnType<typeof metricsOf>,
  work: WorkMeter,
): Result<Refinement, ModelingError> {
  const flat = new Float64Array(2 * uv.length);
  for (const [k, p] of uv.entries()) flat.set(p, 2 * k);
  const loops = boundaryLoops(mesh, island);
  const shape = {
    points: island.vertexOf.map((_, k) => point(mesh, island, k)),
    triangles: island.triangles,
    disk: loops.length === 1 ? (loops[0] as number[]) : undefined,
  };
  if (!work.spend(island.triangles.length * 2)) return err(work.failure as ModelingError);
  const overlapsBefore = overlapPairs(island.triangles, flat);
  const energyBefore = slimEnergy(shape, flat);
  const flippedBefore = metrics.flipped + metrics.zeroArea;
  const kept = (status: UvRefineStatus, iterations: number, energyAfter: number): Refinement => ({
    status,
    iterations,
    flippedBefore,
    energyBefore,
    energyAfter,
    overlaps: overlapsBefore,
    uv,
    metrics,
  });
  const refined = slim(shape, flat, work);
  if (!refined.ok) return refined;
  if (refined.value === undefined) return ok(kept('unavailable', 0, energyBefore));
  const candidate = oriented(island, refined.value.uv);
  const candidateMetrics = metricsOf(samplesOf(mesh, island, candidate.uv));
  const candidateFlat = new Float64Array(2 * uv.length);
  for (const [k, p] of candidate.uv.entries()) candidateFlat.set(p, 2 * k);
  const overlapsAfter = overlapPairs(island.triangles, candidateFlat);
  const verdict: RefineVerdict = acceptRefinement(
    {
      energy: energyBefore,
      flipped: flippedBefore,
      overlaps: overlapsBefore,
      areaDistortion: metrics.areaDistortion,
    },
    {
      energy: refined.value.energy,
      flipped: candidateMetrics.flipped + candidateMetrics.zeroArea,
      overlaps: overlapsAfter,
      areaDistortion: candidateMetrics.areaDistortion,
    },
  );
  if (verdict !== 'accepted') return ok(kept(verdict, refined.value.iterations, energyBefore));
  return ok({
    status: 'accepted',
    iterations: refined.value.iterations,
    flippedBefore,
    energyBefore,
    energyAfter: refined.value.energy,
    overlaps: overlapsAfter,
    uv: candidate.uv,
    metrics: candidateMetrics,
  });
}

export function runUnwrapJob(
  request: ComputeJobRequest<'uv.unwrap'>,
  work: WorkMeter,
): Result<BackendOutput<'uv.unwrap'>, ModelingError> {
  const params = request.params;
  if (!(params.tolerance > 0 && params.tolerance < 1)) {
    return err(
      modelingError('model-invalid-argument', 'tolerance is in (0, 1)', {
        tolerance: params.tolerance,
      }),
    );
  }
  if (
    params.maxIterations !== undefined &&
    !(Number.isInteger(params.maxIterations) && params.maxIterations >= 1)
  ) {
    return err(
      modelingError('model-invalid-argument', 'maxIterations is an integer >= 1', {
        maxIterations: params.maxIterations,
      }),
    );
  }
  if (params.start !== undefined && params.start !== 'expmap') {
    return err(
      modelingError('model-invalid-argument', "start is 'expmap' when given", {
        start: params.start,
      }),
    );
  }
  if (params.refine !== undefined && params.refine !== 'slim') {
    return err(
      modelingError('model-invalid-argument', "refine is 'slim' when given", {
        refine: params.refine,
      }),
    );
  }
  if (request.inputs.length !== 1) {
    return err(
      modelingError('model-invalid-argument', 'uv.unwrap takes one FXEM input', {
        inputs: request.inputs.length,
      }),
    );
  }
  const decoded = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const found = islandsOf(mesh, (h) => ((mesh.eFlags[h >> 1] as number) & EDGE_SEAM) === 0, work);
  if (!found.ok) return found;
  const { islands, faceIsland } = found.value;
  const placed: Uv[][] = [];
  const reports: UvIslandMetrics[] = [];
  const allSamples: TriangleSample[] = [];
  let iterations = 0;
  let residual = 0;
  let fallbacks = 0;
  let rectified = 0;
  let rectifyFallbacks = 0;
  const refine = {
    accepted: 0,
    rejected: 0,
    unavailable: 0,
    repaired: 0,
    iterations: 0,
    overlaps: 0,
    before: 0,
    after: 0,
    weight: 0,
  };
  for (const [index, island] of islands.entries()) {
    let start: Result<Solved, ModelingError> | undefined;
    if (params.method !== 'expmap' && params.start === 'expmap') {
      start = expmap(mesh, island, work);
      if (!start.ok && start.error.code !== 'model-degenerate') return start;
    }
    let grid: Float64Array | undefined;
    if (params.method === 'rectify') {
      const r = rectify(mesh, island, work);
      if (r instanceof Error) return err(r);
      grid = r;
      if (grid === undefined) rectifyFallbacks++;
      else rectified++;
    }
    let solved: Result<Solved, ModelingError> =
      grid !== undefined
        ? ok({ uv: grid, iterations: 0, residual: 0 })
        : params.method === 'expmap'
          ? expmap(mesh, island, work)
          : lscm(mesh, island, index, params, work, start?.ok ? start.value.uv : undefined);
    if (!solved.ok) return solved;
    let { uv, signed } = oriented(island, solved.value.uv);
    let raw = metricsOf(samplesOf(mesh, island, uv));
    if (start?.ok && grid === undefined) {
      const other = oriented(island, start.value.uv);
      const alternative = metricsOf(samplesOf(mesh, island, other.uv));
      const bad = (m: typeof raw) => m.flipped + m.zeroArea;
      if (
        bad(alternative) < bad(raw) ||
        (bad(alternative) === bad(raw) &&
          raw.areaDistortion >= FALLBACK_DISTORTION &&
          alternative.areaDistortion < raw.areaDistortion)
      ) {
        solved = ok({ ...start.value, iterations: solved.value.iterations });
        ({ uv, signed } = other);
        raw = alternative;
        fallbacks++;
      }
    }
    if (!(Math.abs(signed) > 0) || !(raw.area3d > 0)) {
      return err(
        islandFailure(
          'model-degenerate',
          'every island keeps a positive area in 3D and in UV',
          mesh,
          island,
          index,
          'the island is flat or collapsed; repair the faces or exclude them from the unwrap',
        ),
      );
    }
    let refinement: Refinement | undefined;
    if (params.refine === 'slim' && grid === undefined) {
      const r = refineIsland(mesh, island, uv, raw, work);
      if (!r.ok) return r;
      refinement = r.value;
      if (refinement.status === 'accepted') {
        ({ uv } = refinement);
        raw = refinement.metrics;
        signed = raw.areaUv;
        refine.accepted++;
        refine.iterations += refinement.iterations;
        if (refinement.flippedBefore > 0) refine.repaired++;
        else {
          refine.before += refinement.energyBefore * raw.area3d;
          refine.after += refinement.energyAfter * raw.area3d;
          refine.weight += raw.area3d;
        }
      } else if (refinement.status === 'unavailable') refine.unavailable++;
      else refine.rejected++;
    }
    const k = Math.sqrt(raw.area3d / Math.abs(signed));
    for (const p of uv) {
      p[0] *= k;
      p[1] *= k;
    }
    rotateInto(uv, orientation(uv));
    const samples = samplesOf(mesh, island, uv);
    pushAll(allSamples, samples);
    placed.push(uv);
    reports.push({
      faces: island.faces.length,
      ...metricsOf(samples),
      iterations: solved.value.iterations,
      residual: solved.value.residual,
      ...(params.refine === undefined
        ? {}
        : {
            overlaps: refinement?.overlaps ?? 0,
            refineStatus: refinement?.status ?? 'rectified',
            refineIterations: refinement?.status === 'accepted' ? refinement.iterations : 0,
            flippedBefore: refinement?.flippedBefore ?? 0,
            ...(refinement !== undefined && Number.isFinite(refinement.energyBefore)
              ? { energyBefore: refinement.energyBefore }
              : {}),
            ...(refinement === undefined ? {} : { energyAfter: refinement.energyAfter }),
          }),
    });
    iterations += solved.value.iterations;
    residual = Math.max(residual, solved.value.residual);
  }
  // Islands side by side along +u in island order, one shared scale (meters).
  let extent = 0;
  for (const uv of placed) {
    const [x0, y0, x1, y1] = boundsOf(uv);
    extent = Math.max(extent, x1 - x0, y1 - y0);
  }
  const gap = extent * 0.05;
  let cursor = 0;
  for (const uv of placed) {
    const [x0, y0, x1] = boundsOf(uv);
    for (const p of uv) {
      p[0] += cursor - x0;
      p[1] -= y0;
    }
    cursor += x1 - x0 + gap;
  }
  const bytes = encodeCornerUvs(mesh, (h) => {
    const island = faceIsland[mesh.hFace[h] as number] as number;
    return (placed[island] as Uv[])[(islands[island] as Island).element.get(h) as number] as Uv;
  });
  let area3d = 0;
  let l2 = 0;
  let linf = 0;
  let distortion = 1;
  let flipped = 0;
  let zeroArea = 0;
  for (const r of reports) {
    area3d += r.area3d;
    l2 += r.stretchL2 * r.stretchL2 * r.area3d;
    linf = Math.max(linf, r.stretchLinf);
    distortion = Math.max(distortion, r.areaDistortion);
    flipped += r.flipped;
    zeroArea += r.zeroArea;
  }
  return ok({
    status: 'ok',
    outputs: [bytes],
    provenance: { faceIsland: faceIsland.slice(0, mesh.faceHighWater), islands: reports },
    metrics: {
      islands: islands.length,
      faces: mesh.faceCount,
      iterations,
      residual,
      stretchL2: area3d > 0 ? Math.sqrt(l2 / area3d) : 0,
      stretchLinf: linf,
      areaDistortion: distortion,
      texelDensityDispersion: densityDispersion(allSamples),
      flipped,
      zeroArea,
      ...(params.start === undefined ? {} : { fallbacks }),
      ...(params.method === 'rectify' ? { rectified, rectifyFallbacks } : {}),
      ...(params.refine === undefined
        ? {}
        : {
            refined: refine.accepted,
            refineRejected: refine.rejected,
            refineUnavailable: refine.unavailable,
            refineRepaired: refine.repaired,
            refineIterations: refine.iterations,
            overlaps: reports.reduce((n, r) => n + (r.overlaps ?? 0), 0),
            energyBefore: refine.weight > 0 ? refine.before / refine.weight : 0,
            energyAfter: refine.weight > 0 ? refine.after / refine.weight : 0,
          }),
    },
    locations: [],
  });
}

interface Rect {
  readonly island: number;
  readonly width: number;
  readonly height: number;
}

/** Skyline segments [x, y, width] covering [0, resolution) in x. */
type Skyline = [number, number, number][];

/**
 * Bottom-left skyline placement of texel rectangles in a square atlas, both quarter
 * orientations when `rotate`; undefined when they do not fit.
 */
function skyline(
  rects: readonly Rect[],
  resolution: number,
  rotate: boolean,
  work: WorkMeter,
): UvPlacement[] | undefined | ModelingError {
  const line: Skyline = [[0, 0, resolution]];
  const placements: UvPlacement[] = new Array(rects.length);
  for (const rect of rects) {
    if (!work.spend(line.length * 2 + 1)) return work.failure as ModelingError;
    let best: { x: number; y: number; w: number; h: number; turned: boolean } | undefined;
    for (const turned of rotate && rect.width !== rect.height ? [false, true] : [false]) {
      const w = turned ? rect.height : rect.width;
      const h = turned ? rect.width : rect.height;
      for (let i = 0; i < line.length; i++) {
        const x = (line[i] as [number, number, number])[0];
        if (x + w > resolution) break;
        let y = 0;
        for (let j = i; j < line.length; j++) {
          const segment = line[j] as [number, number, number];
          if (segment[0] >= x + w) break;
          y = Math.max(y, segment[1]);
        }
        if (y + h > resolution) continue;
        if (
          best === undefined ||
          y + h < best.y + best.h ||
          (y + h === best.y + best.h && x < best.x)
        ) {
          best = { x, y, w, h, turned };
        }
      }
    }
    if (best === undefined) return undefined;
    placements[rect.island] = {
      x: best.x,
      y: best.y,
      width: best.w,
      height: best.h,
      turned: best.turned,
    };
    const right = best.x + best.w;
    const next: Skyline = [];
    for (const [x, y, w] of line) {
      if (x + w <= best.x || x >= right) {
        next.push([x, y, w]);
        continue;
      }
      if (x < best.x) next.push([x, y, best.x - x]);
      if (x + w > right) next.push([right, y, x + w - right]);
    }
    next.push([best.x, best.y + best.h, best.w]);
    next.sort((a, b) => a[0] - b[0]);
    line.length = 0;
    for (const segment of next) {
      const last = line[line.length - 1];
      if (last !== undefined && last[1] === segment[1]) last[2] += segment[2];
      else line.push(segment);
    }
  }
  return placements;
}

// ---- raster packing -----------------------------------------------------------

/** A rasterized island mask: per row, the occupied runs [from, to) in cells. */
interface Mask {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly (readonly [number, number])[][];
  readonly cells: number;
}

/** 2D separating-axis test of a triangle against the cell [x, x + 1) x [y, y + 1). */
function triangleTouchesCell(t: readonly Uv[], x: number, y: number): boolean {
  const [a, b, c] = t as [Uv, Uv, Uv];
  if (Math.max(a[0], b[0], c[0]) < x || Math.min(a[0], b[0], c[0]) > x + 1) return false;
  if (Math.max(a[1], b[1], c[1]) < y || Math.min(a[1], b[1], c[1]) > y + 1) return false;
  const corners: Uv[] = [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ];
  for (const [p, q, r] of [
    [a, b, c],
    [b, c, a],
    [c, a, b],
  ] as const) {
    const nx = q[1] - p[1];
    const ny = p[0] - q[0];
    const side = nx * (r[0] - p[0]) + ny * (r[1] - p[1]);
    let all = true;
    for (const k of corners) {
      const d = nx * (k[0] - p[0]) + ny * (k[1] - p[1]);
      if (side > 0 ? d >= 0 : side < 0 ? d <= 0 : true) {
        all = false;
        break;
      }
    }
    if (all) return false;
  }
  return true;
}

/**
 * Conservative cell mask of triangles (in cell units, origin at 0), dilated by `grow`
 * cells (a square structuring element), as row runs.
 */
function rasterMask(triangles: readonly (readonly Uv[])[], grow: number): Mask {
  let [x1, y1] = [0, 0];
  for (const t of triangles) {
    for (const p of t) {
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  }
  const w = Math.floor(x1) + 1 + 2 * grow;
  const h = Math.floor(y1) + 1 + 2 * grow;
  const grid = new Uint8Array(w * h);
  for (const t of triangles) {
    const xs = t.map((p) => p[0]);
    const ys = t.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(minOf(ys))); y <= Math.floor(maxOf(ys)); y++) {
      for (let x = Math.max(0, Math.floor(minOf(xs))); x <= Math.floor(maxOf(xs)); x++) {
        if (triangleTouchesCell(t, x, y)) grid[(y + grow) * w + x + grow] = 1;
      }
    }
  }
  // Separable dilation: rows, then columns.
  const across = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) if (grid[y * w + x] === 1) last = x;
    let next = Infinity;
    const nextOf = new Int32Array(w);
    for (let x = w - 1; x >= 0; x--) {
      if (grid[y * w + x] === 1) next = x;
      nextOf[x] = next === Infinity ? 1 << 30 : next;
    }
    last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x] === 1) last = x;
      if (x - last <= grow || (nextOf[x] as number) - x <= grow) across[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    let next = 1 << 30;
    const nextOf = new Int32Array(h);
    for (let y = h - 1; y >= 0; y--) {
      if (across[y * w + x] === 1) next = y;
      nextOf[y] = next;
    }
    for (let y = 0; y < h; y++) {
      if (across[y * w + x] === 1) last = y;
      if (y - last <= grow || (nextOf[y] as number) - y <= grow) out[y * w + x] = 1;
    }
  }
  const rows: [number, number][][] = [];
  let cells = 0;
  for (let y = 0; y < h; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && out[y * w + x] === 1;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        runs.push([start, x]);
        cells += x - start;
        start = -1;
      }
    }
    rows.push(runs);
  }
  return { width: w, height: h, rows, cells };
}

/** Occupancy bitset of the atlas cell grid. */
class Occupancy {
  readonly words: number;
  readonly bits: Uint32Array;
  /** Free cells per row. */
  readonly free: Int32Array;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.words = (size + 31) >>> 5;
    this.bits = new Uint32Array(this.words * size);
    this.free = new Int32Array(size).fill(size);
  }
  /** Highest occupied cell in [from, to) of a row, or -1. */
  lastIn(row: number, from: number, to: number): number {
    const base = row * this.words;
    for (let w = (to - 1) >>> 5; w >= from >>> 5; w--) {
      let word = this.bits[base + w] as number;
      if (word === 0) continue;
      const lo = w << 5;
      if (to - lo < 32) word &= (1 << (to - lo)) - 1 || 0;
      if (from > lo) word &= ~((1 << (from - lo)) - 1);
      word >>>= 0;
      if (word !== 0) return lo + 31 - Math.clz32(word);
    }
    return -1;
  }
  /** Lowest free cell at or after `from` in a row (size when none). */
  firstFree(row: number, from: number): number {
    const base = row * this.words;
    for (let w = from >>> 5; w < this.words; w++) {
      let word = ~(this.bits[base + w] as number);
      const lo = w << 5;
      if (from > lo) word &= ~((1 << (from - lo)) - 1);
      word >>>= 0;
      if (word !== 0) return Math.min(this.size, lo + 31 - Math.clz32(word & -word));
    }
    return this.size;
  }
  /** Mark [from, to) of a row (the cells are free). */
  fill(row: number, from: number, to: number): void {
    for (let x = from; x < to; x++) {
      const w = row * this.words + (x >>> 5);
      this.bits[w] = (this.bits[w] as number) | (1 << (x & 31));
    }
    this.free[row] = (this.free[row] as number) - (to - from);
  }
}

/**
 * First fit of a mask on the grid, lowest row then lowest x. Rows without enough free
 * cells are skipped; along a row, x jumps to the first free cell under the mask's first
 * run and past the last blocking cell of any mask row.
 */
function fitMask(
  grid: Occupancy,
  mask: Mask,
  work: WorkMeter,
): [number, number] | undefined | false {
  const n = grid.size;
  const need = mask.rows.map((runs) => runs.reduce((sum, [a, b]) => sum + b - a, 0));
  const r0 = mask.rows.findIndex((runs) => runs.length > 0);
  const a0 = r0 < 0 ? 0 : ((mask.rows[r0] as [number, number][])[0] as [number, number])[0];
  for (let y = 0; y + mask.height <= n; y++) {
    if (!work.spend(1)) return false;
    let room = true;
    for (let r = 0; r < mask.height && room; r++) {
      if ((grid.free[y + r] as number) < (need[r] as number)) room = false;
    }
    if (!room) continue;
    let x = 0;
    while (x + mask.width <= n) {
      if (r0 >= 0) {
        const f = grid.firstFree(y + r0, x + a0);
        if (f > x + a0) {
          x = f - a0;
          if (x + mask.width > n) break;
        }
      }
      let blocked = -1;
      for (let r = 0; r < mask.height && blocked < 0; r++) {
        if (!work.spend(1)) return false;
        for (const [a, b] of mask.rows[r] as [number, number][]) {
          const last = grid.lastIn(y + r, x + a, x + b);
          if (last >= 0) blocked = Math.max(blocked, last - a + 1);
        }
      }
      if (blocked < 0) return [x, y];
      x = blocked;
    }
  }
  return undefined;
}

const SCALE_STEPS = 24;
const RASTER_STEPS = 8;
/** Largest raster grid side in cells: larger atlases rasterize in cells of several texels. */
const RASTER_CELLS = 512;

/** One island of the job across every input mesh, oriented and normalized, minimum at 0. */
interface PackIsland {
  readonly input: number;
  readonly island: Island;
  readonly faceIsland: number;
  readonly uv: Uv[];
  readonly size: Uv;
  leader?: number;
}

/** Same triangles and the same shape (within 1e-4 of the extent) up to a quarter turn: the follower can take the leader's UVs. */
function congruent(a: PackIsland, b: PackIsland): boolean {
  const ia = a.island;
  const ib = b.island;
  if (ia.vertexOf.length !== ib.vertexOf.length || ia.triangles.length !== ib.triangles.length) {
    return false;
  }
  for (let t = 0; t < ia.triangles.length; t++) {
    if (ia.triangles[t] !== ib.triangles[t]) return false;
  }
  const tol = Math.max(a.size[0], a.size[1]) * 1e-4;
  const [bw, bh] = b.size;
  for (const turn of [0, 1, 2, 3]) {
    const [w, h] = turn % 2 === 0 ? [bw, bh] : [bh, bw];
    if (Math.abs(w - a.size[0]) > tol || Math.abs(h - a.size[1]) > tol) continue;
    let same = true;
    for (let k = 0; k < a.uv.length && same; k++) {
      const [x, y] = b.uv[k] as Uv;
      const [px, py] =
        turn === 0
          ? [x, y]
          : turn === 1
            ? [bh - y, x]
            : turn === 2
              ? [bw - x, bh - y]
              : [y, bw - x];
      const [qx, qy] = a.uv[k] as Uv;
      if (Math.abs(px - qx) > tol || Math.abs(py - qy) > tol) same = false;
    }
    if (same) return true;
  }
  return false;
}

/** Points turned by `angle` degrees about the origin, then moved to a zero minimum. */
function turnedPoints(uv: readonly Uv[], angle: number): Uv[] {
  const a = (angle * Math.PI) / 180;
  const [c, s] = angle % 90 === 0 ? (QUARTER[(angle / 90) % 4] as Uv) : [cos(a), sin(a)];
  const out = uv.map(([x, y]) => [x * c - y * s, x * s + y * c] as Uv);
  const [x0, y0] = boundsOf(out);
  for (const p of out) {
    p[0] -= x0;
    p[1] -= y0;
  }
  return out;
}
const QUARTER: readonly Uv[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * Raster placement of the leaders at `scale` texels per UV unit: each island (in every
 * allowed turn) becomes a conservative cell mask dilated by half the padding; islands
 * go largest first to the lowest, then leftmost, free position of any turn.
 */
function rasterPack(
  leaders: readonly PackIsland[],
  scale: number,
  resolution: number,
  padding: number,
  angles: readonly number[],
  work: WorkMeter,
): UvPlacement[] | undefined | ModelingError {
  const cell = Math.max(1, Math.ceil(resolution / RASTER_CELLS));
  const n = Math.floor(resolution / cell);
  const grow = Math.ceil(padding / (2 * cell));
  const masks = leaders.map((leader) =>
    angles.map((angle) => {
      const pts = turnedPoints(leader.uv, angle).map(
        ([x, y]) => [(x * scale) / cell, (y * scale) / cell] as Uv,
      );
      const tris: Uv[][] = [];
      const t = leader.island.triangles;
      for (let k = 0; k < t.length; k += 3) {
        tris.push([
          pts[t[k] as number] as Uv,
          pts[t[k + 1] as number] as Uv,
          pts[t[k + 2] as number] as Uv,
        ]);
      }
      return rasterMask(tris, grow);
    }),
  );
  if (!work.spend(masks.reduce((sum, m) => sum + (m[0] as Mask).cells, 0))) {
    return work.failure as ModelingError;
  }
  const first = (i: number) => (masks[i] as Mask[])[0] as Mask;
  const indices = leaders.map((_, i) => i);
  // Two greedy strategies; the first that fits wins. Largest area first to the lowest top
  // edge nests islands into each other's holes; tallest first to the lowest origin keeps
  // skyline-like rows, which the first can waste around big round islands.
  const byArea = [...indices].sort((a, b) => first(b).cells - first(a).cells || a - b);
  const largest = first(byArea[0] as number).cells;
  // Greedy strategies, the first that fits wins:
  // - largest first to the lowest top edge (islands nest into each other's holes);
  // - skyline rows for the big islands, then the small ones into the holes and gaps;
  // - tallest first to the lowest origin (skyline-like rows);
  // - plain skyline positions (so raster never fits less than skyline).
  const strategies: { seed: 'big' | 'all' | 'none'; order: number[]; byTop: boolean }[] = [
    { seed: 'none', order: byArea, byTop: true },
    { seed: 'big', order: byArea, byTop: true },
    {
      seed: 'none',
      order: [...indices].sort(
        (a, b) => first(b).height - first(a).height || first(b).width - first(a).width || a - b,
      ),
      byTop: false,
    },
    { seed: 'all', order: byArea, byTop: true },
  ];
  for (const { seed, order, byTop } of strategies) {
    const grid = new Occupancy(n);
    const out: UvPlacement[] = new Array(leaders.length);
    const put = (i: number, x: number, y: number, k: number) => {
      const mask = (masks[i] as Mask[])[k] as Mask;
      for (const [r, runs] of mask.rows.entries()) {
        for (const [a, b] of runs) grid.fill(y + r, x + a, x + b);
      }
      const angle = angles[k] as number;
      out[i] = {
        x: (x + grow) * cell,
        y: (y + grow) * cell,
        width: mask.width * cell,
        height: mask.height * cell,
        turned: angle % 180 !== 0,
        angle,
      };
    };
    const seeded = new Set<number>();
    if (seed !== 'none') {
      const big = indices.filter((i) => seed === 'all' || first(i).cells * 4 >= largest);
      const rows = skyline(
        big
          .map((i, island) => ({ island, width: first(i).width, height: first(i).height }))
          .sort((a, b) => b.height - a.height || b.width - a.width || a.island - b.island),
        n,
        false,
        work,
      );
      if (rows instanceof Error) return rows;
      if (rows === undefined) continue;
      for (const [k, i] of big.entries()) {
        const at = rows[k] as UvPlacement;
        put(i, at.x, at.y, 0);
        seeded.add(i);
      }
    }
    let fits = true;
    for (const i of order) {
      if (seeded.has(i)) continue;
      let best: { x: number; y: number; k: number; key: number } | undefined;
      for (const [k, mask] of (masks[i] as Mask[]).entries()) {
        const at = fitMask(grid, mask, work);
        if (at === false) return work.failure as ModelingError;
        if (at === undefined) continue;
        const key = (byTop ? at[1] + mask.height : at[1]) * (n + 1) + at[0];
        if (best === undefined || key < best.key) best = { x: at[0], y: at[1], k, key };
      }
      if (best === undefined) {
        fits = false;
        break;
      }
      put(i, best.x, best.y, best.k);
    }
    if (fits) return out;
  }
  return undefined;
}

function checkPackParams(params: UvPackJobParams, inputs: number): ModelingError | undefined {
  const { resolution, padding } = params;
  if (!(Number.isInteger(resolution) && resolution >= 16 && resolution <= 16384)) {
    return modelingError('model-invalid-argument', 'resolution is an integer in [16, 16384]', {
      resolution,
    });
  }
  if (!(Number.isInteger(padding) && padding >= 0 && padding < resolution / 4)) {
    return modelingError(
      'model-invalid-argument',
      'padding is an integer texel count in [0, resolution / 4)',
      { padding },
    );
  }
  const method = params.method ?? 'skyline';
  if (method !== 'skyline' && method !== 'raster') {
    return modelingError('model-invalid-argument', "method is 'skyline' or 'raster'", { method });
  }
  if (params.rotateStep !== undefined && params.rotateStep !== 90 && params.rotateStep !== 45) {
    return modelingError('model-invalid-argument', 'rotate step is 90 or 45 degrees', {
      step: params.rotateStep,
    });
  }
  const density = params.density;
  if (
    density !== undefined &&
    !(
      Number.isFinite(density.target) &&
      density.target > 0 &&
      Number.isFinite(density.tolerance) &&
      density.tolerance >= 0 &&
      density.tolerance < 1 &&
      params.normalize
    )
  ) {
    return modelingError(
      'model-invalid-argument',
      'density is { target > 0 texels per meter, tolerance in [0, 1) } on normalized islands',
      { density, normalize: params.normalize },
    );
  }
  if (inputs < 1) {
    return modelingError('model-invalid-argument', 'uv.pack takes at least one FXEM input', {
      inputs,
    });
  }
  return undefined;
}

/**
 * uv.pack: islands of every input (connected components of equal corner values),
 * optionally normalized to their 3D area and oriented to their minimal rectangle,
 * congruent ones stacked, placed by skyline or raster at the largest common scale that
 * fits (or at the density target); one output per input.
 */
export function runPackJob(
  request: ComputeJobRequest<'uv.pack'>,
  work: WorkMeter,
): Result<BackendOutput<'uv.pack'>, ModelingError> {
  const params = request.params;
  const bad = checkPackParams(params, request.inputs.length);
  if (bad !== undefined) return err(bad);
  const { resolution, padding, rotate, normalize } = params;
  const method = params.method ?? 'skyline';
  const meshes: EditMesh[] = [];
  const faceIslands: Int32Array[] = [];
  const all: PackIsland[] = [];
  for (const [input, bytes] of request.inputs.entries()) {
    const decoded = decodeSnapshot(bytes);
    if (!decoded.ok) return decoded;
    const mesh = decoded.value;
    meshes.push(mesh);
    const found = channelIslands(mesh, 'uv0', work);
    if (!found.ok) return found;
    faceIslands.push(found.value.faceIsland);
    for (const [index, island] of found.value.islands.entries()) {
      const uv: Uv[] = island.vertexOf.map(() => [0, 0]);
      for (const [h, k] of island.element) {
        const v = mesh.corner('uv0', h) as Float32Array;
        uv[k] = [v[0] as number, v[1] as number];
      }
      if (normalize) {
        const facts = metricsOf(samplesOf(mesh, island, uv));
        if (facts.areaUv > 0 && facts.area3d > 0) {
          const k = Math.sqrt(facts.area3d / facts.areaUv);
          for (const p of uv) {
            p[0] *= k;
            p[1] *= k;
          }
        }
      }
      if (rotate) rotateInto(uv, orientation(uv));
      const [x0, y0] = boundsOf(uv);
      for (const p of uv) {
        p[0] -= x0;
        p[1] -= y0;
      }
      const [, , x1, y1] = boundsOf(uv);
      all.push({ input, island, faceIsland: index, uv, size: [x1, y1] });
    }
  }
  if (params.stack === true) {
    const buckets = new Map<string, number[]>();
    for (const [i, x] of all.entries()) {
      const key = `${x.island.vertexOf.length}:${x.island.triangles.length}`;
      const list = buckets.get(key) ?? [];
      const leader = list.find((j) => congruent(all[j] as PackIsland, x));
      if (leader !== undefined) x.leader = leader;
      else list.push(i);
      buckets.set(key, list);
    }
  }
  const leaders = all.filter((x) => x.leader === undefined);
  const footprint = leaders.reduce((sum, x) => sum + x.size[0] * x.size[1], 0);
  if (!(footprint > 0)) {
    return err(
      modelingError('model-degenerate', 'the islands cover a positive UV area', {
        islands: all.length,
      }),
    );
  }
  const skylineAt = (scale: number) =>
    skyline(
      leaders
        .map((x, island) => ({
          island,
          width: Math.ceil((x.size[0] as number) * scale) + padding,
          height: Math.ceil((x.size[1] as number) * scale) + padding,
        }))
        .sort((a, b) => b.height - a.height || b.width - a.width || a.island - b.island),
      resolution,
      rotate,
      work,
    );
  const angles = !rotate
    ? [0]
    : params.rotateStep === 45
      ? [0, 45, 90, 135, 180, 225, 270, 315]
      : [0, 90, 180, 270];
  const attempt = (scale: number) =>
    method === 'raster'
      ? rasterPack(leaders, scale, resolution, padding, angles, work)
      : skylineAt(scale);
  let scale: number;
  let placements: UvPlacement[];
  const density = params.density;
  if (density !== undefined) {
    const high = density.target;
    const low = high * (1 - density.tolerance);
    let fitted = attempt(high);
    if (fitted instanceof Error) return err(fitted);
    scale = high;
    if (fitted === undefined) {
      const floor = attempt(low);
      if (floor instanceof Error) return err(floor);
      if (floor === undefined) {
        return err(
          modelingError(
            'model-precondition',
            `the ${all.length} islands fit a ${resolution} texel atlas at ${low.toPrecision(4)} texels per meter or more`,
            {
              islands: all.length,
              resolution,
              padding,
              target: density.target,
              tolerance: density.tolerance,
            },
            'raise the resolution, lower the target or the padding, or split the atlas',
          ),
        );
      }
      fitted = floor;
      scale = low;
      let a = low;
      let b = high;
      for (let step = 0; step < RASTER_STEPS; step++) {
        const mid = (a + b) / 2;
        const tried = attempt(mid);
        if (tried instanceof Error) return err(tried);
        if (tried === undefined) b = mid;
        else {
          a = mid;
          scale = mid;
          fitted = tried;
        }
      }
    }
    placements = fitted;
  } else {
    // The skyline scale is the lower bound: raster then searches above it.
    let high = resolution / Math.sqrt(footprint);
    let low = high;
    let fitted = skylineAt(low);
    for (let i = 0; fitted === undefined && i < 30; i++) {
      high = low;
      low /= 2;
      fitted = skylineAt(low);
    }
    if (fitted instanceof Error) return err(fitted);
    if (fitted === undefined) {
      return err(
        modelingError(
          'model-precondition',
          `the ${all.length} islands fit a ${resolution} texel atlas with ${padding} texel padding`,
          { islands: all.length, resolution, padding },
          'raise the resolution, lower the padding or merge islands (fewer seams)',
        ),
      );
    }
    scale = low;
    placements = fitted;
    for (let step = 0; step < SCALE_STEPS && high > low; step++) {
      const mid = (low + high) / 2;
      const tried = skylineAt(mid);
      if (tried instanceof Error) return err(tried);
      if (tried === undefined) high = mid;
      else {
        low = mid;
        scale = mid;
        placements = tried;
      }
    }
    if (method === 'raster') {
      let area = 0;
      for (const x of leaders)
        area += Math.abs(metricsOf(samplesOf(meshes[x.input] as EditMesh, x.island, x.uv)).areaUv);
      let a = scale;
      let b = Math.max(scale, resolution / Math.sqrt(area));
      const base = attempt(a);
      if (base instanceof Error) return err(base);
      if (base !== undefined) placements = base;
      else {
        // Raster is conservative at cell size: fall back below the skyline scale.
        b = a;
        a = a / 2;
        const lower = attempt(a);
        if (lower instanceof Error) return err(lower);
        if (lower === undefined) {
          return err(
            modelingError(
              'model-precondition',
              `the ${all.length} islands rasterize into the atlas`,
              {
                islands: all.length,
                resolution,
                padding,
              },
            ),
          );
        }
        placements = lower;
        scale = a;
      }
      for (let step = 0; step < RASTER_STEPS && b > a * (1 + 1e-4); step++) {
        const mid = (a + b) / 2;
        const tried = attempt(mid);
        if (tried instanceof Error) return err(tried);
        if (tried === undefined) b = mid;
        else {
          a = mid;
          scale = mid;
          placements = tried;
        }
      }
    }
  }
  const half = padding / 2;
  const finalUv = new Map<PackIsland, Uv[]>();
  for (const [i, x] of leaders.entries()) {
    const at = placements[i] as UvPlacement;
    if (method === 'raster') {
      const pts = turnedPoints(x.uv, at.angle ?? 0);
      finalUv.set(
        x,
        pts.map(
          ([a, b]) => [(at.x + a * scale) / resolution, (at.y + b * scale) / resolution] as Uv,
        ),
      );
      continue;
    }
    const height = x.size[1];
    finalUv.set(
      x,
      x.uv.map(([a, b]) => {
        const [px, py] = at.turned ? [height - b, a] : [a, b];
        return [
          (at.x + half + px * scale) / resolution,
          (at.y + half + py * scale) / resolution,
        ] as Uv;
      }),
    );
  }
  for (const x of all) {
    if (x.leader !== undefined) finalUv.set(x, finalUv.get(all[x.leader] as PackIsland) as Uv[]);
  }
  const outputs: Uint8Array[] = [];
  const samples: TriangleSample[] = [];
  for (const [input, mesh] of meshes.entries()) {
    const mine = all.filter((x) => x.input === input);
    const byIndex = new Map(mine.map((x) => [x.faceIsland, x]));
    const faceIsland = faceIslands[input] as Int32Array;
    outputs.push(
      encodeCornerUvs(mesh, (h) => {
        const x = byIndex.get(faceIsland[mesh.hFace[h] as number] as number) as PackIsland;
        return (finalUv.get(x) as Uv[])[x.island.element.get(h) as number] as Uv;
      }),
    );
    for (const x of mine) {
      if (x.leader === undefined)
        pushAll(samples, samplesOf(mesh, x.island, finalUv.get(x) as Uv[]));
    }
  }
  let coverage = 0;
  let area3d = 0;
  for (const s of samples) {
    coverage += Math.abs(s.areaUv);
    area3d += s.area3d;
  }
  const leaderIndex = new Map(leaders.map((x, i) => [x, i]));
  const allPlacements = all.map((x) =>
    x.leader === undefined
      ? (placements[leaderIndex.get(x) as number] as UvPlacement)
      : {
          ...(placements[leaderIndex.get(all[x.leader] as PackIsland) as number] as UvPlacement),
          leader: x.leader,
        },
  );
  // Raster islands nest into each other's bounding rectangles, so only their union is used.
  const used =
    method === 'raster'
      ? rectUnionArea(placements, resolution)
      : placements.reduce((sum, p) => sum + p.width * p.height, 0);
  return ok({
    status: 'ok',
    outputs,
    provenance: {
      faceIsland:
        faceIslands[0]?.slice(0, (meshes[0] as EditMesh).faceHighWater) ?? new Int32Array(0),
      placements: allPlacements,
    },
    metrics: {
      islands: all.length,
      stacked: all.length - leaders.length,
      inputs: meshes.length,
      raster: method === 'raster' ? 1 : 0,
      resolution,
      padding,
      texelsPerUnit: scale,
      texelsPerMeter: area3d > 0 ? resolution * Math.sqrt(coverage / area3d) : 0,
      coverage,
      rectUtilization: used / (resolution * resolution),
      turned: placements.filter((p) => p.turned).length,
      texelDensityDispersion: densityDispersion(samples),
    },
    locations: [],
  });
}
