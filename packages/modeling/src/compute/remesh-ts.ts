import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, pushAll, replaceAll } from '../arrays';
import { CREASE_BITS, mergeFlags } from '../crease';
import type { ModelingError } from '../errors';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import type { Tuple3 } from '../geom';
import { EDGE_SEAM, EDGE_SHARP, EditMesh, edgeEnds, edgeKey, NONE } from '../mesh';
import { jobTriangles } from './boolean-ts';
import { ClearanceGrid } from './clearance';
import type {
  BackendOutput,
  ComputeJobRequest,
  ComputeLocation,
  ConstraintLevel,
  QuadricKind,
  RemeshConstraints,
  RemeshDirection,
  RemeshJobParams,
  WorkMeter,
} from './job';
import { flowAt, type LineField, lineField } from './line-field';
import { hausdorff, PrimitiveGrid, solveSymmetric, soupVolume } from './mesh-query';

/**
 * TS baseline of the `remesh` job on a working triangle mesh of the selected faces:
 * Garland-Heckbert QEM edge collapse (plane, volume-preserving or vertex-normal
 * attribute quadrics; priority queue) and Botsch-Kobbelt isotropic remeshing
 * (split > 4/3 L, collapse < 4/5 L, valence flips, tangential smoothing with
 * reprojection, dirty-vertex queue). Both honour the design 5.6 constraint classes:
 * feature edges (boundary, sharp, seam or UV break, material, label) slide or pin,
 * feature vertices of valence 1 or >= 3 stay fixed, the selection border is pinned,
 * and collapses never flip a triangle normal. Every output triangle carries the
 * attributes of the source face it came from; corner values transfer by closest point
 * within their source UV island.
 */

const F_BOUNDARY = 1;
const F_SHARP = 2;
const F_SEAM = 4;
const F_MATERIAL = 8;
const F_LABEL = 16;
const F_BORDER = 32;
const F_UV = 64;
/** The edge's crease byte (infinite or half-sharp level) rides above the feature bits. */
const F_CREASE_SHIFT = 8;
const F_FEATURE_BITS = (1 << F_CREASE_SHIFT) - 1;

function mergeBits(a: number, b: number): number {
  const crease = mergeFlags(a >> F_CREASE_SHIFT, b >> F_CREASE_SHIFT);
  return (((a | b) & F_FEATURE_BITS) | (crease << F_CREASE_SHIFT)) >>> 0;
}

/** Smallest cosine between a triangle normal before and after a simplify collapse (foldover guard). */
const MIN_NORMAL_DOT = 0.2;
/**
 * Isotropic remeshing keeps the shape it reprojects onto: a collapse, flip or smoothing
 * move may turn a triangle by at most 45 degrees, so rounded creases finer than the
 * target length keep their triangles instead of folding into teeth.
 */
const REMESH_NORMAL_DOT = Math.SQRT1_2;
/** Flips keep creases sharper than about 25 degrees (an implicit feature). */
const FLIP_CREASE_DOT = 0.9;

function maskOf(constraints: RemeshConstraints, level: (l: ConstraintLevel) => boolean): number {
  let mask = 0;
  if (level(constraints.boundary)) mask |= F_BOUNDARY;
  if (level(constraints.sharp)) mask |= F_SHARP;
  if (level(constraints.seam)) mask |= F_SEAM | F_UV;
  if (level(constraints.material)) mask |= F_MATERIAL;
  if (level(constraints.label)) mask |= F_LABEL;
  return mask;
}

/** Working triangle mesh: flat arrays, dead triangles have tri[3t] = -1. */
class Work {
  readonly pos: number[];
  readonly tri: number[] = [];
  readonly src: number[] = [];
  readonly vt: number[][];
  readonly alive: boolean[];
  readonly flags = new Map<number, number>();
  /** 0 free, 1 on a feature curve, 2 fixed. */
  readonly vclass: number[];
  /** Feature bits of the curve a vertex lies on. */
  readonly vfeat: number[];
  /** On an open edge; conservative (never cleared by a collapse). */
  readonly boundary: boolean[];
  triangles = 0;

  constructor(points: Float64Array, vertices: number) {
    this.pos = Array.from(points.subarray(0, vertices * 3));
    this.vt = Array.from({ length: vertices }, () => []);
    this.alive = new Array(vertices).fill(true);
    this.vclass = new Array(vertices).fill(0);
    this.vfeat = new Array(vertices).fill(0);
    this.boundary = new Array(vertices).fill(false);
  }

  p(v: number): Tuple3 {
    return [
      this.pos[v * 3] as number,
      this.pos[v * 3 + 1] as number,
      this.pos[v * 3 + 2] as number,
    ];
  }

  set(v: number, p: Tuple3): void {
    this.pos[v * 3] = p[0];
    this.pos[v * 3 + 1] = p[1];
    this.pos[v * 3 + 2] = p[2];
  }

  addVertex(p: Tuple3): number {
    const v = this.alive.length;
    this.pos.push(p[0], p[1], p[2]);
    this.vt.push([]);
    this.alive.push(true);
    this.vclass.push(0);
    this.vfeat.push(0);
    this.boundary.push(false);
    return v;
  }

  addTri(a: number, b: number, c: number, src: number): number {
    const t = this.src.length;
    this.tri.push(a, b, c);
    this.src.push(src);
    (this.vt[a] as number[]).push(t);
    (this.vt[b] as number[]).push(t);
    (this.vt[c] as number[]).push(t);
    this.triangles++;
    return t;
  }

  corners(t: number): [number, number, number] {
    return [
      this.tri[t * 3] as number,
      this.tri[t * 3 + 1] as number,
      this.tri[t * 3 + 2] as number,
    ];
  }

  flag(a: number, b: number): number {
    return this.flags.get(edgeKey(a, b)) ?? 0;
  }

  /** Triangles on edge ab. */
  edgeTris(a: number, b: number): number[] {
    const out: number[] = [];
    for (const t of this.vt[a] as number[]) {
      const [x, y, z] = this.corners(t);
      if (x === b || y === b || z === b) out.push(t);
    }
    return out;
  }

  /** Triangle t rotated so that it starts with the directed edge a->b or b->a: [p, q, opposite]. */
  rotated(t: number, a: number, b: number): [number, number, number] {
    const c = this.corners(t);
    for (let i = 0; i < 3; i++) {
      const p = c[i] as number;
      const q = c[(i + 1) % 3] as number;
      if ((p === a && q === b) || (p === b && q === a)) return [p, q, c[(i + 2) % 3] as number];
    }
    return c;
  }

  neighbours(v: number): number[] {
    return [...this.neighbourSet(v)].sort((x, y) => x - y);
  }

  /** Neighbour count, without building or ordering the list. */
  valence(v: number): number {
    return this.neighbourSet(v).size;
  }

  private neighbourSet(v: number): Set<number> {
    const out = new Set<number>();
    for (const t of this.vt[v] as number[]) {
      for (let k = 0; k < 3; k++) {
        const x = this.tri[t * 3 + k] as number;
        if (x !== v) out.add(x);
      }
    }
    return out;
  }

  isBoundaryVertex(v: number): boolean {
    return this.boundary[v] === true;
  }

  markBoundaries(): void {
    for (let t = 0; t < this.src.length; t++) {
      const c = this.corners(t);
      for (let i = 0; i < 3; i++) {
        const a = c[i] as number;
        const b = c[(i + 1) % 3] as number;
        if (this.edgeTris(a, b).length === 1) {
          this.boundary[a] = true;
          this.boundary[b] = true;
        }
      }
    }
  }

  normal(t: number, moved?: number, to?: Tuple3): Tuple3 {
    const [a, b, c] = this.corners(t).map((v) => (v === moved ? (to as Tuple3) : this.p(v))) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  }

  length(a: number, b: number): number {
    const p = this.p(a);
    const q = this.p(b);
    return Math.sqrt(sq(p[0] - q[0]) + sq(p[1] - q[1]) + sq(p[2] - q[2]));
  }

  /** Edge keys around the vertices, ascending. */
  edgesAround(vertices: Iterable<number>): number[] {
    const keys = new Set<number>();
    for (const v of vertices) {
      if (!this.alive[v]) continue;
      for (const x of this.neighbourSet(v)) keys.add(edgeKey(v, x));
    }
    return [...keys].sort((x, y) => x - y);
  }

  /** Remove `remove`, merging it into `keep` at `position`; the triangles on the edge die. */
  collapse(keep: number, remove: number, position: Tuple3): void {
    for (const x of this.neighbours(remove)) {
      const from = edgeKey(remove, x);
      const bits = this.flags.get(from) ?? 0;
      this.flags.delete(from);
      if (x === keep) continue;
      const to = edgeKey(keep, x);
      const merged = mergeBits(this.flags.get(to) ?? 0, bits);
      if (merged !== 0) this.flags.set(to, merged);
    }
    for (const t of [...(this.vt[remove] as number[])]) {
      const c = this.corners(t);
      if (c.includes(keep)) {
        for (const v of c) {
          const list = this.vt[v] as number[];
          list.splice(list.indexOf(t), 1);
        }
        this.tri[t * 3] = -1;
        this.triangles--;
        continue;
      }
      for (let i = 0; i < 3; i++) if (this.tri[t * 3 + i] === remove) this.tri[t * 3 + i] = keep;
      (this.vt[keep] as number[]).push(t);
    }
    this.vt[remove] = [];
    this.alive[remove] = false;
    this.boundary[keep] = this.boundary[keep] === true || this.boundary[remove] === true;
    this.set(keep, position);
  }

  split(a: number, b: number, position: Tuple3): number {
    const open = this.edgeTris(a, b).length === 1;
    const m = this.addVertex(position);
    this.boundary[m] = open;
    for (const t of this.edgeTris(a, b)) {
      const [p, q, c] = this.rotated(t, a, b);
      this.tri[t * 3] = p;
      this.tri[t * 3 + 1] = m;
      this.tri[t * 3 + 2] = c;
      const list = this.vt[q] as number[];
      list.splice(list.indexOf(t), 1);
      (this.vt[m] as number[]).push(t);
      this.addTri(m, q, c, this.src[t] as number);
    }
    const bits = this.flags.get(edgeKey(a, b)) ?? 0;
    this.flags.delete(edgeKey(a, b));
    if (bits !== 0) {
      this.flags.set(edgeKey(a, m), bits);
      this.flags.set(edgeKey(m, b), bits);
    }
    return m;
  }

  /** Flip interior edge ab: (a, b, c) and (b, a, d) become (c, a, d) and (d, b, c). */
  flip(a: number, b: number): void {
    const [first, second] = orientedPair(this, a, b) as [number, number];
    const c = this.rotated(first, a, b)[2];
    const d = this.rotated(second, a, b)[2];
    this.tri[first * 3] = c;
    this.tri[first * 3 + 1] = a;
    this.tri[first * 3 + 2] = d;
    this.tri[second * 3] = d;
    this.tri[second * 3 + 1] = b;
    this.tri[second * 3 + 2] = c;
    const drop = (v: number, t: number) => {
      const list = this.vt[v] as number[];
      list.splice(list.indexOf(t), 1);
    };
    drop(a, second);
    drop(b, first);
    (this.vt[c] as number[]).push(second);
    (this.vt[d] as number[]).push(first);
  }
}

/** First triangle of edge ab that runs a->b, and its partner. */
function orientedPair(w: Work, a: number, b: number): [number, number] | undefined {
  const tris = w.edgeTris(a, b);
  if (tris.length !== 2) return undefined;
  const [t1, t2] = tris as [number, number];
  const c = w.corners(t1);
  for (let i = 0; i < 3; i++) if (c[i] === a && c[(i + 1) % 3] === b) return [t1, t2];
  return [t2, t1];
}

function sq(x: number): number {
  return x * x;
}

function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Tuple3): number {
  return Math.sqrt(dot(a, a));
}

interface Setup {
  readonly mesh: EditMesh;
  readonly work: Work;
  readonly selected: Uint8Array;
  readonly featureMask: number;
  readonly pinMask: number;
  /** Original selected triangles (vertex ids) and their source faces. */
  readonly sourceCorners: Int32Array;
  readonly sourceFace: Int32Array;
  readonly sourceHalves: Int32Array;
  readonly segments: { readonly corners: Int32Array; readonly bits: number[] };
  readonly scale: number;
}

function cornerValuesDiffer(mesh: EditMesh, h1: number, h2: number): boolean {
  for (const name of mesh.channels.keys()) {
    const x = mesh.corner(name, h1);
    const y = mesh.corner(name, h2);
    if ((x === undefined) !== (y === undefined)) return true;
    if (x !== undefined && y !== undefined) {
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return true;
    }
  }
  return false;
}

function sameLabel(mesh: EditMesh, f: number, g: number): boolean {
  if (mesh.fLabel[f] !== mesh.fLabel[g] || mesh.fRole[f] !== mesh.fRole[g]) return false;
  for (let w = 0; w < mesh.tagWords; w++) {
    if (mesh.fTags[f * mesh.tagWords + w] !== mesh.fTags[g * mesh.tagWords + w]) return false;
  }
  return true;
}

function setup(mesh: EditMesh, params: RemeshJobParams): Result<Setup, ModelingError> {
  const selected = new Uint8Array(mesh.faceHighWater);
  const faces = params.faces === 'all' ? mesh.faces() : params.faces;
  for (const f of faces) selected[f] = 1;
  const work = new Work(mesh.pos, mesh.vertexHighWater);
  const triangles = jobTriangles(mesh);
  const sourceCorners: number[] = [];
  const sourceFace: number[] = [];
  const sourceHalves: number[] = [];
  for (const f of faces) {
    let tris = triangles[f];
    if (tris === undefined) {
      const halves = mesh.faceHalves(f);
      tris = [];
      for (let i = 1; i + 1 < halves.length; i++) {
        tris.push([halves[0] as number, halves[i] as number, halves[i + 1] as number]);
      }
    }
    for (const tri of tris) {
      const [a, b, c] = tri.map((h) => mesh.hVert[h] as number) as [number, number, number];
      work.addTri(a, b, c, f);
      sourceCorners.push(a, b, c);
      sourceFace.push(f);
      pushAll(sourceHalves, tri);
    }
  }
  work.markBoundaries();
  const featureMask = maskOf(params.constraints, (l) => l !== 'free') | F_BORDER;
  const pinMask = maskOf(params.constraints, (l) => l === 'pin') | F_BORDER;
  const segCorners: number[] = [];
  const segBits: number[] = [];
  for (const e of mesh.edges()) {
    const f1 = mesh.hFace[e * 2] as number;
    const f2 = mesh.hFace[e * 2 + 1] as number;
    const s1 = f1 !== NONE && (selected[f1] as number) === 1;
    const s2 = f2 !== NONE && (selected[f2] as number) === 1;
    if (!s1 && !s2) continue;
    const [a, b] = mesh.edgeVertices(e);
    let bits = 0;
    if (f1 === NONE || f2 === NONE) bits |= F_BOUNDARY;
    else if (s1 !== s2) bits |= F_BORDER;
    const intent = mesh.eFlags[e] as number;
    if ((intent & EDGE_SHARP) !== 0) bits |= F_SHARP | ((intent & CREASE_BITS) << F_CREASE_SHIFT);
    if ((intent & EDGE_SEAM) !== 0) bits |= F_SEAM;
    if (f1 !== NONE && f2 !== NONE) {
      if (mesh.fMaterial[f1] !== mesh.fMaterial[f2]) bits |= F_MATERIAL;
      if (!sameLabel(mesh, f1, f2)) bits |= F_LABEL;
      // Corner h of face f1 sits at hVert[h]; the twin face's corner at the same vertex is next(twin).
      const h1 = e * 2;
      const h2 = e * 2 + 1;
      if (
        cornerValuesDiffer(mesh, h1, mesh.hNext[h2] as number) ||
        cornerValuesDiffer(mesh, h2, mesh.hNext[h1] as number)
      ) {
        bits |= F_UV;
      }
    }
    if (bits === 0) continue;
    work.flags.set(edgeKey(a, b), bits);
    if ((bits & featureMask) !== 0) {
      segCorners.push(a, b, b);
      segBits.push(bits & featureMask);
    }
  }
  const counts = new Map<number, number>();
  for (const [key, bits] of work.flags) {
    const [a, b] = edgeEnds(key);
    for (const v of [a, b]) {
      if ((bits & pinMask) !== 0) work.vclass[v] = 2;
      if ((bits & featureMask) !== 0) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
        work.vfeat[v] = (work.vfeat[v] as number) | (bits & featureMask);
      }
    }
  }
  for (const [v, count] of counts) {
    if ((work.vclass[v] as number) !== 2) work.vclass[v] = count === 2 ? 1 : 2;
  }
  let lo: Tuple3 = [Infinity, Infinity, Infinity];
  let hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const v of sourceCorners) {
    const p = work.p(v);
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  const scale = Math.max(norm([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]), 1e-9);
  return ok({
    mesh,
    work,
    selected,
    featureMask,
    pinMask,
    sourceCorners: Int32Array.from(sourceCorners),
    sourceFace: Int32Array.from(sourceFace),
    sourceHalves: Int32Array.from(sourceHalves),
    segments: { corners: Int32Array.from(segCorners), bits: segBits },
    scale,
  });
}

// ---- shared collapse rules --------------------------------------------------------------

interface CollapsePlan {
  readonly keep: number;
  readonly remove: number;
  /** 'free' collapses choose their position; 'keep' stays at keep; 'curve' slides along ab. */
  readonly kind: 'free' | 'keep' | 'curve';
}

function plan(s: Setup, a: number, b: number): CollapsePlan | undefined {
  const w = s.work;
  const ca = w.vclass[a] as number;
  const cb = w.vclass[b] as number;
  const bits = w.flag(a, b);
  if ((bits & s.pinMask) !== 0) return undefined;
  const along = (bits & s.featureMask) !== 0;
  if (ca === 2 && cb === 2) return undefined;
  if (ca === 0 && cb === 0) {
    if (
      (bits & F_BOUNDARY) === 0 &&
      w.edgeTris(a, b).length === 2 &&
      w.isBoundaryVertex(a) &&
      w.isBoundaryVertex(b)
    ) {
      return undefined;
    }
    return { keep: Math.min(a, b), remove: Math.max(a, b), kind: 'free' };
  }
  if (ca === 0) return { keep: b, remove: a, kind: 'keep' };
  if (cb === 0) return { keep: a, remove: b, kind: 'keep' };
  if (!along) return undefined;
  if (ca === 2) return { keep: a, remove: b, kind: 'keep' };
  if (cb === 2) return { keep: b, remove: a, kind: 'keep' };
  return { keep: Math.min(a, b), remove: Math.max(a, b), kind: 'curve' };
}

/**
 * Topology and geometry checks of a collapse: the link condition, no vertex left
 * with fewer than three neighbours, and no surviving triangle around either end
 * that degenerates or turns more than acos(minDot).
 */
function collapseAllowed(
  s: Setup,
  p: CollapsePlan,
  position: Tuple3,
  maxLength: number,
  minDot: number,
): boolean {
  const w = s.work;
  const { keep, remove } = p;
  const ring = w.edgeTris(keep, remove);
  if (ring.length === 0) return false;
  const opposite = new Set(ring.map((t) => w.rotated(t, keep, remove)[2]));
  const na = w.neighbours(keep);
  const nb = new Set(w.neighbours(remove));
  for (const x of na) if (nb.has(x) && !opposite.has(x)) return false;
  for (const c of opposite) {
    if (w.valence(c) <= 3 && ring.length === 2) return false;
  }
  if (na.length + nb.size - 2 - opposite.size < 3) return false;
  for (const x of nb) {
    if (x === keep) continue;
    const q = w.p(x);
    const d = Math.sqrt(sq(q[0] - position[0]) + sq(q[1] - position[1]) + sq(q[2] - position[2]));
    if (d > maxLength) return false;
  }
  const tiny = sq(s.scale * 1e-7);
  for (const v of [keep, remove]) {
    for (const t of w.vt[v] as number[]) {
      const c = w.corners(t);
      if (c.includes(keep) && c.includes(remove)) continue;
      const before = w.normal(t);
      const after = w.normal(t, v, position);
      const lb = norm(before);
      const la = norm(after);
      if (la * la <= tiny) return false;
      if (lb > 0 && dot(before, after) < minDot * la * lb) return false;
    }
  }
  return true;
}

// ---- quadrics ------------------------------------------------------------------------------

/** Generalized quadric over [position; attributes]: v^T A v + 2 b^T v + c, plus its face area. */
class Quadric {
  readonly a: Float64Array;
  readonly b: Float64Array;
  c = 0;
  area = 0;
  readonly n: number;

  constructor(n: number) {
    this.n = n;
    this.a = new Float64Array(n * n);
    this.b = new Float64Array(n);
  }

  add(q: Quadric, weight = 1): void {
    for (let i = 0; i < this.a.length; i++)
      this.a[i] = (this.a[i] as number) + (q.a[i] as number) * weight;
    for (let i = 0; i < this.n; i++)
      this.b[i] = (this.b[i] as number) + (q.b[i] as number) * weight;
    this.c += q.c * weight;
    this.area += q.area * weight;
  }

  /** Scale the error terms, not the area, so the RMS error of collapses through it grows. */
  scale(weight: number): void {
    for (let i = 0; i < this.a.length; i++) this.a[i] = (this.a[i] as number) * weight;
    for (let i = 0; i < this.n; i++) this.b[i] = (this.b[i] as number) * weight;
    this.c *= weight;
  }

  sum(q: Quadric): Quadric {
    const out = new Quadric(this.n);
    out.add(this);
    out.add(q);
    return out;
  }

  evaluate(v: ArrayLike<number>): number {
    let e = this.c;
    for (let i = 0; i < this.n; i++) {
      let row = 0;
      for (let j = 0; j < this.n; j++) row += (this.a[i * this.n + j] as number) * (v[j] as number);
      e += (v[i] as number) * row + 2 * (this.b[i] as number) * (v[i] as number);
    }
    return e;
  }

  /**
   * Quadric of the triangle q0 q1 q2 in R^n (positions with
   * appended attributes): squared distance to its affine plane, weighted by area.
   */
  static triangle(
    n: number,
    q0: number[],
    q1: number[],
    q2: number[],
    area: number,
  ): Quadric | undefined {
    const e1 = q1.map((x, i) => x - (q0[i] as number));
    const l1 = Math.sqrt(e1.reduce((s, x) => s + x * x, 0));
    if (!(l1 > 0)) return undefined;
    for (let i = 0; i < n; i++) e1[i] = (e1[i] as number) / l1;
    const d2 = q2.map((x, i) => x - (q0[i] as number));
    const proj = d2.reduce((s, x, i) => s + x * (e1[i] as number), 0);
    const e2 = d2.map((x, i) => x - proj * (e1[i] as number));
    const l2 = Math.sqrt(e2.reduce((s, x) => s + x * x, 0));
    if (!(l2 > 0)) return undefined;
    for (let i = 0; i < n; i++) e2[i] = (e2[i] as number) / l2;
    const q = new Quadric(n);
    const p1 = q0.reduce((s, x, i) => s + x * (e1[i] as number), 0);
    const p2 = q0.reduce((s, x, i) => s + x * (e2[i] as number), 0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        q.a[i * n + j] =
          area *
          ((i === j ? 1 : 0) -
            (e1[i] as number) * (e1[j] as number) -
            (e2[i] as number) * (e2[j] as number));
      }
      q.b[i] = area * (p1 * (e1[i] as number) + p2 * (e2[i] as number) - (q0[i] as number));
    }
    q.c = area * (q0.reduce((s, x) => s + x * x, 0) - p1 * p1 - p2 * p2);
    q.area = area;
    return q;
  }

  /** Plane quadric n . x = n . p (unit n) embedded in the position block, weighted. */
  static plane(n: number, normal: Tuple3, p: Tuple3, weight: number): Quadric {
    const q = new Quadric(n);
    const d = -dot(normal, p);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++)
        q.a[i * n + j] = weight * (normal[i] as number) * (normal[j] as number);
      q.b[i] = weight * d * (normal[i] as number);
    }
    q.c = weight * d * d;
    return q;
  }
}

interface HeapEntry {
  readonly error: number;
  readonly key: number;
  readonly stamp: number;
}

/** Binary min-heap by error, then edge key. */
class Heap {
  private readonly items: HeapEntry[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(x: HeapEntry, y: HeapEntry): boolean {
    return x.error < y.error || (x.error === y.error && x.key < y.key);
  }
  push(entry: HeapEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i] as HeapEntry, items[parent] as HeapEntry)) break;
      [items[i], items[parent]] = [items[parent] as HeapEntry, items[i] as HeapEntry];
      i = parent;
    }
  }
  pop(): HeapEntry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l] as HeapEntry, items[m] as HeapEntry)) m = l;
        if (r < items.length && this.less(items[r] as HeapEntry, items[m] as HeapEntry)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m] as HeapEntry, items[i] as HeapEntry];
        i = m;
      }
    }
    return top;
  }
}

/** Area-weighted unit vertex normals of the working mesh. */
/** Vertices with front- and back-facing triangles around them seen from any eye, ascending. */
function contourVertices(w: Work, eyes: readonly Tuple3[]): number[] {
  const out: number[] = [];
  for (let v = 0; v < w.alive.length; v++) {
    const star = w.vt[v] as number[] | undefined;
    if (star === undefined || star.length === 0) continue;
    const p = w.p(v);
    for (const eye of eyes) {
      let front = false;
      let back = false;
      for (const t of star) {
        const s = dot(w.normal(t), [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]);
        if (s < 0) front = true;
        else if (s > 0) back = true;
      }
      if (front && back) {
        out.push(v);
        break;
      }
    }
  }
  return out;
}

function vertexNormals(w: Work): Tuple3[] {
  const normals: Tuple3[] = w.alive.map(() => [0, 0, 0]);
  for (let t = 0; t < w.src.length; t++) {
    if ((w.tri[t * 3] as number) < 0) continue;
    const n = w.normal(t);
    for (const v of w.corners(t)) {
      const m = normals[v] as Tuple3;
      m[0] += n[0];
      m[1] += n[1];
      m[2] += n[2];
    }
  }
  return normals.map((n) => {
    const l = norm(n);
    return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : n;
  });
}

interface SimplifyStats {
  readonly collapses: number;
  readonly blocked: number;
  /** Collapses refused by the clearance guard (counted in blocked too). */
  readonly clearanceBlocked: number;
  readonly lastError: number;
  /** The loop ended at a candidate above maxError (set once, only when it stopped the loop). */
  readonly stoppedByMaxError: boolean;
}

/**
 * The clearance guard over the processed triangles (kept current) and the faces passing
 * through unchanged, in cells of twice the mean edge length (at least the clearance).
 */
function clearanceGrid(s: Setup, clearance: number, meanEdge: number): ClearanceGrid {
  const w = s.work;
  const fixed: (readonly [number, number, number])[] = [];
  const triangles = jobTriangles(s.mesh);
  for (const f of s.mesh.faces()) {
    if ((s.selected[f] as number) === 1) continue;
    const halves = s.mesh.faceHalves(f);
    const tris =
      triangles[f] ??
      halves.slice(1, -1).map((h, i) => [halves[0] as number, h, halves[i + 2] as number]);
    for (const tri of tris)
      fixed.push(tri.map((h) => s.mesh.hVert[h] as number) as [number, number, number]);
  }
  // Work triangles keep their ids (a split appends); the faces passing through are -1, -2, ...
  const grid = new ClearanceGrid(
    (v) => w.p(v),
    (id) => {
      if (id < 0) return fixed[-id - 1];
      const c = w.corners(id);
      return c[0] < 0 ? undefined : c;
    },
    Math.max(2 * meanEdge, clearance),
    clearance,
  );
  for (let id = 0; id < w.src.length; id++) grid.insert(id);
  for (let k = 0; k < fixed.length; k++) grid.insert(-k - 1);
  return grid;
}

function simplify(
  s: Setup,
  params: RemeshJobParams,
  work: WorkMeter,
): Result<SimplifyStats, ModelingError> {
  const w = s.work;
  const kind: QuadricKind = params.quadric ?? 'volume';
  const n = kind === 'attribute' ? 6 : 3;
  const normals = vertexNormals(w);
  let edgeSum = 0;
  let edgeCount = 0;
  for (let t = 0; t < w.src.length; t++) {
    const [a, b, c] = w.corners(t);
    edgeSum += w.length(a, b) + w.length(b, c) + w.length(c, a);
    edgeCount += 3;
  }
  // A unit normal deviation costs about one mean edge length of position error.
  const attributeScale = edgeCount > 0 ? edgeSum / edgeCount : 1;
  const attr: Tuple3[] = normals.map((m) => [
    m[0] * attributeScale,
    m[1] * attributeScale,
    m[2] * attributeScale,
  ]);
  const vector = (v: number): number[] => (n === 3 ? w.p(v) : [...w.p(v), ...(attr[v] as Tuple3)]);
  const quadrics: Quadric[] = w.alive.map(() => new Quadric(n));
  for (let t = 0; t < w.src.length; t++) {
    const [a, b, c] = w.corners(t);
    const area = norm(w.normal(t)) / 2;
    const q = Quadric.triangle(n, vector(a), vector(b), vector(c), area);
    if (q === undefined) continue;
    for (const v of [a, b, c]) (quadrics[v] as Quadric).add(q);
  }
  // Feature edges keep their curve: planes through the edge, perpendicular to each side.
  for (const [key, bits] of w.flags) {
    if ((bits & s.featureMask) === 0) continue;
    const [a, b] = edgeEnds(key);
    const pa = w.p(a);
    const pb = w.p(b);
    const e: Tuple3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const len2 = dot(e, e);
    for (const t of w.edgeTris(a, b)) {
      const fn = w.normal(t);
      const c: Tuple3 = [
        e[1] * fn[2] - e[2] * fn[1],
        e[2] * fn[0] - e[0] * fn[2],
        e[0] * fn[1] - e[1] * fn[0],
      ];
      const l = norm(c);
      if (!(l > 0)) continue;
      const q = Quadric.plane(n, [c[0] / l, c[1] / l, c[2] / l], pa, 10 * len2);
      (quadrics[a] as Quadric).add(q);
      (quadrics[b] as Quadric).add(q);
    }
  }
  // Silhouette: contour-generator vertices of the views weigh their position error more.
  const silhouette = params.silhouette;
  if (silhouette !== undefined && silhouette.weight > 0) {
    for (const v of contourVertices(w, silhouette.eyes)) {
      (quadrics[v] as Quadric).scale(1 + silhouette.weight);
    }
  }
  const target = params.targetFaces ?? 0;
  const maxError = params.maxError ?? Infinity;

  const optimal = (p: CollapsePlan): { x: number[]; error: number } | undefined => {
    const q = (quadrics[p.keep] as Quadric).sum(quadrics[p.remove] as Quadric);
    const ka = vector(p.keep);
    const kb = vector(p.remove);
    let x: number[];
    if (p.kind === 'keep') {
      x = ka;
    } else if (p.kind === 'curve') {
      const d = kb.map((v, i) => v - (ka[i] as number));
      let dad = 0;
      let dg = 0;
      for (let i = 0; i < n; i++) {
        let row = 0;
        let rowA = 0;
        for (let j = 0; j < n; j++) {
          row += (q.a[i * n + j] as number) * (d[j] as number);
          rowA += (q.a[i * n + j] as number) * (ka[j] as number);
        }
        dad += (d[i] as number) * row;
        dg += (d[i] as number) * (rowA + (q.b[i] as number));
      }
      let t = dad > 0 ? -dg / dad : 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      x = ka.map((v, i) => v + t * (d[i] as number));
    } else {
      const m = ka.map((v, i) => (v + (kb[i] as number)) / 2);
      const rhs = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        let row = 0;
        for (let j = 0; j < n; j++) row += (q.a[i * n + j] as number) * (m[j] as number);
        rhs[i] = -(row + (q.b[i] as number));
      }
      if (kind === 'volume') {
        // Lindstrom-Turk: the tetrahedra swept by the moved vertex sum to zero volume.
        // Volumes about the edge midpoint: world-origin tetrahedra cancel far from the origin.
        const local = (v: number): Tuple3 => {
          const q0 = w.p(v);
          return [q0[0] - (m[0] as number), q0[1] - (m[1] as number), q0[2] - (m[2] as number)];
        };
        const g: Tuple3 = [0, 0, 0];
        let h = 0;
        const star = new Set([...(w.vt[p.keep] as number[]), ...(w.vt[p.remove] as number[])]);
        for (const t of [...star].sort((x, y) => x - y)) {
          const c = w.corners(t);
          if (c.includes(p.keep) && c.includes(p.remove)) {
            // A vanishing triangle loses its whole volume.
            const [q0, q1, q2] = c.map(local) as [Tuple3, Tuple3, Tuple3];
            h += dot(q0, [
              q1[1] * q2[2] - q1[2] * q2[1],
              q1[2] * q2[0] - q1[0] * q2[2],
              q1[0] * q2[1] - q1[1] * q2[0],
            ]);
            continue;
          }
          const i =
            c[0] === p.keep || c[0] === p.remove ? 0 : c[1] === p.keep || c[1] === p.remove ? 1 : 2;
          const pv = local(c[i] as number);
          const pb = local(c[(i + 1) % 3] as number);
          const pc = local(c[(i + 2) % 3] as number);
          const nb: Tuple3 = [
            pb[1] * pc[2] - pb[2] * pc[1],
            pb[2] * pc[0] - pb[0] * pc[2],
            pb[0] * pc[1] - pb[1] * pc[0],
          ];
          g[0] += nb[0];
          g[1] += nb[1];
          g[2] += nb[2];
          h += dot(nb, pv);
        }
        const kkt = new Array(16).fill(0);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) kkt[i * 4 + j] = q.a[i * n + j] as number;
          kkt[i * 4 + 3] = g[i];
          kkt[12 + i] = g[i];
        }
        const solved = solveSymmetric(4, kkt, [rhs[0], rhs[1], rhs[2], h], 1e-12);
        if (solved.rank === 4 && norm(g) > 0) {
          x = [0, 1, 2].map((i) => (m[i] as number) + (solved.x[i] as number));
        } else {
          const plain = solveSymmetric(n, q.a, rhs, 1e-9);
          x = m.map((v, i) => v + (plain.x[i] as number));
        }
      } else {
        const plain = solveSymmetric(n, q.a, rhs, 1e-9);
        x = m.map((v, i) => v + (plain.x[i] as number));
      }
    }
    const value = Math.max(0, q.evaluate(x));
    return { x, error: Math.sqrt(value / Math.max(q.area, 1e-300)) };
  };

  const stamps = new Map<number, number>();
  const heap = new Heap();
  let stamp = 0;
  const schedule = (a: number, b: number) => {
    const key = edgeKey(a, b);
    const p = plan(s, a, b);
    if (p === undefined) {
      stamps.delete(key);
      return;
    }
    const best = optimal(p);
    if (best === undefined) return;
    stamp++;
    stamps.set(key, stamp);
    heap.push({ error: best.error, key, stamp });
  };
  for (const key of w.edgesAround(w.alive.map((_, v) => v))) {
    const [a, b] = edgeEnds(key);
    schedule(a, b);
  }
  if (!work.spend(w.src.length * 4)) return err(work.failure as ModelingError);
  const grid =
    params.clearance === undefined ? undefined : clearanceGrid(s, params.clearance, attributeScale);
  let collapses = 0;
  let blocked = 0;
  let clearanceBlocked = 0;
  let lastError = 0;
  let stoppedByMaxError = false;
  while (heap.size > 0 && w.triangles > target) {
    const entry = heap.pop() as HeapEntry;
    if (stamps.get(entry.key) !== entry.stamp) continue;
    if (entry.error > maxError) {
      stoppedByMaxError = true;
      break;
    }
    if (!work.spend(16)) return err(work.failure as ModelingError);
    const [a, b] = edgeEnds(entry.key);
    stamps.delete(entry.key);
    if (!w.alive[a] || !w.alive[b] || w.edgeTris(a, b).length === 0) continue;
    const p = plan(s, a, b);
    if (p === undefined) continue;
    const best = optimal(p);
    if (best === undefined) continue;
    // Costs of edges near earlier collapses go stale (volume stars change): re-queue.
    if (best.error > entry.error * (1 + 1e-9)) {
      schedule(a, b);
      continue;
    }
    const position: Tuple3 = [best.x[0] as number, best.x[1] as number, best.x[2] as number];
    if (!collapseAllowed(s, p, position, Infinity, MIN_NORMAL_DOT)) {
      blocked++;
      continue;
    }
    const star = [...new Set([...(w.vt[p.keep] as number[]), ...(w.vt[p.remove] as number[])])];
    // Quality limits: no new triangle above maxAspect unless the star was already worse, no
    // vertex above maxValence neighbours.
    if (params.maxAspect !== undefined) {
      const tri = (c: readonly number[]) =>
        c.map((v) => (v === p.remove || v === p.keep ? position : w.p(v))) as [
          Tuple3,
          Tuple3,
          Tuple3,
        ];
      const old = Math.max(
        ...star.map((t) =>
          aspectOf(...(w.corners(t).map((v) => w.p(v)) as [Tuple3, Tuple3, Tuple3])),
        ),
      );
      const next = Math.max(
        ...star
          .map((t) => w.corners(t))
          .filter((c) => !(c.includes(p.keep) && c.includes(p.remove)))
          .map((c) => aspectOf(...tri(c))),
      );
      if (next > params.maxAspect && next > old) {
        blocked++;
        continue;
      }
    }
    if (params.maxValence !== undefined) {
      const around = new Set([...w.neighbours(p.keep), ...w.neighbours(p.remove)]);
      around.delete(p.keep);
      around.delete(p.remove);
      if (around.size > params.maxValence) {
        blocked++;
        continue;
      }
    }
    if (grid !== undefined) {
      const after = star
        .map((t) => w.corners(t))
        .filter((c) => !(c.includes(p.keep) && c.includes(p.remove)))
        .map((c) => {
          const corners = c.map((v) => (v === p.remove ? p.keep : v));
          return { corners, points: corners.map((v) => (v === p.keep ? position : w.p(v))) };
        });
      if (!work.spend(after.length * 32)) return err(work.failure as ModelingError);
      if (!grid.allows(star, after)) {
        blocked++;
        clearanceBlocked++;
        continue;
      }
    }
    const merged = (quadrics[p.keep] as Quadric).sum(quadrics[p.remove] as Quadric);
    for (const t of star) grid?.remove(t);
    w.collapse(p.keep, p.remove, position);
    for (const t of w.vt[p.keep] as number[]) grid?.insert(t);
    quadrics[p.keep] = merged;
    if (n === 6) {
      const m: Tuple3 = [best.x[3] as number, best.x[4] as number, best.x[5] as number];
      const l = norm(m);
      attr[p.keep] =
        l > 0
          ? [(m[0] / l) * attributeScale, (m[1] / l) * attributeScale, (m[2] / l) * attributeScale]
          : m;
    }
    collapses++;
    lastError = entry.error;
    for (const key of w.edgesAround([p.keep])) {
      const [x, y] = edgeEnds(key);
      schedule(x, y);
    }
  }
  return ok({ collapses, blocked, clearanceBlocked, lastError, stoppedByMaxError });
}

// ---- isotropic remeshing -----------------------------------------------------------------------

/**
 * Projection onto the input: `projectAs(bits, p)` onto the feature curves with `bits` (else
 * the surface), `project(v, p)` as vertex v's class, `offSurface(p)` the distance to it.
 */
function surfaceTools(s: Setup, work: WorkMeter) {
  const w = s.work;
  const surface = new PrimitiveGrid(Float64Array.from(w.pos), s.sourceCorners);
  const curves = new PrimitiveGrid(Float64Array.from(w.pos), s.segments.corners);
  const visit = (k: number) => {
    work.spend(k);
  };
  const projectAs = (bits: number, p: Tuple3): Tuple3 => {
    if (bits !== 0) {
      const hit = curves.closest(p, (t) => ((s.segments.bits[t] as number) & bits) !== 0, visit);
      if (hit !== undefined) return hit.point;
    }
    const hit = surface.closest(p, undefined, visit);
    return hit === undefined ? p : hit.point;
  };
  const project = (v: number, p: Tuple3): Tuple3 =>
    projectAs((w.vclass[v] as number) === 1 ? (w.vfeat[v] as number) : 0, p);
  const offSurface = (p: Tuple3): number => {
    const hit = surface.closest(p, undefined, visit);
    return hit === undefined ? 0 : Math.sqrt(hit.distance2);
  };
  /** A per-input-vertex value interpolated at the closest input point to p. */
  const interpolate = (values: readonly number[], p: Tuple3, fallback: number): number => {
    const hit = surface.closest(p, undefined, visit);
    if (hit === undefined) return fallback;
    const c = s.sourceCorners;
    return (
      hit.weights[0] * (values[c[hit.index * 3] as number] ?? fallback) +
      hit.weights[1] * (values[c[hit.index * 3 + 1] as number] ?? fallback) +
      hit.weights[2] * (values[c[hit.index * 3 + 2] as number] ?? fallback)
    );
  };
  /**
   * A per-input-vertex line field (3 per vertex) at the closest input point to p: corner
   * directions sign-matched to the first (lines agree mod pi) and blended barycentrically.
   */
  const directionAt = (field: Float64Array, p: Tuple3): Tuple3 | undefined => {
    const hit = surface.closest(p, undefined, visit);
    if (hit === undefined) return undefined;
    const c = s.sourceCorners;
    const out: Tuple3 = [0, 0, 0];
    let first: Tuple3 | undefined;
    for (let k = 0; k < 3; k++) {
      const v = c[hit.index * 3 + k] as number;
      const d: Tuple3 = [
        field[v * 3] as number,
        field[v * 3 + 1] as number,
        field[v * 3 + 2] as number,
      ];
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
      const sign = first === undefined || dot(first, d) >= 0 ? 1 : -1;
      first ??= d;
      const wk = hit.weights[k] as number;
      out[0] += sign * wk * d[0];
      out[1] += sign * wk * d[1];
      out[2] += sign * wk * d[2];
    }
    const l = norm(out);
    return l > 0 ? [out[0] / l, out[1] / l, out[2] / l] : undefined;
  };
  return { project, projectAs, offSurface, interpolate, directionAt };
}

/**
 * The line field on the input faces: each guide's flow over its faces (or the
 * principal curvature directions), the preserved feature curves and `constrain` pairs as
 * hard constraints, smoothed by local averaging. Built before any edit, from the input.
 */
function directionField(s: Setup, direction: RemeshDirection): LineField {
  const guides =
    direction.guides === 'principal'
      ? undefined
      : direction.guides.map((g) => ({
          faces: g.faces === undefined ? undefined : new Set(g.faces),
          flow: g.flow,
        }));
  const constraints: [number, number][] = [];
  const seg = s.segments.corners;
  for (let i = 0; i + 2 < seg.length; i += 3)
    constraints.push([seg[i] as number, seg[i + 1] as number]);
  const extra = direction.constrain ?? [];
  for (let i = 0; i + 1 < extra.length; i += 2)
    constraints.push([extra[i] as number, extra[i + 1] as number]);
  return lineField({
    positions: Float64Array.from(s.work.pos),
    triangles: s.sourceCorners,
    principal: guides === undefined,
    constraints,
    ...(guides === undefined
      ? {}
      : {
          data: (t: number, centroid: Tuple3, normal: Tuple3) => {
            const f = s.sourceFace[t] as number;
            const g = guides.find((x) => x.faces === undefined || x.faces.has(f));
            return g === undefined ? undefined : flowAt(g.flow, centroid, normal);
          },
        }),
  });
}

/**
 * @internal The direction's metric on the work mesh, shared by the isotropic remesh and the
 * tiling cleanup. The field is built from the untouched input; with anisotropy above 1,
 * lengths are measured in the metric it defines (determinant 1: an edge along the field of
 * length L sqrt(a) and one across of L / sqrt(a) both measure L). Per input vertex the
 * anisotropy is that of the guides over its faces (a guide's own value, else the
 * direction's), averaged; new vertices interpolate it. Anisotropy 1 is the Euclidean length.
 */
interface DirectionMetric {
  readonly field: LineField | undefined;
  /** Lengths follow the field (a direction with some anisotropy above 1). */
  readonly active: boolean;
  /** The largest anisotropy (a metric edge is at most sqrt(largest) times its Euclidean length). */
  readonly largest: number;
  length(a: number, b: number): number;
  /** Re-reads vertex v's direction and anisotropy at `at` (default its position). */
  track(v: number, at?: Tuple3): void;
  /** Flipping ab to cd shortens the diagonal in the metric (by 5 %, so flips do not cycle). */
  flips(a: number, b: number, c: number, d: number): boolean;
}

function directionMetric(
  s: Setup,
  options: RemeshDirection | undefined,
  interpolate: (values: readonly number[], p: Tuple3, fallback: number) => number,
  directionAt: (field: Float64Array, p: Tuple3) => Tuple3 | undefined,
): DirectionMetric {
  const w = s.work;
  const field = options === undefined ? undefined : directionField(s, options);
  const anisotropy = options?.anisotropy ?? 1;
  const guideAnisotropy =
    options === undefined || options.guides === 'principal'
      ? undefined
      : options.guides.map((g) => ({
          faces: g.faces === undefined ? undefined : new Set(g.faces),
          anisotropy: g.anisotropy ?? anisotropy,
        }));
  const vertexAnisotropy: number[] = [];
  if (guideAnisotropy?.some((g) => g.anisotropy !== anisotropy)) {
    const sum: number[] = [];
    const count: number[] = [];
    const c = s.sourceCorners;
    for (let t = 0; t * 3 < c.length; t++) {
      const f = s.sourceFace[t] as number;
      const g = guideAnisotropy.find((x) => x.faces === undefined || x.faces.has(f));
      const value = g?.anisotropy ?? anisotropy;
      for (let k = 0; k < 3; k++) {
        const v = c[t * 3 + k] as number;
        sum[v] = (sum[v] ?? 0) + value;
        count[v] = (count[v] ?? 0) + 1;
      }
    }
    for (let v = 0; v < sum.length; v++) {
      if (count[v] !== undefined) vertexAnisotropy[v] = (sum[v] as number) / (count[v] as number);
    }
  }
  const inputAnisotropy = [...vertexAnisotropy];
  const anisotropyOf = (v: number) => vertexAnisotropy[v] ?? anisotropy;
  const active = field !== undefined && (anisotropy > 1 || vertexAnisotropy.some((a) => a > 1));
  const largest = Math.max(anisotropy, ...vertexAnisotropy.filter((a) => a !== undefined));
  // A field direction per work vertex: the input's at input vertices, looked up for new ones.
  const dir: (Tuple3 | undefined)[] = [];
  if (active) {
    const f = field.field;
    for (let v = 0; v < w.alive.length; v++) {
      const d: Tuple3 = [f[v * 3] ?? 0, f[v * 3 + 1] ?? 0, f[v * 3 + 2] ?? 0];
      dir[v] = d[0] === 0 && d[1] === 0 && d[2] === 0 ? undefined : d;
    }
  }
  const track = (v: number, at: Tuple3 = w.p(v)) => {
    if (!active) return;
    dir[v] = directionAt(field.field, at);
    if (inputAnisotropy.length > 0)
      vertexAnisotropy[v] = interpolate(inputAnisotropy, at, anisotropy);
  };
  const length = (a: number, b: number): number => {
    if (!active) return w.length(a, b);
    const p = w.p(a);
    const q = w.p(b);
    const d: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const da = dir[a];
    const db = dir[b];
    const u: Tuple3 | undefined =
      da === undefined
        ? db
        : db === undefined
          ? da
          : dot(da, db) >= 0
            ? [da[0] + db[0], da[1] + db[1], da[2] + db[2]]
            : [da[0] - db[0], da[1] - db[1], da[2] - db[2]];
    const l2 = sq(d[0]) + sq(d[1]) + sq(d[2]);
    const ul = u === undefined ? 0 : norm(u);
    if (u === undefined || ul === 0) return Math.sqrt(l2);
    const along = dot(d, u) / ul;
    const across2 = Math.max(0, l2 - along * along);
    const k = (anisotropyOf(a) + anisotropyOf(b)) / 2;
    return Math.sqrt((along * along) / k + across2 * k);
  };
  const flips = (a: number, b: number, c: number, d: number) => length(c, d) < 0.95 * length(a, b);
  return { field, active, largest, length, track, flips };
}

interface IsotropicStats {
  readonly splits: number;
  readonly collapses: number;
  readonly flips: number;
  /** Moves refused by the clearance guard (counted in normalFlipsPrevented too). */
  readonly clearanceBlocked: number;
  readonly iterations: number;
  readonly normalFlipsPrevented: number;
  /** With a direction: the field's constrained vertices and roughness (mean degrees across edges). */
  readonly field?: { readonly constrained: number; readonly roughness: number };
}

/** How fast the size field may grow per meter (neighbouring sizes then differ by about 2 at most). */
const SIZE_GRADATION = 1;

/**
 * Target lengths at the input vertices from curvature: a vertex
 * whose normal turns by k radians per meter toward a neighbour (largest over its neighbours)
 * has radius r = 1/k, and the edge whose chord leaves the surface by `error` is
 * sqrt(6 e r - 3 e^2), clamped to [minEdge, target]. Graded (Dijkstra) so that it grows by at
 * most `SIZE_GRADATION` per meter away from any vertex; tight bends (shell rims, tips) get
 * short edges and their neighbourhood a smooth transition.
 */
function adaptiveSizes(
  w: Work,
  target: number,
  adaptive: { readonly error: number; readonly minEdge: number },
): number[] {
  const normals = vertexNormals(w);
  const size = w.alive.map((alive, v) => {
    if (!alive || (w.vt[v] as number[]).length === 0) return target;
    const n = normals[v] as Tuple3;
    const p = w.p(v);
    let k = 0;
    for (const x of w.neighbours(v)) {
      const m = normals[x] as Tuple3;
      const q = w.p(x);
      const d = Math.sqrt(sq(p[0] - q[0]) + sq(p[1] - q[1]) + sq(p[2] - q[2]));
      if (d > 0)
        k = Math.max(k, Math.sqrt(sq(n[0] - m[0]) + sq(n[1] - m[1]) + sq(n[2] - m[2])) / d);
    }
    if (k === 0) return target;
    const e = adaptive.error;
    const h2 = (6 * e) / k - 3 * e * e;
    const h = h2 > 0 ? Math.sqrt(h2) : adaptive.minEdge;
    return Math.min(target, Math.max(adaptive.minEdge, h));
  });
  const heap = new Heap();
  size.forEach((h, v) => {
    heap.push({ error: h, key: v, stamp: 0 });
  });
  const done = new Uint8Array(size.length);
  for (let entry = heap.pop(); entry !== undefined; entry = heap.pop()) {
    const v = entry.key;
    if (done[v] === 1 || entry.error > (size[v] as number)) continue;
    done[v] = 1;
    for (const x of w.neighbours(v)) {
      const graded = (size[v] as number) + SIZE_GRADATION * w.length(v, x);
      if (graded < (size[x] as number)) {
        size[x] = graded;
        heap.push({ error: graded, key: x, stamp: 0 });
      }
    }
  }
  return size;
}

function isotropic(
  s: Setup,
  params: RemeshJobParams,
  work: WorkMeter,
): Result<IsotropicStats, ModelingError> {
  const w = s.work;
  const target = params.targetEdgeLength as number;
  const speed = params.smoothing ?? 0.1;
  const iterations = params.iterations ?? 1;
  const { project, projectAs, offSurface, interpolate, directionAt } = surfaceTools(s, work);
  const metric = directionMetric(s, params.direction, interpolate, directionAt);
  const { length, track, largest } = metric;
  // Target length per vertex (adaptive: a graded curvature field on the input surface, taken
  // at each vertex's position), else uniform; an edge takes the smaller of its ends.
  // A field that cannot go below the target is the uniform remesh, exactly.
  const field =
    params.adaptive === undefined || params.adaptive.minEdge >= target
      ? undefined
      : adaptiveSizes(w, target, params.adaptive);
  const size: number[] = field === undefined ? [] : [...field];
  const sizeAt = (p: Tuple3) => (field === undefined ? target : interpolate(field, p, target));
  const sizeOf = (v: number) => size[v] ?? target;
  const edgeTarget = (a: number, b: number) => Math.min(sizeOf(a), sizeOf(b));
  const hi = (a: number, b: number) => (4 / 3) * edgeTarget(a, b);
  const lo = (a: number, b: number) => (4 / 5) * edgeTarget(a, b);
  // A collapse keeps every new triangle's centroid within L/16 of the input surface, so
  // curvature tighter than the target length keeps finer triangles instead of cutting chords.
  const grid =
    params.clearance === undefined ? undefined : clearanceGrid(s, params.clearance, target);
  let clearanceBlocked = 0;
  // The clearance guard: `before` triangles replaced by `after` (corners, a new vertex as -1).
  const clear = (
    before: readonly number[],
    after: readonly (readonly number[])[],
    at: (v: number) => Tuple3,
  ): boolean => {
    if (grid === undefined) return true;
    if (
      grid.allows(
        before,
        after.map((corners) => ({ corners, points: corners.map(at) })),
      )
    )
      return true;
    clearanceBlocked++;
    return false;
  };
  const refresh = (before: readonly number[], after: Iterable<number>) => {
    if (grid === undefined) return;
    for (const t of before) grid.remove(t);
    for (const t of after) grid.insert(t);
  };
  const faithful = (p: CollapsePlan, position: Tuple3): boolean => {
    const deviation = edgeTarget(p.keep, p.remove) / 16;
    for (const v of [p.keep, p.remove]) {
      for (const t of w.vt[v] as number[]) {
        const c = w.corners(t);
        if (c.includes(p.keep) && c.includes(p.remove)) continue;
        const q: Tuple3 = [0, 0, 0];
        for (const x of c) {
          const r = x === p.keep || x === p.remove ? position : w.p(x);
          q[0] += r[0] / 3;
          q[1] += r[1] / 3;
          q[2] += r[2] / 3;
        }
        if (offSurface(q) > deviation) return false;
      }
    }
    return true;
  };
  const midpoint = (a: number, b: number): Tuple3 => {
    const p = w.p(a);
    const q = w.p(b);
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  };
  const edgeOf = edgeEnds;
  let splits = 0;
  let collapses = 0;
  let flips = 0;
  let prevented = 0;
  let dirty = new Set<number>(w.alive.map((_, v) => v));
  let ran = 0;
  for (let iteration = 0; iteration < iterations && dirty.size > 0; iteration++) {
    ran++;
    const touched = new Set<number>();
    const mark = (vs: Iterable<number>) => {
      for (const v of vs) touched.add(v);
    };
    // Split long edges, longest first.
    const long = w
      .edgesAround(dirty)
      .map((key) => ({ key, length: length(...edgeOf(key)) }))
      .filter((e) => e.length > hi(...edgeOf(e.key)))
      .sort((x, y) => y.length - x.length || x.key - y.key);
    for (const { key } of long) {
      const [a, b] = edgeOf(key);
      if (!w.alive[a] || !w.alive[b] || w.edgeTris(a, b).length === 0) continue;
      if (length(a, b) <= hi(a, b) || (w.flag(a, b) & s.pinMask) !== 0) continue;
      const bits = w.flag(a, b) & s.featureMask;
      const around = w.edgeTris(a, b);
      if (grid !== undefined) {
        const at = projectAs(bits, midpoint(a, b));
        const after = around.flatMap((t) => {
          const [p, q, c] = w.rotated(t, a, b);
          return [
            [p, -1, c],
            [-1, q, c],
          ];
        });
        if (!clear(around, after, (v) => (v === -1 ? at : w.p(v)))) {
          prevented++;
          continue;
        }
      }
      const m = w.split(a, b, midpoint(a, b));
      if (bits !== 0) {
        w.vclass[m] = 1;
        w.vfeat[m] = bits;
      }
      w.set(m, project(m, w.p(m)));
      if (field !== undefined) size[m] = sizeAt(w.p(m));
      track(m);
      refresh(around, w.vt[m] as number[]);
      splits++;
      mark([a, b, m, ...w.neighbours(m)]);
    }
    if (!work.spend(long.length * 8 + 1)) return err(work.failure as ModelingError);
    // Collapse short edges, shortest first.
    const active = new Set([...dirty, ...touched]);
    const short = w
      .edgesAround(active)
      .map((key) => ({ key, length: length(...edgeOf(key)) }))
      .filter((e) => e.length < lo(...edgeOf(e.key)))
      .sort((x, y) => x.length - y.length || x.key - y.key);
    for (const { key } of short) {
      const [a, b] = edgeOf(key);
      if (!w.alive[a] || !w.alive[b] || w.edgeTris(a, b).length === 0) continue;
      if (length(a, b) >= lo(a, b)) continue;
      const p = plan(s, a, b);
      if (p === undefined) continue;
      let position = p.kind === 'keep' ? w.p(p.keep) : midpoint(a, b);
      if (p.kind !== 'keep') position = project(p.keep, position);
      if (
        // Euclidean guard on new edges: an edge along the field may be sqrt(a) longer.
        !collapseAllowed(s, p, position, 0.9 * hi(a, b) * Math.sqrt(largest), REMESH_NORMAL_DOT) ||
        !faithful(p, position)
      ) {
        prevented++;
        continue;
      }
      const star = [...new Set([...(w.vt[p.keep] as number[]), ...(w.vt[p.remove] as number[])])];
      const kept = star
        .map((t) => w.corners(t))
        .filter((c) => !(c.includes(p.keep) && c.includes(p.remove)))
        .map((c) => c.map((v) => (v === p.remove ? p.keep : v)));
      if (!clear(star, kept, (v) => (v === p.keep ? position : w.p(v)))) {
        prevented++;
        continue;
      }
      const around = w.neighbours(p.remove);
      if (field !== undefined) size[p.keep] = sizeAt(position);
      track(p.keep, position);
      w.collapse(p.keep, p.remove, position);
      refresh(star, w.vt[p.keep] as number[]);
      collapses++;
      mark([p.keep, ...around]);
    }
    if (!work.spend(short.length * 16 + 1)) return err(work.failure as ModelingError);
    // Flip toward valence 6 (4 on boundaries) across non-feature edges.
    const flipActive = new Set([...dirty, ...touched]);
    const valence = (v: number) => w.valence(v);
    const ideal = (v: number) => (w.isBoundaryVertex(v) ? 4 : 6);
    for (const key of w.edgesAround(flipActive)) {
      const [a, b] = edgeOf(key);
      if (!w.alive[a] || !w.alive[b]) continue;
      if ((w.flag(a, b) & s.featureMask) !== 0) continue;
      const pair = orientedPair(w, a, b);
      if (pair === undefined) continue;
      const [t1, t2] = pair;
      const c = w.rotated(t1, a, b)[2];
      const d = w.rotated(t2, a, b)[2];
      if (c === d || w.edgeTris(c, d).length > 0) continue;
      const [va, vb, vc, vd] = [valence(a), valence(b), valence(c), valence(d)];
      const [ia, ib, ic, id] = [ideal(a), ideal(b), ideal(c), ideal(d)];
      const before = sq(va - ia) + sq(vb - ib) + sq(vc - ic) + sq(vd - id);
      const after = sq(va - 1 - ia) + sq(vb - 1 - ib) + sq(vc + 1 - ic) + sq(vd + 1 - id);
      // With a field, the metric decides (valence toward 6 would fight the alignment where
      // flow lines converge); without one, valence toward 6.
      const better = metric.active ? metric.flips(a, b, c, d) : after < before;
      if (!better || va <= 3 || vb <= 3) continue;
      const n1 = w.normal(t1);
      const n2 = w.normal(t2);
      const l1 = norm(n1);
      const l2 = norm(n2);
      if (!(l1 > 0 && l2 > 0) || dot(n1, n2) < FLIP_CREASE_DOT * l1 * l2) continue;
      const [pa, pb, pc, pd] = [w.p(a), w.p(b), w.p(c), w.p(d)];
      const cross = (x: Tuple3, y: Tuple3, z: Tuple3): Tuple3 => {
        const u: Tuple3 = [y[0] - x[0], y[1] - x[1], y[2] - x[2]];
        const v: Tuple3 = [z[0] - x[0], z[1] - x[1], z[2] - x[2]];
        return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      };
      const m1 = cross(pc, pa, pd);
      const m2 = cross(pd, pb, pc);
      const tiny = sq(s.scale * 1e-7);
      if (sq(norm(m1)) <= tiny || sq(norm(m2)) <= tiny) continue;
      const ok1 =
        dot(m1, n1) >= REMESH_NORMAL_DOT * norm(m1) * l1 &&
        dot(m1, n2) >= REMESH_NORMAL_DOT * norm(m1) * l2;
      const ok2 =
        dot(m2, n1) >= REMESH_NORMAL_DOT * norm(m2) * l1 &&
        dot(m2, n2) >= REMESH_NORMAL_DOT * norm(m2) * l2;
      if (
        !ok1 ||
        !ok2 ||
        !clear(
          [t1, t2],
          [
            [c, a, d],
            [d, b, c],
          ],
          (v) => w.p(v),
        )
      ) {
        prevented++;
        continue;
      }
      w.flip(a, b);
      refresh([t1, t2], [t1, t2]);
      flips++;
      mark([a, b, c, d]);
    }
    if (!work.spend(flipActive.size * 8 + 1)) return err(work.failure as ModelingError);
    // Tangential smoothing with reprojection (curve vertices along their curve).
    const normals = vertexNormals(w);
    const smoothSet = new Set<number>();
    for (const v of new Set([...dirty, ...touched])) {
      if (!w.alive[v]) continue;
      smoothSet.add(v);
      for (const x of w.neighbours(v)) smoothSet.add(x);
    }
    const order = [...smoothSet].sort((x, y) => x - y);
    const targets = new Map<number, Tuple3>();
    for (const v of order) {
      const cls = w.vclass[v] as number;
      if (cls === 2 || (w.vt[v] as number[]).length === 0) continue;
      const p = w.p(v);
      const ring =
        cls === 1
          ? w.neighbours(v).filter((x) => (w.flag(v, x) & s.featureMask) !== 0)
          : w.neighbours(v);
      if (ring.length === 0) continue;
      const q: Tuple3 = [0, 0, 0];
      for (const x of ring) {
        const r = w.p(x);
        q[0] += r[0] / ring.length;
        q[1] += r[1] / ring.length;
        q[2] += r[2] / ring.length;
      }
      let d: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      if (cls === 0) {
        const n = normals[v] as Tuple3;
        const along = dot(n, d);
        d = [d[0] - n[0] * along, d[1] - n[1] * along, d[2] - n[2] * along];
      }
      targets.set(v, project(v, [p[0] + speed * d[0], p[1] + speed * d[1], p[2] + speed * d[2]]));
    }
    for (const v of order) {
      const to = targets.get(v);
      if (to === undefined) continue;
      const from = w.p(v);
      let allowed = true;
      for (const t of w.vt[v] as number[]) {
        const before = w.normal(t);
        const after = w.normal(t, v, to);
        if (
          dot(before, after) < REMESH_NORMAL_DOT * norm(before) * norm(after) ||
          norm(after) === 0
        ) {
          allowed = false;
          break;
        }
      }
      const star = w.vt[v] as number[];
      if (
        !allowed ||
        !clear(
          star,
          star.map((t) => w.corners(t)),
          (x) => (x === v ? to : w.p(x)),
        )
      ) {
        prevented++;
        continue;
      }
      w.set(v, to);
      track(v);
      refresh(star, star);
      const moved = Math.sqrt(sq(to[0] - from[0]) + sq(to[1] - from[1]) + sq(to[2] - from[2]));
      if (moved > 1e-3 * target) touched.add(v);
    }
    if (!work.spend(order.length * 8 + 1)) return err(work.failure as ModelingError);
    dirty = touched;
  }
  return ok({
    splits,
    collapses,
    flips,
    iterations: ran,
    normalFlipsPrevented: prevented,
    clearanceBlocked,
    ...(metric.field === undefined
      ? {}
      : { field: { constrained: metric.field.constrained, roughness: metric.field.roughness } }),
  });
}

// ---- output -----------------------------------------------------------------------------------

/** Corner values of the processed triangles: closest point within the source face's UV island. */
function transferCorners(
  s: Setup,
  out: EditMesh,
  faces: readonly {
    readonly face: number;
    readonly src: number;
    readonly verts: readonly number[];
  }[],
  visit: (n: number) => void,
): void {
  const mesh = s.mesh;
  if (mesh.channels.size === 0) return;
  const parent = new Int32Array(mesh.faceHighWater);
  for (let f = 0; f < parent.length; f++) parent[f] = f;
  const find = (f: number): number => {
    while ((parent[f] as number) !== f) f = parent[f] as number;
    return f;
  };
  for (const e of mesh.edges()) {
    const f1 = mesh.hFace[e * 2] as number;
    const f2 = mesh.hFace[e * 2 + 1] as number;
    if (f1 === NONE || f2 === NONE || s.selected[f1] !== 1 || s.selected[f2] !== 1) continue;
    const h1 = e * 2;
    const h2 = e * 2 + 1;
    if (
      cornerValuesDiffer(mesh, h1, mesh.hNext[h2] as number) ||
      cornerValuesDiffer(mesh, h2, mesh.hNext[h1] as number)
    ) {
      continue;
    }
    const r1 = find(f1);
    const r2 = find(f2);
    if (r1 !== r2) parent[Math.max(r1, r2)] = Math.min(r1, r2);
  }
  const grid = new PrimitiveGrid(mesh.pos, s.sourceCorners);
  for (const { face, src, verts } of faces) {
    const island = find(src);
    const halves = out.faceHalves(face);
    for (let i = 0; i < halves.length; i++) {
      const p = out.position(verts[i] as number);
      const hit = grid.closest(p, (t) => find(s.sourceFace[t] as number) === island, visit);
      if (hit === undefined) continue;
      const from = [0, 1, 2].map((k) => s.sourceHalves[hit.index * 3 + k] as number);
      for (const [name, channel] of mesh.channels) {
        const values = from.map((h) => mesh.corner(name, h));
        if (values.some((v) => v === undefined)) continue;
        const value = new Array(channel.dim).fill(0);
        for (let k = 0; k < 3; k++) {
          const v = values[k] as Float32Array;
          for (let d = 0; d < channel.dim; d++)
            value[d] += (v[d] as number) * (hit.weights[k] as number);
        }
        out.setCorner(name, halves[i] as number, value);
      }
    }
  }
}

function triangleSoup(
  mesh: EditMesh,
  faces: readonly number[],
): { points: Float64Array; corners: Int32Array } {
  const corners: number[] = [];
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    for (let i = 1; i + 1 < vs.length; i++)
      corners.push(vs[0] as number, vs[i] as number, vs[i + 1] as number);
  }
  return { points: mesh.pos, corners: Int32Array.from(corners) };
}

function closedMesh(mesh: EditMesh): boolean {
  for (const e of mesh.edges()) if (mesh.isBoundaryEdge(e)) return false;
  return mesh.faceCount > 0;
}

// ---- tiling cleanup -----------------------------------------------------------------------------

/** Tiling cleanup never gives a vertex more neighbours (valence 9 and above read as fans). */
const TILING_MAX_VALENCE = 8;

interface TilingStats {
  readonly flips: number;
  readonly collapses: number;
  readonly passes: number;
  readonly prevented: number;
  readonly clearanceBlocked: number;
  readonly field?: { readonly constrained: number; readonly roughness: number };
}

/** A cap: a triangle with an angle above 150 degrees (cosine below -0.866). */
const CAP_COS = -0.866;

/** Aspect of a triangle: longest edge squared over twice its area (1.155 equilateral). */
function aspectOf(a: Tuple3, b: Tuple3, c: Tuple3): number {
  const e = [
    sq(b[0] - c[0]) + sq(b[1] - c[1]) + sq(b[2] - c[2]),
    sq(c[0] - a[0]) + sq(c[1] - a[1]) + sq(c[2] - a[2]),
    sq(a[0] - b[0]) + sq(a[1] - b[1]) + sq(a[2] - b[2]),
  ];
  const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const area =
    norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]) / 2;
  return area > 0 ? maxOf(e) / (2 * area) : Number.POSITIVE_INFINITY;
}

/** Cosine of the corner at `p` of triangle p, q, r. */
function cornerCos(p: Tuple3, q: Tuple3, r: Tuple3): number {
  const u: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const v: Tuple3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const l = norm(u) * norm(v);
  return l > 0 ? dot(u, v) / l : 1;
}

/** The largest corner cosine of a triangle (its smallest angle's cosine). */
function worstCos(a: Tuple3, b: Tuple3, c: Tuple3): number {
  return Math.max(cornerCos(a, b, c), cornerCos(b, c, a), cornerCos(c, a, b));
}

/**
 * Tiling cleanup (Delaunay flips, cap removal, needle
 * collapses). Each pass flips interior non-feature edges whose opposite angles sum above pi
 * (caps included) when the flip raises the pair's smallest angle (with a direction: when the
 * other diagonal is shorter in its metric, or to remove a cap), then collapses the shortest
 * edge of each triangle above `maxAspect`; neither gives a vertex more than 8 neighbours. No move turns a triangle by more than 45 degrees,
 * leaves the input surface by more than `maxError`, or (with `clearance`) comes closer to
 * another surface. Stops after `iterations` passes or when a pass changes nothing.
 */
function tiling(
  s: Setup,
  params: RemeshJobParams,
  work: WorkMeter,
): Result<TilingStats, ModelingError> {
  const w = s.work;
  const maxAspect = params.maxAspect ?? 5;
  const maxError = params.maxError ?? Number.POSITIVE_INFINITY;
  const iterations = params.iterations ?? 10;
  const { projectAs, offSurface, interpolate, directionAt } = surfaceTools(s, work);
  const metric = directionMetric(s, params.direction, interpolate, directionAt);
  const scale = Math.max(1e-9, s.scale);
  const grid =
    params.clearance === undefined ? undefined : clearanceGrid(s, params.clearance, scale / 100);
  let clearanceBlocked = 0;
  const clear = (
    before: readonly number[],
    after: readonly (readonly number[])[],
    at: (v: number) => Tuple3,
  ): boolean => {
    if (grid === undefined) return true;
    if (
      grid.allows(
        before,
        after.map((corners) => ({ corners, points: corners.map(at) })),
      )
    )
      return true;
    clearanceBlocked++;
    return false;
  };
  const refresh = (before: readonly number[], after: Iterable<number>) => {
    if (grid === undefined) return;
    for (const t of before) grid.remove(t);
    for (const t of after) grid.insert(t);
  };
  const faithful = (tris: readonly (readonly Tuple3[])[]): boolean =>
    tris.every(
      (t) =>
        offSurface([
          (t[0] as Tuple3)[0] / 3 + (t[1] as Tuple3)[0] / 3 + (t[2] as Tuple3)[0] / 3,
          (t[0] as Tuple3)[1] / 3 + (t[1] as Tuple3)[1] / 3 + (t[2] as Tuple3)[1] / 3,
          (t[0] as Tuple3)[2] / 3 + (t[1] as Tuple3)[2] / 3 + (t[2] as Tuple3)[2] / 3,
        ]) <= maxError,
    );
  const turned = (before: Tuple3, after: Tuple3) =>
    norm(after) === 0 || dot(before, after) < REMESH_NORMAL_DOT * norm(before) * norm(after);
  let flips = 0;
  let collapses = 0;
  let prevented = 0;
  let passes = 0;
  for (let pass = 0; pass < iterations; pass++) {
    passes++;
    let changed = 0;
    // Flips toward Delaunay (caps have an angle near pi, so they flip first).
    for (let t = 0; t < w.src.length; t++) {
      if ((w.tri[t * 3] as number) < 0) continue;
      const c3 = w.corners(t);
      for (let i = 0; i < 3; i++) {
        const a = c3[i] as number;
        const b = c3[(i + 1) % 3] as number;
        if (a > b || (w.flag(a, b) & s.featureMask) !== 0) continue;
        const pair = orientedPair(w, a, b);
        if (pair === undefined) continue;
        const [t1, t2] = pair;
        const c = w.rotated(t1, a, b)[2];
        const d = w.rotated(t2, a, b)[2];
        if (c === d || w.edgeTris(c, d).length > 0) continue;
        // No fan: the flip gives c and d one neighbour more.
        if (w.valence(c) >= TILING_MAX_VALENCE || w.valence(d) >= TILING_MAX_VALENCE) continue;
        const [pa, pb, pc, pd] = [w.p(a), w.p(b), w.p(c), w.p(d)];
        // Opposite angles summing above pi: cot(c) + cot(d) < 0.
        const cot = (o: Tuple3, x: Tuple3, y: Tuple3) => {
          const u: Tuple3 = [x[0] - o[0], x[1] - o[1], x[2] - o[2]];
          const v: Tuple3 = [y[0] - o[0], y[1] - o[1], y[2] - o[2]];
          const cr = norm([
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
          ]);
          return cr > 0 ? dot(u, v) / cr : Number.NEGATIVE_INFINITY;
        };
        const before = Math.max(worstCos(pa, pb, pc), worstCos(pb, pa, pd));
        const after = Math.max(worstCos(pc, pa, pd), worstCos(pd, pb, pc));
        // With a field, flips take the metric-shorter diagonal (as the remesh's), and only caps
        // flip toward Delaunay; without one, Delaunay flips that raise the smallest angle.
        const cap = Math.min(cornerCos(pc, pa, pb), cornerCos(pd, pa, pb)) < CAP_COS;
        const delaunay = cot(pc, pa, pb) + cot(pd, pa, pb) < -1e-12 && after < before;
        if (metric.active ? !metric.flips(a, b, c, d) && !(cap && delaunay) : !delaunay) continue;
        const [n1, n2] = [w.normal(t1), w.normal(t2)];
        const flip1: Tuple3[] = [pc, pa, pd];
        const flip2: Tuple3[] = [pd, pb, pc];
        const nrm = (q: Tuple3[]) => {
          const [x, y, z] = q as [Tuple3, Tuple3, Tuple3];
          const u: Tuple3 = [y[0] - x[0], y[1] - x[1], y[2] - x[2]];
          const v: Tuple3 = [z[0] - x[0], z[1] - x[1], z[2] - x[2]];
          return [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
          ] as Tuple3;
        };
        const f1 = nrm(flip1);
        const f2 = nrm(flip2);
        if (
          turned(n1, f1) ||
          turned(n2, f1) ||
          turned(n1, f2) ||
          turned(n2, f2) ||
          !faithful([flip1, flip2]) ||
          !clear(
            [t1, t2],
            [
              [c, a, d],
              [d, b, c],
            ],
            (v) => w.p(v),
          )
        ) {
          prevented++;
          continue;
        }
        w.flip(a, b);
        refresh([t1, t2], [t1, t2]);
        flips++;
        changed++;
        break;
      }
    }
    if (!work.spend(w.src.length * 8 + 1)) return err(work.failure as ModelingError);
    // Needles: collapse the shortest edge of each triangle above maxAspect.
    const needles: { t: number; aspect: number }[] = [];
    for (let t = 0; t < w.src.length; t++) {
      if ((w.tri[t * 3] as number) < 0) continue;
      const [a, b, c] = w.corners(t).map((v) => w.p(v)) as [Tuple3, Tuple3, Tuple3];
      const aspect = aspectOf(a, b, c);
      if (aspect > maxAspect) needles.push({ t, aspect });
    }
    needles.sort((x, y) => y.aspect - x.aspect || x.t - y.t);
    for (const { t } of needles) {
      if ((w.tri[t * 3] as number) < 0) continue;
      const c3 = w.corners(t);
      let best: [number, number] | undefined;
      let shortest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const a = c3[i] as number;
        const b = c3[(i + 1) % 3] as number;
        const l = w.length(a, b);
        if (l < shortest) [shortest, best] = [l, [a, b]];
      }
      if (best === undefined) continue;
      const [a, b] = best;
      const p = plan(s, a, b);
      if (p === undefined) {
        prevented++;
        continue;
      }
      const mid: Tuple3 = [
        (w.p(a)[0] + w.p(b)[0]) / 2,
        (w.p(a)[1] + w.p(b)[1]) / 2,
        (w.p(a)[2] + w.p(b)[2]) / 2,
      ];
      const bits = (w.vclass[p.keep] as number) === 1 ? (w.vfeat[p.keep] as number) : 0;
      const position = p.kind === 'keep' ? w.p(p.keep) : projectAs(bits, mid);
      const star = [...new Set([...(w.vt[p.keep] as number[]), ...(w.vt[p.remove] as number[])])];
      const kept = star
        .map((x) => w.corners(x))
        .filter((c) => !(c.includes(p.keep) && c.includes(p.remove)))
        .map((c) => c.map((v) => (v === p.remove ? p.keep : v)));
      const at = (v: number) => (v === p.keep ? position : w.p(v));
      const merged = new Set([...w.neighbours(p.keep), ...w.neighbours(p.remove)]);
      merged.delete(p.keep);
      merged.delete(p.remove);
      if (
        merged.size > TILING_MAX_VALENCE ||
        !collapseAllowed(s, p, position, Number.POSITIVE_INFINITY, REMESH_NORMAL_DOT) ||
        !faithful(kept.map((c) => c.map(at))) ||
        !clear(star, kept, at)
      ) {
        prevented++;
        continue;
      }
      metric.track(p.keep, position);
      w.collapse(p.keep, p.remove, position);
      refresh(star, w.vt[p.keep] as number[]);
      collapses++;
      changed++;
    }
    if (!work.spend(needles.length * 16 + 1)) return err(work.failure as ModelingError);
    if (changed === 0) break;
  }
  return ok({
    flips,
    collapses,
    passes,
    prevented,
    clearanceBlocked,
    ...(metric.field === undefined
      ? {}
      : { field: { constrained: metric.field.constrained, roughness: metric.field.roughness } }),
  });
}

export function runRemeshJob(
  request: ComputeJobRequest<'remesh'>,
  work: WorkMeter,
): Result<BackendOutput<'remesh'>, ModelingError> {
  const params = request.params;
  const decoded = decodeSnapshot(request.inputs[0] ?? new Uint8Array());
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const ready = setup(mesh, params);
  if (!ready.ok) return ready;
  const s = ready.value;
  const w = s.work;
  const trianglesBefore = w.triangles;
  const metrics: Record<string, number> = { trianglesBefore };
  if (params.operation === 'simplify') {
    const r = simplify(s, params, work);
    if (!r.ok) return r;
    metrics.collapses = r.value.collapses;
    metrics.blockedCollapses = r.value.blocked;
    if (params.clearance !== undefined) metrics.clearanceBlocked = r.value.clearanceBlocked;
    metrics.lastCollapseError = r.value.lastError;
    metrics.stoppedByMaxError = r.value.stoppedByMaxError ? 1 : 0;
  } else if (params.operation === 'tiling') {
    const r = tiling(s, params, work);
    if (!r.ok) return r;
    metrics.flips = r.value.flips;
    metrics.collapses = r.value.collapses;
    metrics.passes = r.value.passes;
    metrics.prevented = r.value.prevented;
    if (params.clearance !== undefined) metrics.clearanceBlocked = r.value.clearanceBlocked;
    if (r.value.field !== undefined) {
      metrics.fieldConstrained = r.value.field.constrained;
      metrics.fieldRoughness = r.value.field.roughness;
    }
  } else {
    const r = isotropic(s, params, work);
    if (!r.ok) return r;
    metrics.splits = r.value.splits;
    metrics.collapses = r.value.collapses;
    metrics.flips = r.value.flips;
    metrics.iterations = r.value.iterations;
    metrics.normalFlipsPrevented = r.value.normalFlipsPrevented;
    if (params.clearance !== undefined) metrics.clearanceBlocked = r.value.clearanceBlocked;
    if (r.value.field !== undefined) {
      metrics.fieldConstrained = r.value.field.constrained;
      metrics.fieldRoughness = r.value.field.roughness;
    }
  }
  metrics.trianglesAfter = w.triangles;

  const out = new EditMesh();
  replaceAll(out.labelNames, mesh.labelNames);
  replaceAll(out.roleNames, mesh.roleNames);
  replaceAll(out.materialNames, mesh.materialNames);
  pushAll(out.tagNames, mesh.tagNames);
  out.reserveTagWords(mesh.tagWords);
  const vertexOf = new Map<number, number>();
  const vertex = (v: number) => {
    let mapped = vertexOf.get(v);
    if (mapped === undefined) {
      const p = w.p(v);
      mapped = out.addVertex(p[0], p[1], p[2]);
      vertexOf.set(v, mapped);
    }
    return mapped;
  };
  const source: number[] = [];
  const locations: ComputeLocation[] = [];
  for (const f of mesh.faces()) {
    if (s.selected[f] === 1) continue;
    const halves = mesh.faceHalves(f);
    const added = out.addFace(halves.map((h) => vertex(mesh.hVert[h] as number)));
    if (!added.ok) return added;
    mesh.copyFaceAttributesTo(f, out, added.value);
    const to = out.faceHalves(added.value);
    for (let i = 0; i < halves.length; i++) {
      for (const name of mesh.channels.keys()) {
        const value = mesh.corner(name, halves[i] as number);
        if (value !== undefined) out.setCorner(name, to[i] as number, value);
      }
    }
    source[added.value] = f;
  }
  const processed: { face: number; src: number; verts: number[] }[] = [];
  for (let t = 0; t < w.src.length; t++) {
    if ((w.tri[t * 3] as number) < 0) continue;
    const verts = w.corners(t).map(vertex);
    const added = out.addFace(verts);
    if (!added.ok) {
      const p = out.position(verts[0] as number);
      if (locations.length < 32) locations.push({ reason: 'non-manifold-edge', position: p });
      continue;
    }
    const src = w.src[t] as number;
    mesh.copyFaceAttributesTo(src, out, added.value);
    source[added.value] = src;
    processed.push({ face: added.value, src, verts });
  }
  for (const e of mesh.edges()) {
    const flags = mesh.eFlags[e] as number;
    if (flags === 0) continue;
    const f1 = mesh.hFace[e * 2] as number;
    const f2 = mesh.hFace[e * 2 + 1] as number;
    const passThrough =
      (f1 !== NONE && s.selected[f1] !== 1) || (f2 !== NONE && s.selected[f2] !== 1);
    if (!passThrough) continue;
    const [a, b] = mesh.edgeVertices(e);
    const h = out.findHalf(vertexOf.get(a) ?? -1, vertexOf.get(b) ?? -1);
    if (h !== NONE) out.eFlags[h >> 1] = mergeFlags(out.eFlags[h >> 1] as number, flags);
  }
  for (const [key, bits] of w.flags) {
    const intent =
      ((bits & F_SHARP) !== 0 ? (bits >> F_CREASE_SHIFT) & CREASE_BITS : 0) |
      ((bits & F_SEAM) !== 0 ? EDGE_SEAM : 0);
    if (intent === 0) continue;
    const [a, b] = edgeEnds(key);
    if (!w.alive[a] || !w.alive[b]) continue;
    const h = out.findHalf(vertexOf.get(a) ?? -1, vertexOf.get(b) ?? -1);
    if (h !== NONE) out.eFlags[h >> 1] = mergeFlags(out.eFlags[h >> 1] as number, intent);
  }
  transferCorners(s, out, processed, (k) => {
    work.spend(k);
  });
  if (work.failure !== undefined) return err(work.failure);

  const before = { points: mesh.pos, corners: s.sourceCorners };
  const after = triangleSoup(
    out,
    processed.map((p) => p.face),
  );
  const distance = hausdorff(before, after, (k) => {
    work.spend(k);
  });
  if (work.failure !== undefined) return err(work.failure);
  metrics.hausdorff = distance.max;
  metrics.hausdorffMean = distance.mean;
  metrics.hausdorffRelative = distance.max / s.scale;
  if (closedMesh(mesh) && closedMesh(out)) {
    const all = triangleSoup(mesh, mesh.faces());
    const volumeBefore = soupVolume(all.points, all.corners);
    const outAll = triangleSoup(out, out.faces());
    const volumeAfter = soupVolume(outAll.points, outAll.corners);
    metrics.volumeBefore = volumeBefore;
    metrics.volumeAfter = volumeAfter;
    metrics.volumeChange =
      volumeBefore !== 0 ? (volumeAfter - volumeBefore) / Math.abs(volumeBefore) : 0;
  }
  if (params.operation === 'isotropic') {
    const lengths: number[] = [];
    const seen = new Set<number>();
    for (const { face } of processed) {
      for (const h of out.faceHalves(face)) {
        const e = h >> 1;
        if (seen.has(e)) continue;
        seen.add(e);
        const [a, b] = out.edgeVertices(e);
        const p = out.position(a);
        const q = out.position(b);
        lengths.push(Math.sqrt(sq(p[0] - q[0]) + sq(p[1] - q[1]) + sq(p[2] - q[2])));
      }
    }
    const target = params.targetEdgeLength as number;
    metrics.edgeLengthMean = lengths.reduce((x, y) => x + y, 0) / Math.max(1, lengths.length);
    metrics.edgeLengthMin = lengths.reduce((x, y) => (y < x ? y : x), lengths[0] ?? 0);
    metrics.edgeLengthMax = lengths.reduce((x, y) => (y > x ? y : x), 0);
    metrics.edgesInRange =
      lengths.filter((l) => l >= (4 / 5) * target * 0.999 && l <= (4 / 3) * target * 1.001).length /
      Math.max(1, lengths.length);
  }
  const { faceMap } = out.compact();
  const face = new Int32Array(out.faceCount).fill(-1);
  for (const f of out.faces()) face[faceMap[f] as number] = source[f] ?? -1;
  return ok({
    status: locations.length > 0 ? 'partial' : 'ok',
    outputs: [encodeSnapshot(out)],
    provenance: [{ face }],
    metrics,
    locations,
  });
}
