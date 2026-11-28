// Shared mesh vocabulary for the L4 quad evaluator: input validation, vector helpers and topology.
// Independent of the kernel internals on purpose: a producer's mesh is judged by plain arrays only.

export type Vec3 = readonly [number, number, number];

/** A polygon mesh: faces are 3- or 4-index loops (n-gons are accepted and measured as polygons). */
export interface EvalMesh {
  readonly positions: readonly Vec3[];
  readonly faces: readonly (readonly number[])[];
}

/** Closed set of producer input failures; the runner maps each to exit code 2. */
export type InputIssue =
  | { readonly code: 'not-object' }
  | { readonly code: 'bad-positions'; readonly index: number }
  | { readonly code: 'non-finite'; readonly index: number }
  | { readonly code: 'bad-face'; readonly face: number; readonly length: number }
  | { readonly code: 'index-out-of-range'; readonly face: number; readonly index: number }
  | { readonly code: 'no-faces' };

export type ParseResult =
  | { readonly ok: true; readonly mesh: EvalMesh }
  | { readonly ok: false; readonly issue: InputIssue };

export function parseMesh(value: unknown): ParseResult {
  if (typeof value !== 'object' || value === null)
    return { ok: false, issue: { code: 'not-object' } };
  const raw = value as { positions?: unknown; faces?: unknown };
  if (!Array.isArray(raw.positions) || !Array.isArray(raw.faces))
    return { ok: false, issue: { code: 'not-object' } };
  const positions: Vec3[] = [];
  for (const [index, p] of raw.positions.entries()) {
    if (!Array.isArray(p) || p.length !== 3)
      return { ok: false, issue: { code: 'bad-positions', index } };
    if (!p.every((c) => typeof c === 'number' && Number.isFinite(c)))
      return { ok: false, issue: { code: 'non-finite', index } };
    positions.push([p[0] as number, p[1] as number, p[2] as number]);
  }
  if (raw.faces.length === 0) return { ok: false, issue: { code: 'no-faces' } };
  const faces: number[][] = [];
  for (const [face, loop] of raw.faces.entries()) {
    if (!Array.isArray(loop) || (loop.length !== 3 && loop.length !== 4))
      return {
        ok: false,
        issue: { code: 'bad-face', face, length: Array.isArray(loop) ? loop.length : -1 },
      };
    const ids: number[] = [];
    for (const index of loop) {
      if (
        !Number.isInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= positions.length
      )
        return { ok: false, issue: { code: 'index-out-of-range', face, index: index as number } };
      ids.push(index as number);
    }
    faces.push(ids);
  }
  return { ok: true, mesh: { positions, faces } };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Unit vector; the zero vector maps to the zero vector (callers test lengths first). */
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly diag: number;
}

export function boundsOf(points: readonly Vec3[]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  const diag = points.length === 0 ? 0 : length(sub(max, min));
  return { min, max, diag };
}

export interface Topology {
  /** Vertices referenced by at least one face. */
  readonly vertices: number;
  /** Distinct undirected edges (degenerate self-pairs excluded). */
  readonly edges: number;
  readonly faces: number;
  /** V - E + F over the referenced vertices. */
  readonly chi: number;
  /** Edges used by exactly one face. */
  readonly boundaryEdges: number;
  /** Connected components of the boundary-edge graph. */
  readonly boundaryLoops: number;
  /** Edges used by three or more faces. */
  readonly nonManifoldEdges: number;
  /** Connected components of the vertex-face graph. */
  readonly components: number;
  readonly closed: boolean;
  /** Distinct-neighbour valence of each referenced vertex with no boundary edge. */
  readonly interiorValence: readonly number[];
  /** Distinct-neighbour valence of each referenced vertex on a boundary edge. */
  readonly boundaryValence: readonly number[];
}

class DisjointSet {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    let c = i;
    while (this.parent[c] !== r) {
      const next = this.parent[c] as number;
      this.parent[c] = r;
      c = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
  roots(ids: readonly number[]): number {
    return new Set(ids.map((i) => this.find(i))).size;
  }
}

export function topologyOf(mesh: EvalMesh): Topology {
  const n = mesh.positions.length;
  const referenced = new Set<number>();
  const faceCount = new Map<number, number>();
  const neighbours = new Map<number, Set<number>>();
  const add = (a: number, b: number) => {
    let set = neighbours.get(a);
    if (set === undefined) {
      set = new Set();
      neighbours.set(a, set);
    }
    set.add(b);
  };
  for (const loop of mesh.faces) {
    for (const v of loop) referenced.add(v);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      if (a === b) continue;
      const key = a < b ? a * n + b : b * n + a;
      faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
      add(a, b);
      add(b, a);
    }
  }
  const components = new DisjointSet(n);
  const loops = new DisjointSet(n);
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  const boundaryVertices = new Set<number>();
  for (const [key, count] of faceCount) {
    const a = Math.floor(key / n);
    const b = key - a * n;
    components.union(a, b);
    if (count === 1) {
      boundaryEdges++;
      boundaryVertices.add(a);
      boundaryVertices.add(b);
      loops.union(a, b);
    } else if (count > 2) nonManifoldEdges++;
  }
  for (const loop of mesh.faces) for (const v of loop) components.union(v, loop[0] as number);
  const boundaryLoops = loops.roots([...boundaryVertices]);
  const interiorValence: number[] = [];
  const boundaryValence: number[] = [];
  for (const v of [...referenced].sort((x, y) => x - y)) {
    const valence = neighbours.get(v)?.size ?? 0;
    (boundaryVertices.has(v) ? boundaryValence : interiorValence).push(valence);
  }
  const edges = faceCount.size;
  const vertices = referenced.size;
  return {
    vertices,
    edges,
    faces: mesh.faces.length,
    chi: vertices - edges + mesh.faces.length,
    boundaryEdges,
    boundaryLoops,
    nonManifoldEdges,
    components: components.roots([...referenced]),
    closed: boundaryEdges === 0 && referenced.size > 0,
    interiorValence,
    boundaryValence,
  };
}
