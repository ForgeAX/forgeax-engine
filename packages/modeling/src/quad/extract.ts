// Quad extraction from a PoSy lattice (Instant Meshes extract_graph + extract_faces, Jakob et al.
// 2015). Adjacent field vertices whose origins coincide (lattice offset 0) collapse by ascending
// error; surviving clusters become vertices at weighted centroids, short edges are snapped, and the
// link graph is traced into faces. Faces of four sides are emitted as quads; larger faces are split
// about their centroid into quads with edge midpoints, so every output face is a quad.

import { matchPosition, type PositionField } from './field';
import type { Graph } from './hierarchy';
import type { Vec3 } from './trimesh';

export interface QuadMesh {
  /** Vertex positions, 3 numbers per vertex. */
  readonly positions: Float64Array;
  /** Four vertex ids per quad. */
  readonly quads: Uint32Array;
  /** Faces of other than four sides that were split into quads. */
  readonly split: number;
  /** Faces traced from the link graph before splitting. */
  readonly traced: number;
}

export interface ExtractOptions {
  /**
   * Drop clusters that absorbed fewer than avg/10 collapses (spurious vertices). Default false: at the
   * default scale the solve yields almost no collapses, so the rule removes nearly every cluster.
   */
  readonly removeSpurious?: boolean;
  /** Merge edges shorter than 0.3 * scale. Default true. */
  readonly snap?: boolean;
  /** Subdivide every quad into four, for pure-quad output. Default false. */
  readonly pureQuad?: boolean;
}

/** Disjoint-set forest; the root is the lowest-ranked representative. */
class Sets {
  private readonly parent: Uint32Array;
  private readonly rank: Uint32Array;
  constructor(n: number) {
    this.parent = new Uint32Array(n);
    this.rank = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
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
  unite(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const rankA = this.rank[ra] as number;
    const rankB = this.rank[rb] as number;
    const [hi, lo] = rankA >= rankB ? [ra, rb] : [rb, ra];
    this.parent[lo] = hi;
    if (rankA === rankB) this.rank[hi] = rankA + 1;
    return hi;
  }
}

function vec(v: Float64Array, i: number): Vec3 {
  return [v[3 * i] as number, v[3 * i + 1] as number, v[3 * i + 2] as number];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function len2(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Extracts the quad mesh from a converged position field and the graph the solve used. */
export function extractQuads(
  field: PositionField,
  graph: Graph,
  options: ExtractOptions = {},
): QuadMesh {
  const nv = field.origin.length / 3;
  const s = field.scale;
  const sets = new Sets(nv);
  const meshPos = field.orientation.mesh.positions;
  const normal = field.orientation.normal;

  // Classify links: lattice-neighbour edges are kept; zero-offset pairs are collapse candidates.
  const collapses: { i: number; j: number; error: number }[] = [];
  const adjacency: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  for (let i = 0; i < nv; i++) {
    for (let e = graph.offset[i] as number; e < (graph.offset[i + 1] as number); e++) {
      const j = graph.id[e] as number;
      if (j < i) continue;
      const m = matchPosition(field, i, j);
      const ox = Math.abs(m.offset[0]);
      const oy = Math.abs(m.offset[1]);
      // Only the four lattice directions are quad edges; diagonal offsets (1,1) are not links.
      if (ox + oy > 1) continue;
      if (ox === 0 && oy === 0) collapses.push({ i, j, error: m.error });
      else {
        adjacency[i]?.add(j);
        adjacency[j]?.add(i);
      }
    }
  }

  // Collapse ascending by error; skip a pair already joined through a shared lattice edge.
  collapses.sort((a, b) => a.error - b.error);
  const collapseCount = new Uint32Array(nv);
  for (const c of collapses) {
    const a = sets.find(c.i);
    const b = sets.find(c.j);
    if (a === b) continue;
    let conflict = false;
    for (const n of adjacency[a] ?? []) {
      if (sets.find(n) === b) {
        conflict = true;
        break;
      }
    }
    if (conflict) continue;
    const root = sets.unite(a, b);
    const other = root === a ? b : a;
    for (const n of adjacency[other] ?? []) adjacency[root]?.add(n);
    adjacency[other]?.clear();
    collapseCount[root] = (collapseCount[a] as number) + (collapseCount[b] as number) + 1;
  }

  // Cluster representatives become vertices; each carries the area-free weighted centroid.
  const clusterOf = new Int32Array(nv).fill(-1);
  const roots: number[] = [];
  for (let i = 0; i < nv; i++) {
    const r = sets.find(i);
    if (clusterOf[r] === -1) {
      clusterOf[r] = roots.length;
      roots.push(r);
    }
  }
  const vcount = roots.length;
  const members: number[][] = Array.from({ length: vcount }, () => []);
  for (let i = 0; i < nv; i++) members[clusterOf[sets.find(i)] as number]?.push(i);

  const pos = new Float64Array(3 * vcount);
  const clusterNormal: Vec3[] = [];
  for (let c = 0; c < vcount; c++) {
    let wsum = 0;
    const p = new Float64Array(3);
    const n = new Float64Array(3);
    for (const i of members[c] ?? []) {
      const d2 = len2(sub(vec(field.origin, i), vec(meshPos, i)));
      // Rational weight 1 / (1 + 9 d^2 / s^2) replaces exp(-9 d^2 / s^2): the kernel bans approximated Math.
      const w = 1 / (1 + (d2 * 9) / (s * s));
      wsum += w;
      const oi = vec(field.origin, i);
      const ni = vec(normal, i);
      for (const d of [0, 1, 2] as const) {
        p[d] = (p[d] as number) + (oi[d] ?? 0) * w;
        n[d] = (n[d] as number) + (ni[d] ?? 0) * w;
      }
    }
    if (wsum > 0) {
      for (let d = 0; d < 3; d++) pos[3 * c + d] = (p[d] as number) / wsum;
    }
    clusterNormal.push([n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]);
  }

  const links: Set<number>[] = Array.from({ length: vcount }, () => new Set<number>());
  for (let i = 0; i < nv; i++) {
    const ci = clusterOf[sets.find(i)] as number;
    for (const j of adjacency[i] ?? []) {
      const cj = clusterOf[sets.find(j)] as number;
      if (ci !== cj) {
        links[ci]?.add(cj);
        links[cj]?.add(ci);
      }
    }
  }

  // Spurious removal: clusters that absorbed fewer than avg/10 collapses are detached.
  if (options.removeSpurious ?? false) {
    // Average over clusters that still have links, as the reference does.
    let total = 0;
    let linked = 0;
    for (let c = 0; c < vcount; c++) {
      if ((links[c]?.size ?? 0) === 0) continue;
      total += collapseCount[roots[c] as number] as number;
      linked++;
    }
    const avg = linked > 0 ? total / linked : 0;
    for (let c = 0; c < vcount; c++) {
      if ((links[c]?.size ?? 0) === 0) continue;
      if ((collapseCount[roots[c] as number] as number) > avg / 10) continue;
      for (const n of links[c] ?? []) links[n]?.delete(c);
      links[c]?.clear();
    }
  }

  // Snap: an edge shorter than 0.3 scale is contracted to its midpoint.
  if (options.snap ?? true) snapEdges(pos, links, 0.3 * s);

  const traced = traceFaces(pos, links, vcount, clusterNormal);
  return options.pureQuad
    ? subdivide(traced.positions, traced.quads, traced.split, traced.traced)
    : traced;
}

function distance(pos: Float64Array, a: number, b: number): number {
  return Math.sqrt(len2(sub(vec(pos, a), vec(pos, b))));
}

/** Contracts each short edge into its midpoint, merging neighbour sets. */
function snapEdges(pos: Float64Array, links: Set<number>[], thresh: number): void {
  let changed = true;
  for (let pass = 0; changed && pass < 16; pass++) {
    changed = false;
    for (let i = 0; i < links.length; i++) {
      for (const j of [...(links[i] ?? [])]) {
        if (j === i || distance(pos, i, j) >= thresh) continue;
        for (let d = 0; d < 3; d++) {
          pos[3 * i + d] = ((pos[3 * i + d] as number) + (pos[3 * j + d] as number)) * 0.5;
        }
        links[i]?.delete(j);
        for (const n of links[j] ?? []) {
          if (n === i) continue;
          links[n]?.delete(j);
          links[n]?.add(i);
          links[i]?.add(n);
        }
        links[j]?.clear();
        changed = true;
      }
    }
  }
}

/** Neighbours of v ordered by angle around v in the tangent plane of its normal. */
function angularOrder(pos: Float64Array, links: Set<number>[], v: number, n: Vec3): number[] {
  const len = Math.sqrt(len2(n)) || 1;
  const nn: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  const seed: Vec3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = cross(nn, seed);
  const l1 = Math.sqrt(len2(e1)) || 1;
  const u: Vec3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const w = cross(nn, u);
  const origin = vec(pos, v);
  const dirs = [...(links[v] ?? [])].map((n2) => {
    const d = sub(vec(pos, n2), origin);
    return { id: n2, x: dot(d, u), y: dot(d, w) };
  });
  // Exact angular order by half-plane then cross product: no atan2 (the kernel bans approximated Math).
  const half = (p: { x: number; y: number }): number => (p.y > 0 || (p.y === 0 && p.x > 0) ? 0 : 1);
  dirs.sort((a, b) => {
    const ha = half(a);
    const hb = half(b);
    if (ha !== hb) return ha - hb;
    const c = a.x * b.y - a.y * b.x;
    return c > 0 ? -1 : c < 0 ? 1 : 0;
  });
  return dirs.map((x) => x.id);
}

/**
 * Traces faces: from each unused directed link a->b, the walk keeps the face on its left by
 * taking, at every vertex, the neighbour that follows the incoming edge in clockwise order.
 * A walk that returns to its start is a face; open walks are discarded.
 */
function traceFaces(
  pos: Float64Array,
  links: Set<number>[],
  vcount: number,
  normals: Vec3[],
): QuadMesh {
  const used = new Set<number>();
  const faces: number[][] = [];
  const key = (a: number, b: number): number => a * vcount + b;
  const orderCache = new Map<number, number[]>();
  const order = (v: number): number[] => {
    let o = orderCache.get(v);
    if (!o) {
      o = angularOrder(pos, links, v, normals[v] ?? [0, 0, 1]);
      orderCache.set(v, o);
    }
    return o;
  };
  for (let a = 0; a < vcount; a++) {
    for (const b of links[a] ?? []) {
      if (used.has(key(a, b))) continue;
      const loop: number[] = [a];
      let prev = a;
      let cur = b;
      let closed = false;
      for (let guard = 0; guard < 4 * vcount + 8; guard++) {
        if (cur === a) {
          closed = true;
          break;
        }
        loop.push(cur);
        const ring = order(cur);
        const at = ring.indexOf(prev);
        if (at < 0 || ring.length < 2) break;
        cur = ring[(at - 1 + ring.length) % ring.length] as number;
        prev = loop[loop.length - 1] as number;
      }
      if (!closed || loop.length < 3) continue;
      for (let k = 0; k < loop.length; k++) {
        used.add(key(loop[k] as number, loop[(k + 1) % loop.length] as number));
      }
      faces.push(loop);
    }
  }
  const outPos: number[] = Array.from(pos);
  const quads: number[] = [];
  let split = 0;
  for (const face of faces) {
    if (face.length === 4) {
      quads.push(face[0] as number, face[1] as number, face[2] as number, face[3] as number);
      continue;
    }
    // Split: centroid plus edge midpoints, one quad per original side.
    split++;
    const c = outPos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of face) {
      cx += pos[3 * v] as number;
      cy += pos[3 * v + 1] as number;
      cz += pos[3 * v + 2] as number;
    }
    outPos.push(cx / face.length, cy / face.length, cz / face.length);
    const mids: number[] = [];
    for (let k = 0; k < face.length; k++) {
      const a = face[k] as number;
      const b = face[(k + 1) % face.length] as number;
      mids.push(outPos.length / 3);
      outPos.push(
        ((pos[3 * a] as number) + (pos[3 * b] as number)) * 0.5,
        ((pos[3 * a + 1] as number) + (pos[3 * b + 1] as number)) * 0.5,
        ((pos[3 * a + 2] as number) + (pos[3 * b + 2] as number)) * 0.5,
      );
    }
    for (let k = 0; k < face.length; k++) {
      const prevMid = mids[(k - 1 + face.length) % face.length] as number;
      quads.push(face[k] as number, mids[k] as number, c, prevMid);
    }
  }
  return compact({
    positions: Float64Array.from(outPos),
    quads: Uint32Array.from(quads),
    split,
    traced: faces.length,
  });
}

/** Drops unreferenced vertices and renumbers the quads densely. */
function compact(mesh: QuadMesh): QuadMesh {
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const keep: number[] = [];
  for (const v of mesh.quads) {
    if (remap[v] === -1) {
      remap[v] = keep.length;
      keep.push(v);
    }
  }
  const positions = new Float64Array(3 * keep.length);
  keep.forEach((old, i) => {
    positions[3 * i] = mesh.positions[3 * old] as number;
    positions[3 * i + 1] = mesh.positions[3 * old + 1] as number;
    positions[3 * i + 2] = mesh.positions[3 * old + 2] as number;
  });
  const quads = Uint32Array.from(mesh.quads, (v) => remap[v] as number);
  return { positions, quads, split: mesh.split, traced: mesh.traced };
}

/** Pure-quad output: every quad splits into four with shared edge midpoints and a centroid. */
function subdivide(pos: Float64Array, quads: Uint32Array, split: number, traced: number): QuadMesh {
  const outPos: number[] = Array.from(pos);
  const midOf = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const k = `${lo}:${hi}`;
    const hit = midOf.get(k);
    if (hit !== undefined) return hit;
    const id = outPos.length / 3;
    for (let d = 0; d < 3; d++) {
      outPos.push(((pos[3 * a + d] as number) + (pos[3 * b + d] as number)) * 0.5);
    }
    midOf.set(k, id);
    return id;
  };
  const out: number[] = [];
  for (let q = 0; q < quads.length; q += 4) {
    const v = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]] as number[];
    const c = outPos.length / 3;
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (const x of v) sum += pos[3 * x + d] as number;
      outPos.push(sum / 4);
    }
    for (let k = 0; k < 4; k++) {
      const a = v[k] as number;
      const b = v[(k + 1) % 4] as number;
      const prev = v[(k + 3) % 4] as number;
      out.push(a, midpoint(a, b), c, midpoint(prev, a));
    }
  }
  return { positions: Float64Array.from(outPos), quads: Uint32Array.from(out), split, traced };
}
