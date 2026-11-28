// Multi-resolution graph for the Instant Meshes solvers (Jakob et al. 2015). Level 0 is the field
// mesh's uniform edge-neighbour graph; each coarser level merges the most parallel, most similar-area
// neighbour pairs (downsample_graph). Solvers read only the arrays below.

import type { TriMesh } from './trimesh';

/** Compressed-sparse adjacency: neighbours of i are `id[offset[i]..offset[i+1])`. */
export interface Graph {
  readonly offset: Uint32Array;
  readonly id: Uint32Array;
  readonly weight: Float64Array;
}

export interface Level {
  readonly graph: Graph;
  /** Unit normal per vertex, 3 numbers per vertex. */
  readonly normal: Float64Array;
  /** Position per vertex, 3 numbers per vertex. */
  readonly position: Float64Array;
  /** Dual vertex area per vertex. */
  readonly area: Float64Array;
  /** Finer-level vertex -> this level's vertex. Absent on level 0. */
  readonly toLower: Uint32Array | null;
  /** This level's vertex -> its one or two finer parents (`INVALID` marks an empty slot). */
  readonly toUpper: Uint32Array | null;
}

export interface Hierarchy {
  readonly levels: readonly Level[];
}

export const INVALID = 0xffffffff;

/** Instant Meshes' RCPOVERFLOW (float32): sums below it are treated as empty to avoid overflow. */
const RCP_OVERFLOW = 1e-30;

/** Instant Meshes' MAX_DEPTH: at most this many coarsening steps after level 0. */
export const MAX_DEPTH = 25;

/**
 * Uniform edge-neighbour graph with unit weights (generate_adjacency_matrix_uniform). Each vertex
 * links to every vertex sharing a triangle edge with it; links are sorted by id.
 */
export function uniformGraph(mesh: TriMesh): Graph {
  const nv = mesh.positions.length / 3;
  const tri = mesh.triangles;
  const neighbours: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  for (let t = 0; t < tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tri[t + k] as number;
      const b = tri[t + ((k + 1) % 3)] as number;
      neighbours[a]?.add(b);
      neighbours[b]?.add(a);
    }
  }
  return toGraph(neighbours.map((set) => [...set].sort((x, y) => x - y)));
}

function toGraph(rows: readonly (readonly number[])[]): Graph {
  const offset = new Uint32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++)
    offset[i + 1] = (offset[i] as number) + (rows[i]?.length ?? 0);
  const id = new Uint32Array(offset[rows.length] as number);
  const weight = new Float64Array(id.length).fill(1);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    for (let j = 0; j < row.length; j++) id[(offset[i] as number) + j] = row[j] as number;
  }
  return { offset, id, weight };
}

/**
 * Dual vertex area: for each incident triangle corner, half the two triangles-to-midpoint cross
 * magnitudes (compute_dual_vertex_areas). Each corner contributes independently of winding.
 */
export function dualAreas(mesh: TriMesh): Float64Array {
  const nv = mesh.positions.length / 3;
  const p = mesh.positions;
  const tri = mesh.triangles;
  const area = new Float64Array(nv);
  const at = (i: number): [number, number, number] => [
    p[3 * i] as number,
    p[3 * i + 1] as number,
    p[3 * i + 2] as number,
  ];
  for (let t = 0; t < tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = at(tri[t + k] as number);
      const vn = at(tri[t + ((k + 1) % 3)] as number);
      const vp = at(tri[t + ((k + 2) % 3)] as number);
      const fc = [0, 1, 2].map(
        (c) => ((v[c] as number) + (vn[c] as number) + (vp[c] as number)) / 3,
      ) as [number, number, number];
      const prev = [0, 1, 2].map((c) => 0.5 * ((v[c] as number) + (vp[c] as number))) as [
        number,
        number,
        number,
      ];
      const next = [0, 1, 2].map((c) => 0.5 * ((v[c] as number) + (vn[c] as number))) as [
        number,
        number,
        number,
      ];
      area[tri[t + k] as number] =
        (area[tri[t + k] as number] as number) +
        0.5 * (norm(cross(sub(v, prev), sub(v, fc))) + norm(cross(sub(v, next), sub(v, fc))));
    }
  }
  return area;
}

type V3 = [number, number, number];
function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** Area-weighted normals per vertex from the triangle normals, for the level-0 normal field. */
export function vertexNormals(mesh: TriMesh, area: Float64Array): Float64Array {
  const nv = mesh.positions.length / 3;
  const p = mesh.positions;
  const tri = mesh.triangles;
  const out = new Float64Array(3 * nv);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t] as number;
    const b = tri[t + 1] as number;
    const c = tri[t + 2] as number;
    const e1: V3 = [
      (p[3 * b] as number) - (p[3 * a] as number),
      (p[3 * b + 1] as number) - (p[3 * a + 1] as number),
      (p[3 * b + 2] as number) - (p[3 * a + 2] as number),
    ];
    const e2: V3 = [
      (p[3 * c] as number) - (p[3 * a] as number),
      (p[3 * c + 1] as number) - (p[3 * a + 1] as number),
      (p[3 * c + 2] as number) - (p[3 * a + 2] as number),
    ];
    const n = cross(e1, e2);
    for (const v of [a, b, c]) {
      out[3 * v] = (out[3 * v] as number) + n[0];
      out[3 * v + 1] = (out[3 * v + 1] as number) + n[1];
      out[3 * v + 2] = (out[3 * v + 2] as number) + n[2];
    }
  }
  return normalizeRows(out, area.length);
}

/** Normalizes 3-vectors in place; zero vectors become +X (as Instant Meshes does). */
export function normalizeRows(v: Float64Array, count: number): Float64Array {
  for (let i = 0; i < count; i++) {
    const x = v[3 * i] as number;
    const y = v[3 * i + 1] as number;
    const z = v[3 * i + 2] as number;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0) {
      v[3 * i] = x / l;
      v[3 * i + 1] = y / l;
      v[3 * i + 2] = z / l;
    } else {
      v[3 * i] = 1;
      v[3 * i + 1] = 0;
      v[3 * i + 2] = 0;
    }
  }
  return v;
}

interface Pair {
  readonly i: number;
  readonly j: number;
  readonly order: number;
}

/**
 * One coarsening step (downsample_graph). Candidate pairs are every directed link, scored by
 * normal dot product times area ratio, taken in descending score order (stable on ties, as the
 * deterministic reference). A greedy matching merges each pair whose endpoints are still free.
 */
export function downsample(level: Level): Level {
  const { graph, normal: N, position: V, area: A } = level;
  const nv = A.length;
  const pairs: Pair[] = [];
  for (let i = 0; i < nv; i++) {
    for (let e = graph.offset[i] as number; e < (graph.offset[i + 1] as number); e++) {
      const k = graph.id[e] as number;
      const dp =
        (N[3 * i] as number) * (N[3 * k] as number) +
        (N[3 * i + 1] as number) * (N[3 * k + 1] as number) +
        (N[3 * i + 2] as number) * (N[3 * k + 2] as number);
      const ai = A[i] as number;
      const ak = A[k] as number;
      const ratio = ai > ak ? ai / ak : ak / ai;
      pairs.push({ i, j: k, order: dp * ratio });
    }
  }
  pairs.sort((x, y) => y.order - x.order);
  const matched = new Uint8Array(nv);
  const merged: Pair[] = [];
  for (const e of pairs) {
    if (matched[e.i] || matched[e.j]) continue;
    matched[e.i] = 1;
    matched[e.j] = 1;
    merged.push(e);
  }
  const coarseCount = nv - merged.length;
  const position = new Float64Array(3 * coarseCount);
  const normal = new Float64Array(3 * coarseCount);
  const area = new Float64Array(coarseCount);
  const toUpper = new Uint32Array(2 * coarseCount).fill(INVALID);
  const toLower = new Uint32Array(nv);
  merged.forEach((e, c) => {
    const a1 = A[e.i] as number;
    const a2 = A[e.j] as number;
    const s = a1 + a2;
    for (let d = 0; d < 3; d++) {
      position[3 * c + d] =
        s > RCP_OVERFLOW
          ? ((V[3 * e.i + d] as number) * a1 + (V[3 * e.j + d] as number) * a2) / s
          : ((V[3 * e.i + d] as number) + (V[3 * e.j + d] as number)) * 0.5;
      normal[3 * c + d] = (N[3 * e.i + d] as number) * a1 + (N[3 * e.j + d] as number) * a2;
    }
    area[c] = s;
    toUpper[2 * c] = e.i;
    toUpper[2 * c + 1] = e.j;
    toLower[e.i] = c;
    toLower[e.j] = c;
  });
  let next = merged.length;
  for (let i = 0; i < nv; i++) {
    if (matched[i]) continue;
    const c = next++;
    for (let d = 0; d < 3; d++) {
      position[3 * c + d] = V[3 * i + d] as number;
      normal[3 * c + d] = N[3 * i + d] as number;
    }
    area[c] = A[i] as number;
    toUpper[2 * c] = i;
    toLower[i] = c;
  }
  normalizeRows(normal, coarseCount);
  const rows: [number, number][][] = [];
  for (let c = 0; c < coarseCount; c++) {
    const acc = new Map<number, number>();
    for (let s = 0; s < 2; s++) {
      const up = toUpper[2 * c + s] as number;
      if (up === INVALID) continue;
      for (let e = graph.offset[up] as number; e < (graph.offset[up + 1] as number); e++) {
        const to = toLower[graph.id[e] as number] as number;
        if (to === c) continue;
        acc.set(to, (acc.get(to) ?? 0) + (graph.weight[e] as number));
      }
    }
    rows.push([...acc.entries()].sort((x, y) => x[0] - y[0]));
  }
  return {
    graph: toCoarseGraph(rows),
    normal,
    position,
    area,
    toLower,
    toUpper,
  };
}

function toCoarseGraph(rows: readonly (readonly [number, number])[][]): Graph {
  const offset = new Uint32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++)
    offset[i + 1] = (offset[i] as number) + (rows[i]?.length ?? 0);
  const id = new Uint32Array(offset[rows.length] as number);
  const weight = new Float64Array(id.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    for (let j = 0; j < row.length; j++) {
      const [to, w] = row[j] ?? [0, 0];
      id[(offset[i] as number) + j] = to;
      weight[(offset[i] as number) + j] = w;
    }
  }
  return { offset, id, weight };
}

/** Builds the coarsening pyramid from a level-0 graph until one vertex remains or MAX_DEPTH steps. */
export function buildHierarchy(level0: Level): Hierarchy {
  const levels: Level[] = [level0];
  for (let d = 0; d < MAX_DEPTH; d++) {
    const top = levels[levels.length - 1] as Level;
    if (top.area.length <= 1) break;
    const next = downsample(top);
    if (next.area.length === top.area.length) break;
    levels.push(next);
  }
  return { levels };
}

/** Level 0 from a triangle mesh: uniform graph, area-weighted normals and dual areas. */
export function finestLevel(mesh: TriMesh): Level {
  const area = dualAreas(mesh);
  return {
    graph: uniformGraph(mesh),
    normal: vertexNormals(mesh, area),
    position: Float64Array.from(mesh.positions),
    area,
    toLower: null,
    toUpper: null,
  };
}
