import { ok, type Result } from '@forgeax/engine-types';
import { type Affine, applyPoint, invertRigid, multiply } from './affine';
import { pushAll } from './arrays';
import { hypot3 } from './dmath';
import type { ModelingError } from './errors';
import { type Tuple3, triangulateLoop, windingNumber } from './geom';
import { pointTriangleDistance, triangleContact } from './intersect';
import type { EditMesh } from './mesh';
import type { Clamp, PoseOptions } from './rig';

/**
 * A pair of parts designed to touch or nearly touch, exempt from the clearance check.
 * `seat` (default): one part sunk into the other, penetration accepted up to `tolerance`
 * (mount seats, faceted pins pressed into holes). `fit`: a running fit such as a pin in a
 * clearance hole, which accepts no penetration (`FIT_TOLERANCE`: the rounding of flush faces).
 */
export interface DesignedContact {
  readonly parts: readonly [string, string];
  readonly kind?: 'seat' | 'fit';
  /** Seats: penetration accepted in meters (default 0.001). */
  readonly tolerance?: number;
  /**
   * Fits: the band [min, max] (meters) the pair's closest surface distance must stay in, such
   * as an ISO 286 radial clearance; `interference`, `scan` and `validate` check it, so a
   * mis-sized bore cannot hide behind the fit's exemption. Without it a fit only refuses
   * penetration.
   */
  readonly gap?: readonly [number, number];
}

/** A fit's declared band against the closest distance measured (at one pose, or along a path). */
export interface FitCheck {
  readonly parts: readonly [string, string];
  readonly gap: readonly [number, number];
  /** Smallest and largest closest distance over the pose or the path samples (0 on contact). */
  readonly min: number;
  readonly max: number;
  /** Path u of the sample furthest outside the band (scans only). */
  readonly at?: number;
  /** Every measured distance is within the band (1 nm slack). */
  readonly pass: boolean;
}

/** @internal Penetration a designed contact accepts by default (meters), shared by `rig` and `validate`. */
export const DESIGNED_CONTACT_TOLERANCE = 1e-3;

/** @internal Penetration a `fit` accepts: none beyond the rounding of flush faces (meters). */
export const FIT_TOLERANCE = 1e-9;

/** @internal Penetration a designed contact accepts. */
export function contactTolerance(contact: DesignedContact): number {
  return contact.kind === 'fit' ? FIT_TOLERANCE : (contact.tolerance ?? DESIGNED_CONTACT_TOLERANCE);
}

export interface InterferenceOptions extends PoseOptions {
  /** Penetration accepted between any two parts in meters (default 1e-4). */
  readonly tolerance?: number;
  readonly contacts?: readonly DesignedContact[];
}

export interface ScanOptions extends InterferenceOptions {
  /** Largest spacing of the samples that test every pair, in u (default 0.05). */
  readonly step?: number;
  /**
   * Largest distance in meters any part may travel between samples (default 0.005).
   * Intervals where two parts with overlapping swept bounds could move farther are
   * subdivided, so parts thicker than this cannot pass through each other unseen.
   * A graze whose path inside the other part is shorter than this (a corner clipping
   * a corner, 0.26 mm deep at the 5 mm default in one probe) can still fall between
   * samples: lower maxTravel to bound it.
   */
  readonly maxTravel?: number;
  /** Bisection steps that locate each pair's first contact between samples (default 6). */
  readonly refine?: number;
  /**
   * DMU clearance threshold in meters (CAD default 5 mm, `0.005`): pairs that come closer
   * than this without touching are reported as `clearance`, and every reported pair carries
   * its smallest surface distance along the path. Intervals where a pair could dip below
   * the threshold between samples are subdivided until its motion bound rules that out to
   * `CLEARANCE_PRECISION`. Designed contacts are exempt. Default: no clearance check.
   */
  readonly clearance?: number;
}

/** Depth over the passed thickness from which crossing parts slice through each other (half, less rounding). */
const THROUGH_SATURATION = 0.45;

/** @internal Closest distance (meters) at or below which a pair is touching: rounding of flush faces. */
export const CONTACT_DISTANCE = 1e-9;

/** @internal Distance resolution of the clearance check: a pair whose minimum lies this close under the threshold may pass. */
export const CLEARANCE_PRECISION = 1e-4;

/**
 * `confirmed`: the parts penetrate deeper than the tolerance, one lies inside the other, or
 * closed parts pass through each other (reason `through`, whatever the tolerance);
 * `candidate`: they touch within the tolerance and are not a designed contact (review
 * them); `designed`: a declared contact within its tolerance.
 */
export type InterferenceStatus = 'confirmed' | 'candidate' | 'designed';

/**
 * `through`: closed parts slicing through each other, each with an edge that enters one face
 * of the other and leaves the opposite face (depth stops at half the thinner part's thickness
 * there, so no tolerance on depth can tell it from a seat).
 */
export type InterferenceReason = 'penetration' | 'contained' | 'contact' | 'through';

export interface InterferencePair {
  readonly parts: readonly [string, string];
  readonly status: InterferenceStatus;
  readonly reason: InterferenceReason;
  /**
   * Estimated penetration depth in meters (0 for touching surfaces): for closed parts the
   * farthest surface point inside the other part, so it is at most half the thinner
   * part's thickness when thin parts cross.
   */
  readonly depth: number;
  /**
   * How far crossing surfaces pass through each other: the largest over crossing triangle
   * pairs of the smaller reach of each through the other's plane (0 without crossings).
   * Thin parts slicing through each other show reach far above depth (their depth is at
   * most half the thinner part); the status still follows depth, so review `candidate`
   * pairs whose reach exceeds the tolerance. It overestimates when a third face bounds
   * the overlap.
   */
  readonly reach: number;
  /** Triangle pairs in contact. */
  readonly triangles: number;
  /** Session face ids of each part in contact (at most 16 per part). */
  readonly faces: readonly [readonly number[], readonly number[]];
  /** A posed model-space point in the contact region. */
  readonly at: Tuple3;
  /**
   * Translation of `parts[1]` in posed model space that resolves the finding: along the
   * axis where the two posed bounds overlap least, away from `parts[0]`, by depth plus the
   * tolerance the pair was judged against (ties take the lowest axis and the positive
   * direction). Absent without penetration. A `through` pair slices across its other part,
   * so a move of this size may not clear it; read `reach`.
   */
  readonly suggestedMove?: Tuple3;
}

export interface InterferenceReport {
  /** No confirmed interference. */
  readonly pass: boolean;
  readonly confirmed: number;
  readonly candidates: number;
  readonly designed: number;
  /** Part pairs whose bounds overlapped and were tested exactly. */
  readonly tested: number;
  readonly pairs: readonly InterferencePair[];
  readonly clamped: readonly Clamp[];
  /** Declared fit bands (`DesignedContact.gap`) against the measured distance. */
  readonly fits?: readonly FitCheck[];
}

export interface ScanSample {
  readonly u: number;
  readonly confirmed: number;
  readonly candidates: number;
  readonly designed: number;
  /** With a clearance threshold: pairs closer than it without touching. */
  readonly clearances?: number;
}

/**
 * The DMU classes along a path: `confirmed` (clash) and `candidate` (undesigned contact)
 * as at a pose, `clearance` (closer than the threshold, never touching) and `designed`.
 * Pairs that keep the clearance everywhere (ok) are not listed.
 */
export type ScanStatus = InterferenceStatus | 'clearance';

export interface ScanPair {
  readonly parts: readonly [string, string];
  /** The worst status along the path. */
  readonly status: ScanStatus;
  /**
   * First u with any contact, refined between samples; for `clearance` pairs the first u
   * closer than the threshold.
   */
  readonly firstContact: number;
  /** First u with a confirmed interference, refined between samples. */
  readonly firstConfirmed?: number;
  readonly maxDepth: number;
  readonly maxDepthAt: number;
  /** Largest `reach` along the path (see InterferencePair). */
  readonly maxReach: number;
  /**
   * With a clearance threshold: the smallest surface distance along the path (0 when the
   * parts touch), as `partDistance` measures it at `minDistanceAt`, refined between samples.
   */
  readonly minDistance?: number;
  readonly minDistanceAt?: number;
}

export interface ScanReport {
  /** No confirmed interference at any sample. */
  readonly pass: boolean;
  readonly step: number;
  readonly maxTravel: number;
  /** The clearance threshold, when given. */
  readonly clearance?: number;
  /** The samples that tested every pair: every `step` and every key. */
  readonly samples: readonly ScanSample[];
  /** Poses evaluated in total, including travel subdivision and first-contact bisection. */
  readonly evaluated: number;
  readonly pairs: readonly ScanPair[];
  /** Joint values the path asked for outside their limits: the first u per joint and axis. */
  readonly clamped: readonly (Clamp & { readonly u: number })[];
  /** Declared fit bands (`DesignedContact.gap`) against the distance at every regular sample. */
  readonly fits?: readonly FitCheck[];
}

export interface ConnectivityOptions extends PoseOptions {
  /** Largest surface gap (m) that still counts as touching (default 5e-4). */
  readonly gap?: number;
  /**
   * Which parts are hardware: a joint is only crossed through a hardware part (default
   * parts named `mount-*`).
   */
  readonly hardware?: (part: string) => boolean;
  /**
   * Seed joints whose parts are fixed (default the rig root); the joints above them (a
   * stand mechanism) are fixed with them and need no crossing.
   */
  readonly roots?: readonly string[];
}

/** A part not connected to the root through touching kinematic neighbours. */
export interface FloatingPart {
  readonly part: string;
  readonly joint: string;
  /**
   * The nearest part outside its group it may attach to (a part of its own joint, or across
   * a joint a hardware part), when within 5 cm.
   */
  readonly nearest?: { readonly part: string; readonly distance: number };
}

export interface ConnectivityPose {
  /** Index into the tested poses. */
  readonly index: number;
  readonly floating: readonly FloatingPart[];
  /**
   * The floating parts grouped by touch: each group hangs together but reaches neither the
   * root nor, through touch, its parent group; one mount per group reattaches it.
   */
  readonly detached: readonly (readonly string[])[];
  /** Part-carrying joints (not the root) whose parts no touching hardware links to their ancestor's parts. */
  readonly unlinked: readonly string[];
}

export interface ConnectivityReport {
  /** No part floats in any pose. */
  readonly attached: boolean;
  readonly gap: number;
  /** The seed joints' parts, which every connection is traced from (none: everything floats). */
  readonly roots: readonly string[];
  readonly poses: readonly ConnectivityPose[];
  /** Parts floating in at least one pose, sorted. */
  readonly floating: readonly string[];
}

type P = readonly [number, number, number];

const LEAF = 4;
const FACE_LIMIT = 16;
const DEPTH_SAMPLES = 64;
const FLUSH_PLANES = 8;
const FLUSH_PER_PLANE = 32;
const FLUSH_LIFTS = 80;
const FLUSH_EPSILON = 1e-9;
/** Overlap below a square micrometer is the rounding of two touching edges, not a shared face. */
const FLUSH_AREA = 1e-12;

interface Bvh {
  /** Per node: min xyz, max xyz. */
  readonly bounds: Float64Array;
  /** Per node: right child (inner; the left child is the next node) or first triangle slot (leaf). */
  readonly start: Int32Array;
  /** Per node: 0 for inner nodes, else the leaf's triangle count. */
  readonly count: Int32Array;
  /** Triangle ids in leaf order. */
  readonly order: Int32Array;
}

/** @internal One bound part in its rest (model) space, prepared for exact tests. */
export interface PartGeometry {
  readonly name: string;
  readonly mesh: EditMesh;
  readonly faces: readonly number[];
  readonly closed: boolean;
  /** 9 numbers per triangle. */
  readonly tris: Float64Array;
  readonly triFace: Int32Array;
  readonly bvh: Bvh;
  /** Up to DEPTH_SAMPLES vertex positions (3 numbers each). */
  readonly samples: Float64Array;
  /** Every vertex position (3 numbers each). */
  readonly points: Float64Array;
}

function triangle(tris: Float64Array, t: number): P[] {
  const o = t * 9;
  return [
    [tris[o] as number, tris[o + 1] as number, tris[o + 2] as number],
    [tris[o + 3] as number, tris[o + 4] as number, tris[o + 5] as number],
    [tris[o + 6] as number, tris[o + 7] as number, tris[o + 8] as number],
  ];
}

function buildBvh(tris: Float64Array): Bvh {
  const n = tris.length / 9;
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const centroid = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let a = 0; a < 3; a++) {
      centroid[t * 3 + a] =
        ((tris[t * 9 + a] as number) +
          (tris[t * 9 + 3 + a] as number) +
          (tris[t * 9 + 6 + a] as number)) /
        3;
    }
  }
  const bounds: number[] = [];
  const start: number[] = [];
  const count: number[] = [];
  const build = (lo: number, hi: number): number => {
    const node = start.length;
    start.push(0);
    count.push(0);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const cbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i] as number;
      for (let k = 0; k < 9; k++) {
        const a = k % 3;
        const v = tris[t * 9 + k] as number;
        if (v < (box[a] as number)) box[a] = v;
        if (v > (box[a + 3] as number)) box[a + 3] = v;
      }
      for (let a = 0; a < 3; a++) {
        const c = centroid[t * 3 + a] as number;
        if (c < (cbox[a] as number)) cbox[a] = c;
        if (c > (cbox[a + 3] as number)) cbox[a + 3] = c;
      }
    }
    pushAll(bounds, box);
    if (hi - lo <= LEAF) {
      start[node] = lo;
      count[node] = hi - lo;
      return node;
    }
    const [ex, ey, ez] = [0, 1, 2].map((a) => (cbox[a + 3] as number) - (cbox[a] as number)) as [
      number,
      number,
      number,
    ];
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const slice = Array.from(order.subarray(lo, hi)).sort(
      (x, y) => (centroid[x * 3 + axis] as number) - (centroid[y * 3 + axis] as number) || x - y,
    );
    order.set(slice, lo);
    const mid = (lo + hi) >> 1;
    build(lo, mid);
    start[node] = build(mid, hi);
    return node;
  };
  if (n > 0) build(0, n);
  return {
    bounds: Float64Array.from(bounds),
    start: Int32Array.from(start),
    count: Int32Array.from(count),
    order,
  };
}

function overlaps(bounds: Float64Array, node: number, lo: P, hi: P): boolean {
  const o = node * 6;
  return (
    (bounds[o] as number) <= hi[0] &&
    (bounds[o + 3] as number) >= lo[0] &&
    (bounds[o + 1] as number) <= hi[1] &&
    (bounds[o + 4] as number) >= lo[1] &&
    (bounds[o + 2] as number) <= hi[2] &&
    (bounds[o + 5] as number) >= lo[2]
  );
}

/** Triangles of `bvh` whose node boxes overlap [lo, hi]. */
function query(bvh: Bvh, lo: P, hi: P, visit: (t: number) => void): void {
  if (bvh.order.length === 0) return;
  const stack = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (!overlaps(bvh.bounds, node, lo, hi)) continue;
    const count = bvh.count[node] as number;
    if (count > 0) {
      const s = bvh.start[node] as number;
      for (let i = s; i < s + count; i++) visit(bvh.order[i] as number);
    } else {
      stack.push(node + 1, bvh.start[node] as number);
    }
  }
}

function boxDistance(bvh: Bvh, node: number, p: P): number {
  const o = node * 6;
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const lo = bvh.bounds[o + a] as number;
    const hi = bvh.bounds[o + 3 + a] as number;
    const c = p[a] as number;
    const d = c < lo ? lo - c : c > hi ? c - hi : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** @internal Distance from `p` to the nearest triangle of a part. */
export function nearest(part: PartGeometry, p: P): number {
  let best = Infinity;
  const stack = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (boxDistance(part.bvh, node, p) >= best) continue;
    const count = part.bvh.count[node] as number;
    if (count > 0) {
      const s = part.bvh.start[node] as number;
      for (let i = s; i < s + count; i++) {
        const d = pointTriangleDistance(p, triangle(part.tris, part.bvh.order[i] as number));
        if (d < best) best = d;
      }
    } else {
      const right = part.bvh.start[node] as number;
      const left = node + 1;
      // A near leaf tightens the bound before a farther sibling is examined.
      if (boxDistance(part.bvh, right, p) < boxDistance(part.bvh, left, p)) {
        stack.push(left, right);
      } else {
        stack.push(right, left);
      }
    }
  }
  return best;
}

/** @internal Triangulate a part's faces in rest space and index them. */
export function partGeometry(
  mesh: EditMesh,
  name: string,
  faces: readonly number[],
  closed: boolean,
): PartGeometry {
  const tris: number[] = [];
  const triFace: number[] = [];
  const vertices = new Set<number>();
  for (const f of faces) {
    const verts = mesh.faceVertices(f);
    for (const v of verts) vertices.add(v);
    const points = verts.map((v) => mesh.position(v));
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) pushAll(tris, points[indices[i + k] as number] as Tuple3);
      triFace.push(f);
    }
  }
  const sorted = [...vertices].sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(sorted.length / DEPTH_SAMPLES));
  const samples: number[] = [];
  for (let i = 0; i < sorted.length; i += stride)
    pushAll(samples, mesh.position(sorted[i] as number));
  const packed = Float64Array.from(tris);
  const points = sorted.flatMap((v) => mesh.position(v));
  return {
    name,
    mesh,
    faces,
    closed,
    tris: packed,
    triFace: Int32Array.from(triFace),
    bvh: buildBvh(packed),
    samples: Float64Array.from(samples),
    points: Float64Array.from(points),
  };
}

/** How far a triangle reaches to both sides of another's plane: the smaller side (0 when coplanar). */
function twoSided(t: readonly P[], plane: readonly P[]): number {
  const [a, b, c] = plane as [P, P, P];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
    (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
    (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
  ] as [number, number, number];
  const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (l === 0) return 0;
  let above = 0;
  let below = 0;
  for (const p of t) {
    const d = (n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]) + n[2] * (p[2] - a[2])) / l;
    if (d > above) above = d;
    if (-d > below) below = -d;
  }
  return Math.min(above, below);
}

function bounds(tri: readonly P[]): [P, P] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of tri) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, p[a] as number);
      hi[a] = Math.max(hi[a] as number, p[a] as number);
    }
  }
  return [lo as unknown as P, hi as unknown as P];
}

function rootBox(part: PartGeometry, m: Affine): [P, P] | undefined {
  if (part.bvh.order.length === 0) return undefined;
  const b = part.bvh.bounds;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = applyPoint(m, [
      b[corner & 1 ? 3 : 0] as number,
      b[corner & 2 ? 4 : 1] as number,
      b[corner & 4 ? 5 : 2] as number,
    ]);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, p[a] as number);
      hi[a] = Math.max(hi[a] as number, p[a] as number);
    }
  }
  return [lo as unknown as P, hi as unknown as P];
}

function padded(box: [P, P] | undefined, pad: number): [P, P] | undefined {
  if (box === undefined) return undefined;
  return [box[0].map((v) => v - pad) as unknown as P, box[1].map((v) => v + pad) as unknown as P];
}

function boxesOverlap(a: [P, P], b: [P, P]): boolean {
  return [0, 1, 2].every(
    (k) => (a[0][k] as number) <= (b[1][k] as number) && (b[0][k] as number) <= (a[1][k] as number),
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** Depth of `inner` inside closed `outer`, or undefined when its first sample lies outside. */
function containedDepth(
  inner: PartGeometry,
  outer: PartGeometry,
  toOuter: Affine,
): number | undefined {
  const s = inner.samples;
  if (s.length === 0 || !outer.closed) return undefined;
  // A part inside another lies inside its bounds; most pairs fail here before the winding number.
  const box = rootBox(inner, toOuter);
  const bounds = rootBox(outer, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  if (box === undefined || bounds === undefined) return undefined;
  if (
    [0, 1, 2].some(
      (k) =>
        (box[0][k] as number) < (bounds[0][k] as number) ||
        (box[1][k] as number) > (bounds[1][k] as number),
    )
  )
    return undefined;
  const first = applyPoint(toOuter, [s[0] as number, s[1] as number, s[2] as number]);
  if (windingNumber(outer.mesh, outer.faces, first) <= 0.5) return undefined;
  let depth = 0;
  for (let i = 0; i < s.length; i += 3) {
    depth = Math.max(
      depth,
      nearest(outer, applyPoint(toOuter, [s[i] as number, s[i + 1] as number, s[i + 2] as number])),
    );
  }
  // A part whose every vertex hugs the host's surface (a plug a hair thinner than its slab) is
  // still wholly inside: its middle, when verified inside both, sits as deep as its nearer surface.
  if (inner.closed) {
    const middle: Tuple3 = [
      ((box[0][0] as number) + (box[1][0] as number)) / 2,
      ((box[0][1] as number) + (box[1][1] as number)) / 2,
      ((box[0][2] as number) + (box[1][2] as number)) / 2,
    ];
    const home = applyPoint(invertRigid(toOuter), middle);
    if (
      windingNumber(outer.mesh, outer.faces, middle) > 0.5 &&
      windingNumber(inner.mesh, inner.faces, home) > 0.5
    ) {
      depth = Math.max(depth, Math.min(nearest(outer, middle), nearest(inner, home)));
    }
  }
  return depth;
}

/**
 * Deepest vertex of `inner` inside closed `outer`, measured to `outer`'s surface. Surfaces
 * that meet only along shared edge lines (grid-aligned parts) never cross as triangles,
 * so a part sunk into another along its mesh lines shows up only here.
 */
function vertexDepth(inner: PartGeometry, outer: PartGeometry, toOuter: Affine): number {
  const bounds = rootBox(outer, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  if (bounds === undefined || !outer.closed) return 0;
  const s = inner.points;
  let depth = 0;
  for (let i = 0; i < s.length; i += 3) {
    const p = applyPoint(toOuter, [s[i] as number, s[i + 1] as number, s[i + 2] as number]);
    if (
      [0, 1, 2].some(
        (k) =>
          (p[k] as number) < (bounds[0][k] as number) ||
          (p[k] as number) > (bounds[1][k] as number),
      )
    )
      continue;
    const d = nearest(outer, p);
    // Points within a nanometer lie on the surface, where the winding number is ambiguous.
    if (d <= depth || d <= 1e-9) continue;
    if (windingNumber(outer.mesh, outer.faces, p) > 0.5) depth = d;
  }
  return depth;
}

type Plane = readonly [number, number, number, number];

/** Plane of a triangle with its normal along the winding (the part's outside for outward faces). */
function planeOf(t: readonly P[]): Plane | undefined {
  const [a, b, c] = t as [P, P, P];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ] as const;
  const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (l === 0) return undefined;
  return [n[0] / l, n[1] / l, n[2] / l, (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) / l];
}

/**
 * Overlap of two coplanar triangles with the same facing: `tb` clipped to the prism of `ta`
 * (a convex polygon in their common plane), or empty when they only touch.
 */
function coplanarOverlap(ta: readonly P[], tb: readonly P[], plane: Plane): P[] {
  const n = [plane[0], plane[1], plane[2]] as const;
  let polygon: P[] = [...tb];
  for (let k = 0; k < 3 && polygon.length > 0; k++) {
    const p = ta[k] as P;
    const q = ta[(k + 1) % 3] as P;
    const e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]] as const;
    // n x e points into the triangle for a counter-clockwise winding.
    const m: P = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]];
    const l = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    if (l === 0) return [];
    const u = [m[0] / l, m[1] / l, m[2] / l] as const;
    polygon = clipBehind(
      polygon,
      [-u[0], -u[1], -u[2], -(u[0] * p[0] + u[1] * p[1] + u[2] * p[2])],
      1,
    );
  }
  return polygon;
}

/**
 * The shared plane of two same-facing triangles that lie in one plane to within `eps`
 * (rotated or cut parts end up an ulp out of exact coplanarity), or undefined.
 */
function flushPlane(ta: readonly P[], tb: readonly P[], eps: number): Plane | undefined {
  const pa = planeOf(ta);
  const pb = planeOf(tb);
  if (pa === undefined || pb === undefined) return undefined;
  if (pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2] <= 0.5) return undefined;
  const flat = (plane: Plane, t: readonly P[]) =>
    t.every((v) => Math.abs(plane[0] * v[0] + plane[1] * v[1] + plane[2] * v[2] - plane[3]) <= eps);
  return flat(pa, tb) && flat(pb, ta) ? pa : undefined;
}

interface FlushPair {
  readonly polygon: readonly P[];
  readonly area: number;
}

interface Flush {
  readonly plane: Plane;
  readonly pairs: FlushPair[];
  /** Area-weighted sum of every overlap centroid seen, kept beyond the pair cap. */
  readonly moment: [number, number, number, number];
}

function polygonArea(polygon: readonly P[]): number {
  const o = polygon[0] as P;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[i] as P;
    const b = polygon[i + 1] as P;
    const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]] as const;
    const v = [b[0] - o[0], b[1] - o[1], b[2] - o[2]] as const;
    x += u[1] * v[2] - u[2] * v[1];
    y += u[2] * v[0] - u[0] * v[2];
    z += u[0] * v[1] - u[1] * v[0];
  }
  return hypot3(x, y, z) / 2;
}

function centroid(polygon: readonly P[]): P {
  return [0, 1, 2].map(
    (k) => polygon.reduce((sum, v) => sum + (v[k] as number), 0) / polygon.length,
  ) as unknown as P;
}

/** Whether `point` lies in the convex `polygon` of the plane with unit normal `n`. */
function insidePolygon(polygon: readonly P[], n: P, point: P): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as P;
    const b = polygon[(i + 1) % polygon.length] as P;
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const w = [point[0] - a[0], point[1] - a[1], point[2] - a[2]] as const;
    const side =
      n[0] * (e[1] * w[2] - e[2] * w[1]) +
      n[1] * (e[2] * w[0] - e[0] * w[2]) +
      n[2] * (e[0] * w[1] - e[1] * w[0]);
    if (Math.abs(side) <= FLUSH_EPSILON) continue;
    if (sign === 0) sign = side > 0 ? 1 : -1;
    else if (sign * side < 0) return false;
  }
  return true;
}

/** Keep the `FLUSH_PER_PLANE` largest overlaps of a plane: the smallest ones decide least. */
function admitFlush(entry: Flush, pair: FlushPair): void {
  const c = centroid(pair.polygon);
  entry.moment[0] += c[0] * pair.area;
  entry.moment[1] += c[1] * pair.area;
  entry.moment[2] += c[2] * pair.area;
  entry.moment[3] += pair.area;
  const pairs = entry.pairs;
  if (pairs.length < FLUSH_PER_PLANE) {
    pairs.push(pair);
    return;
  }
  let smallest = 0;
  for (let i = 1; i < pairs.length; i++) {
    if ((pairs[i] as FlushPair).area < (pairs[smallest] as FlushPair).area) smallest = i;
  }
  if (pair.area > (pairs[smallest] as FlushPair).area) pairs[smallest] = pair;
}

/**
 * Depth of two closed parts that share a face plane and overlap on it, from points just
 * inside both: an overlap centroid pushed along the inward normal. Triangle crossings
 * see no depth there (neither triangle leaves the other's plane), and the winding number
 * of a point on the plane is ambiguous, so the point is lifted off it. The lift walks down
 * from the size of the parts by factors of the square root of two (it must not depend on the
 * triangle size: a finely meshed face overlaps in tiny triangles) until the point is inside
 * both parts, then on to the deepest of those samples. A lower bound: the distance of the
 * deepest verified interior point to the nearer surface.
 */
function coplanarDepth(
  c: P,
  plane: Plane,
  A: PartGeometry,
  B: PartGeometry,
  toB: Affine,
  inward: number,
  span: number,
): number {
  const probe = (lift: number): number => {
    const p: P = [
      c[0] - plane[0] * lift * inward,
      c[1] - plane[1] * lift * inward,
      c[2] - plane[2] * lift * inward,
    ];
    const d = Math.min(nearest(A, p), nearest(B, applyPoint(toB, p)));
    if (d <= FLUSH_EPSILON) return 0;
    return windingNumber(A.mesh, A.faces, [p[0], p[1], p[2]]) > 0.5 &&
      windingNumber(B.mesh, B.faces, applyPoint(toB, p)) > 0.5
      ? d
      : 0;
  };
  let best = 0;
  let lift = span;
  for (let k = 1; k <= FLUSH_LIFTS; k++) {
    lift /= Math.SQRT2;
    if (lift <= best) break;
    const d = probe(lift);
    if (d < best) break;
    best = d;
  }
  return best;
}

/** The part of a convex polygon behind a plane (Sutherland-Hodgman). */
function clipBehind(polygon: readonly P[], plane: Plane, sign: number): P[] {
  const out: P[] = [];
  const side = (p: P) => sign * (plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] - plane[3]);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as P;
    const b = polygon[(i + 1) % polygon.length] as P;
    const da = side(a);
    const db = side(b);
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** +1 when a closed part's faces wind outward (positive volume), -1 when inside out. */
function outward(part: PartGeometry): number {
  let volume = 0;
  const n = part.tris.length / 9;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triangle(part.tris, t) as [P, P, P];
    volume +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return volume < 0 ? -1 : 1;
}

/**
 * Surface penetration of one side: the farthest sampled point of `own` triangles that
 * lies inside closed part `other`, measured to `other`'s surface. Each triangle is
 * clipped behind the planes of the `other` triangles it crosses; the clipped polygon's
 * vertices and centroid are the samples (exact for convex overlaps, a lower bound
 * otherwise). Points are in `other`'s rest frame.
 */
function surfaceDepth(
  crossings: ReadonlyMap<number, { tri: P[]; others: P[][] }>,
  other: PartGeometry,
  sign: number,
): number {
  let depth = 0;
  for (const { tri, others } of crossings.values()) {
    let polygon: P[] = tri;
    for (const o of others) {
      const plane = planeOf(o);
      if (plane === undefined) continue;
      polygon = clipBehind(polygon, plane, sign);
      if (polygon.length === 0) break;
    }
    if (polygon.length === 0) continue;
    const centroid = [0, 1, 2].map(
      (k) => polygon.reduce((sum, p) => sum + (p[k] as number), 0) / polygon.length,
    ) as unknown as P;
    for (const p of [centroid, ...polygon]) {
      const d = nearest(other, p);
      if (d <= depth) continue;
      if (windingNumber(other.mesh, other.faces, [p[0], p[1], p[2]]) > 0.5) depth = d;
    }
  }
  return depth;
}

/**
 * @internal Placement of every part at one pose: `deltas` map rest model space to posed
 * model space; `relative(a, b)` maps part b's rest space into part a's, computed from the
 * joints below the pair's common ancestor only, so motion both parts share cannot perturb
 * the exact tests.
 */
export interface Placement {
  readonly deltas: readonly Affine[];
  readonly relative: (a: number, b: number) => Affine;
}

/**
 * Triangles of `part` (mapped by `m`) whose BVH leaves come within `pad` of `box`, in
 * ascending id order so results do not depend on the hierarchy.
 */
function trianglesNear(part: PartGeometry, m: Affine, box: readonly [P, P], pad: number): number[] {
  const out: number[] = [];
  const stack = part.bvh.order.length === 0 ? [] : [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    const [lo, hi] = nodeBox(part.bvh, node, m);
    if (boxSeparation(lo, hi, box) > pad) continue;
    const count = part.bvh.count[node] as number;
    if (count === 0) {
      stack.push(part.bvh.start[node] as number, node + 1);
      continue;
    }
    const first = part.bvh.start[node] as number;
    for (let i = first; i < first + count; i++) out.push(part.bvh.order[i] as number);
  }
  return out.sort((x, y) => x - y);
}

/** Crossing records seen from the other side: each triangle keyed back, points mapped by `m`. */
function swapped(
  crossings: ReadonlyMap<number, { tri: P[]; others: P[][] }>,
  m: Affine,
): Map<number, { tri: P[]; others: P[][] }> {
  return new Map(
    [...crossings].map(([k, v]) => [
      k,
      {
        tri: v.tri.map((p) => applyPoint(m, p)) as P[],
        others: v.others.map((o) => o.map((p) => applyPoint(m, p)) as P[]),
      },
    ]),
  );
}

/** Where segment pq crosses triangle t (Moller-Trumbore): the segment parameter, or undefined. */
function segmentHit(p: P, q: P, t: readonly P[]): number | undefined {
  const [a, b, c] = t as [P, P, P];
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]] as const;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * (h[0] as number) + e1[1] * (h[1] as number) + e1[2] * (h[2] as number);
  if (Math.abs(det) < 1e-300) return undefined;
  const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as const;
  const u = (s[0] * (h[0] as number) + s[1] * (h[1] as number) + s[2] * (h[2] as number)) / det;
  if (u <= 0 || u >= 1) return undefined;
  const k = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * (k[0] as number) + d[1] * (k[1] as number) + d[2] * (k[2] as number)) / det;
  if (v <= 0 || u + v >= 1) return undefined;
  const w = (e2[0] * (k[0] as number) + e2[1] * (k[1] as number) + e2[2] * (k[2] as number)) / det;
  return w > 0 && w < 1 ? w : undefined;
}

/**
 * How thick the other closed part is where an edge of the crossing triangles passes through
 * it: the edge enters one of its faces and leaves a face turned the opposite way (outward
 * normals more than 120 degrees apart). The smallest such length, or Infinity when no edge
 * passes through (a corner sunk into a face, or a faceted pin grazing a bore, enters without
 * leaving through an opposite face).
 */
function passedThickness(
  crossings: ReadonlyMap<number, { tri: P[]; others: P[][] }>,
  sign: number,
): number {
  let thinnest = Infinity;
  for (const { tri, others } of crossings.values()) {
    for (let i = 0; i < 3; i++) {
      const p = tri[i] as P;
      const q = tri[(i + 1) % 3] as P;
      const dir = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const hits: { t: number; n: readonly number[]; dot: number }[] = [];
      for (const o of others) {
        const t = segmentHit(p, q, o);
        if (t === undefined) continue;
        const plane = planeOf(o);
        if (plane === undefined) continue;
        const n: [number, number, number] = [sign * plane[0], sign * plane[1], sign * plane[2]];
        hits.push({
          t,
          n,
          dot: n[0] * (dir[0] as number) + n[1] * (dir[1] as number) + n[2] * (dir[2] as number),
        });
      }
      for (const enter of hits) {
        if (enter.dot >= 0) continue;
        for (const leave of hits) {
          if (leave.dot <= 0 || leave.t <= enter.t) continue;
          const facing =
            (enter.n[0] as number) * (leave.n[0] as number) +
            (enter.n[1] as number) * (leave.n[1] as number) +
            (enter.n[2] as number) * (leave.n[2] as number);
          if (facing < -0.5) {
            const length = Math.sqrt(
              (dir[0] as number) * (dir[0] as number) +
                (dir[1] as number) * (dir[1] as number) +
                (dir[2] as number) * (dir[2] as number),
            );
            thinnest = Math.min(thinnest, (leave.t - enter.t) * length);
          }
        }
      }
    }
  }
  return thinnest;
}

/** @internal Exact interference of parts `a` and `b` at one placement. */
export function pairInterference(
  parts: readonly PartGeometry[],
  a: number,
  b: number,
  placement: Placement,
  contacts: ReadonlyMap<string, number>,
  tolerance: number,
): InterferencePair | undefined {
  const A = parts[a] as PartGeometry;
  const B = parts[b] as PartGeometry;
  const deltaA = placement.deltas[a] as Affine;
  const deltaB = placement.deltas[b] as Affine;
  const rel = placement.relative(a, b);
  const boxA = rootBox(A, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const boxB = rootBox(B, rel);
  if (boxA === undefined || boxB === undefined || !boxesOverlap(boxA, boxB)) return undefined;
  let triangles = 0;
  let crossing = false;
  let local = 0;
  let at: Tuple3 | undefined;
  const facesA = new Set<number>();
  const facesB = new Set<number>();
  // Triangles of each side that properly cross the other part, with the triangles they cross (A's frame).
  const crossA = new Map<number, { tri: P[]; others: P[][] }>();
  const crossB = new Map<number, { tri: P[]; others: P[][] }>();
  // Same-facing coplanar overlaps: no triangle leaves the other's plane, so they are no crossing.
  const flush = new Map<string, Flush>();
  const scale = Math.max(1, ...boxA[0].map(Math.abs), ...boxA[1].map(Math.abs));
  const flushEps = FLUSH_EPSILON * scale;
  const flushArea = FLUSH_AREA * scale * scale;
  for (const t of trianglesNear(B, rel, boxA, 0)) {
    const tb = triangle(B.tris, t).map((p) => applyPoint(rel, p)) as P[];
    const [lo, hi] = bounds(tb);
    if (!boxesOverlap(boxA, [lo, hi])) continue;
    query(A.bvh, lo, hi, (s) => {
      const ta = triangle(A.tris, s);
      const contact = triangleContact(ta, tb);
      const shared = flushPlane(ta, tb, flushEps);
      if (shared !== undefined && (contact === 'cross' || contact === 'none')) {
        // Faces an ulp apart classify as disjoint; their overlap still decides on the interior.
        const polygon = coplanarOverlap(ta, tb, shared);
        const area = polygon.length < 3 ? 0 : polygonArea(polygon);
        if (area > flushArea) {
          const key = shared.map((x) => Math.round(x * 1e6) || 0).join();
          let entry = flush.get(key);
          if (entry === undefined && flush.size < FLUSH_PLANES) {
            entry = { plane: shared, pairs: [], moment: [0, 0, 0, 0] };
            flush.set(key, entry);
          }
          if (entry !== undefined) admitFlush(entry, { polygon, area });
        }
      }
      if (contact === 'none') return;
      triangles++;
      if (at === undefined) {
        at = applyPoint(
          deltaA,
          [0, 1, 2].map((k) => tb.reduce((sum, p) => sum + (p[k] as number), 0) / 3),
        );
      }
      if (facesA.size < FACE_LIMIT) facesA.add(A.triFace[s] as number);
      if (facesB.size < FACE_LIMIT) facesB.add(B.triFace[t] as number);
      if (contact !== 'cross' || shared !== undefined) return;
      const d = Math.min(twoSided(ta, tb), twoSided(tb, ta));
      if (d === 0) return;
      crossing = true;
      local = Math.max(local, d);
      const ea = crossA.get(s) ?? { tri: ta, others: [] };
      ea.others.push(tb);
      crossA.set(s, ea);
      const eb = crossB.get(t) ?? { tri: tb, others: [] };
      eb.others.push(ta);
      crossB.set(t, eb);
    });
  }
  let reason: InterferenceReason = crossing ? 'penetration' : 'contact';
  let depth = 0;
  if (triangles > 0 && A.closed && B.closed) {
    depth = Math.max(vertexDepth(B, A, rel), vertexDepth(A, B, invertRigid(rel)));
    if (depth > 0) reason = 'penetration';
  }
  let flushThickness = Infinity;
  if (flush.size > 0 && A.closed && B.closed) {
    const toB = invertRigid(rel);
    const inward = outward(A);
    const span = hypot3(
      (boxA[1][0] as number) - (boxA[0][0] as number),
      (boxA[1][1] as number) - (boxA[0][1] as number),
      (boxA[1][2] as number) - (boxA[0][2] as number),
    );
    let flushDepth = 0;
    const sunk: { entry: Flush; at: P }[] = [];
    for (const entry of flush.values()) {
      const [mx, my, mz, area] = entry.moment;
      const whole: P = [mx / area, my / area, mz / area];
      for (const at of [whole, ...entry.pairs.map((pair) => centroid(pair.polygon))]) {
        const d = coplanarDepth(at, entry.plane, A, B, toB, inward, span);
        if (d > 0) sunk.push({ entry, at });
        flushDepth = Math.max(flushDepth, d);
      }
    }
    if (flushDepth > 0) {
      depth = Math.max(depth, flushDepth);
      reason = 'penetration';
      // Flush on two opposed planes at the same place: the overlap spans the full thickness between them.
      for (const { entry, at: c } of sunk) {
        const p = entry.plane;
        for (const other of flush.values()) {
          const q = other.plane;
          if (p[0] * q[0] + p[1] * q[1] + p[2] * q[2] >= -0.99) continue;
          const lift = q[0] * c[0] + q[1] * c[1] + q[2] * c[2] - q[3];
          const onQ: P = [c[0] - q[0] * lift, c[1] - q[1] * lift, c[2] - q[2] * lift];
          if (other.pairs.some((o) => insidePolygon(o.polygon, [q[0], q[1], q[2]], onQ))) {
            flushThickness = Math.min(flushThickness, Math.abs(p[3] + q[3]));
          }
        }
      }
    }
  }
  if (crossing) {
    if (A.closed && B.closed) {
      // Both sides in A's frame: B's points against A directly, A's points mapped into B's rest frame.
      const toB = invertRigid(rel);
      const intoB = new Map(
        [...crossA].map(([k, v]) => [
          k,
          {
            tri: v.tri.map((p) => applyPoint(toB, p)) as P[],
            others: v.others.map((o) => o.map((p) => applyPoint(toB, p)) as P[]),
          },
        ]),
      );
      depth = Math.max(
        depth,
        surfaceDepth(crossB, A, outward(A)),
        surfaceDepth(intoB, B, outward(B)),
      );
    } else {
      depth = local;
    }
  }
  if (triangles === 0) {
    const inA = containedDepth(B, A, rel);
    const inB = inA === undefined ? containedDepth(A, B, invertRigid(rel)) : undefined;
    const contained = inA ?? inB;
    if (contained === undefined) return undefined;
    reason = 'contained';
    depth = Math.max(depth, contained);
    const inner = inA !== undefined ? B : A;
    const s = inner.samples;
    at = applyPoint(inner === A ? deltaA : deltaB, [
      s[0] as number,
      s[1] as number,
      s[2] as number,
    ]);
  }
  const key = pairKey(A.name, B.name);
  const designed = contacts.get(key);
  const limit = designed ?? tolerance;
  const reach = triangles === 0 ? 0 : local;
  // Depth stops at half the thinner part when one slices through the other, so no tolerance
  // on depth can tell that from a seat. Closed parts whose edges each pass through the other
  // (entering one face and leaving the opposite one) with the depth at that saturation are a
  // clash whatever the tolerance; a part sunk less deep across another stays a seat.
  let through = false;
  if (depth <= limit && A.closed && B.closed && (crossing || flushThickness < Infinity)) {
    const thickness = crossing
      ? Math.min(
          flushThickness,
          passedThickness(crossB, outward(A)),
          passedThickness(swapped(crossA, invertRigid(rel)), outward(B)),
        )
      : flushThickness;
    through = thickness < Infinity && depth >= THROUGH_SATURATION * thickness;
  }
  if (through) reason = 'through';
  const status: InterferenceStatus =
    through || depth > limit ? 'confirmed' : designed !== undefined ? 'designed' : 'candidate';
  const ordered = A.name < B.name;
  const faces: [number[], number[]] = [
    [...facesA].sort((x, y) => x - y),
    [...facesB].sort((x, y) => x - y),
  ];
  const posedA = rootBox(A, deltaA);
  const posedB = rootBox(B, deltaB);
  const move =
    depth > 0 && posedA !== undefined && posedB !== undefined
      ? suggestedMove(ordered ? posedA : posedB, ordered ? posedB : posedA, depth + limit)
      : undefined;
  return {
    parts: ordered ? [A.name, B.name] : [B.name, A.name],
    status,
    reason,
    depth,
    reach,
    triangles,
    faces: ordered ? faces : [faces[1], faces[0]],
    at: at as Tuple3,
    ...(move === undefined ? {} : { suggestedMove: move }),
  };
}

/** Moves `second` away from `first` along the axis where their boxes overlap least. */
function suggestedMove(first: [P, P], second: [P, P], distance: number): Tuple3 {
  let axis = 0;
  let least = Infinity;
  for (let k = 0; k < 3; k++) {
    const overlap =
      Math.min(first[1][k] as number, second[1][k] as number) -
      Math.max(first[0][k] as number, second[0][k] as number);
    if (overlap < least) {
      least = overlap;
      axis = k;
    }
  }
  const center = (box: [P, P]) => ((box[0][axis] as number) + (box[1][axis] as number)) / 2;
  const move: [number, number, number] = [0, 0, 0];
  move[axis] = center(second) >= center(first) ? distance : -distance;
  return move;
}

const RANK: Record<ScanStatus, number> = { confirmed: 0, candidate: 1, clearance: 2, designed: 3 };

/** @internal Every part pair at one pose. */
export function testPose(
  parts: readonly PartGeometry[],
  placement: Placement,
  contacts: ReadonlyMap<string, number>,
  tolerance: number,
  clamped: readonly Clamp[],
): InterferenceReport {
  // World boxes carry the rounding of shared ancestor motion; a micron of padding keeps
  // exactly touching parts in the exact test, which runs in the pair's own frame.
  const boxes = parts.map((p, i) => padded(rootBox(p, placement.deltas[i] as Affine), 1e-6));
  const pairs: InterferencePair[] = [];
  let tested = 0;
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const ba = boxes[a];
      const bb = boxes[b];
      if (ba === undefined || bb === undefined || !boxesOverlap(ba, bb)) continue;
      tested++;
      const pair = pairInterference(parts, a, b, placement, contacts, tolerance);
      if (pair !== undefined) pairs.push(pair);
    }
  }
  pairs.sort(
    (x, y) =>
      RANK[x.status] - RANK[y.status] ||
      y.depth - x.depth ||
      pairKey(...x.parts).localeCompare(pairKey(...y.parts)),
  );
  const count = (s: InterferenceStatus) => pairs.filter((p) => p.status === s).length;
  const confirmed = count('confirmed');
  return {
    pass: confirmed === 0,
    confirmed,
    candidates: count('candidate'),
    designed: count('designed'),
    tested,
    pairs,
    clamped,
  };
}

/** One joint moving between two samples, seen from a part's rest frame at the first. */
export interface JointTurn {
  /** Turn in radians (spherical: the sum over axes). */
  readonly angle: number;
  readonly origin: P;
  /** Revolute joints: points move by their distance from this line. */
  readonly axis?: P;
}

/** Motion of a part relative to the other part of a pair between two samples. */
export interface MotionBound {
  /** Prismatic travel in meters. */
  readonly linear: number;
  readonly turns: readonly JointTurn[];
}

/** Node box of `bvh` mapped by `m` (axis-aligned bound of the 8 corners). */
function nodeBox(bvh: Bvh, node: number, m: Affine): [P, P] {
  const b = bvh.bounds;
  const o = node * 6;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = applyPoint(m, [
      b[o + (corner & 1 ? 3 : 0)] as number,
      b[o + (corner & 2 ? 4 : 1)] as number,
      b[o + (corner & 4 ? 5 : 2)] as number,
    ]);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, p[a] as number);
      hi[a] = Math.max(hi[a] as number, p[a] as number);
    }
  }
  return [lo as unknown as P, hi as unknown as P];
}

function boxGap(bvh: Bvh, node: number, box: [P, P]): number {
  const o = node * 6;
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const d = Math.max(
      0,
      (bvh.bounds[o + a] as number) - (box[1][a] as number),
      (box[0][a] as number) - (bvh.bounds[o + 3 + a] as number),
    );
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Path-length bound of a node's points: `L <= (D + sum(theta_j * d_j)) / (1 - sum(theta_j))`,
 * where `d_j` is the node's distance from joint j's axis (or origin) at the interval start.
 * Joints below j change that distance by at most L; joints above j move both rigidly.
 */
function nodeTravel(bvh: Bvh, node: number, motion: MotionBound): number {
  if (motion.turns.length === 0) return motion.linear;
  const o = node * 6;
  const c = [0, 0, 0];
  let radius = 0;
  for (let k = 0; k < 3; k++) {
    const lo = bvh.bounds[o + k] as number;
    const hi = bvh.bounds[o + 3 + k] as number;
    c[k] = (lo + hi) / 2;
    radius += ((hi - lo) / 2) * ((hi - lo) / 2);
  }
  const r = Math.sqrt(radius);
  let total = 0;
  let sum = motion.linear;
  for (const turn of motion.turns) {
    const d = [0, 1, 2].map((k) => (c[k] as number) - (turn.origin[k] as number)) as [
      number,
      number,
      number,
    ];
    let distance = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if (turn.axis !== undefined) {
      const along = d[0] * turn.axis[0] + d[1] * turn.axis[1] + d[2] * turn.axis[2];
      distance = Math.sqrt(Math.max(0, distance * distance - along * along));
    }
    total += turn.angle;
    sum += turn.angle * (distance + r);
  }
  return total >= 0.5 ? Infinity : sum / (1 - total);
}

/**
 * Conservative advancement on the two BVHs: whether some leaf pair is closer at the
 * interval start than its points can travel together, and could travel more than
 * `maxTravel`. Pairs that are farther apart than their motion bound stay apart.
 */
function needsSplit(
  a: PartGeometry,
  b: PartGeometry,
  rel: Affine,
  motion: readonly [MotionBound, MotionBound],
  maxTravel: number,
): boolean {
  if (a.bvh.order.length === 0 || b.bvh.order.length === 0) return false;
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const [na, nb] = stack.pop() as [number, number];
    const la = nodeTravel(a.bvh, na, motion[0]);
    const lb = nodeTravel(b.bvh, nb, motion[1]);
    // A node's bound covers every point below it: nothing here can travel farther.
    if (la + lb <= maxTravel) continue;
    if (boxGap(a.bvh, na, nodeBox(b.bvh, nb, rel)) > la + lb) continue;
    const leafA = (a.bvh.count[na] as number) > 0;
    const leafB = (b.bvh.count[nb] as number) > 0;
    if (leafA && leafB) {
      if (la + lb > maxTravel) return true;
      continue;
    }
    if (!leafA && (leafB || la >= lb)) stack.push([na + 1, nb], [a.bvh.start[na] as number, nb]);
    else stack.push([na, nb + 1], [na, b.bvh.start[nb] as number]);
  }
  return false;
}

/** @internal What the scan needs from the rig at one u. */
export interface ScanPose extends Placement {
  readonly clamped: readonly Clamp[];
  /** Joint coordinates (radians, meters) and joint world transforms for the motion bound. */
  readonly q: Float64Array;
  readonly worlds: readonly Affine[];
}

interface Posed extends ScanPose {
  readonly u: number;
}

/**
 * Largest motion bound over the leaf pairs that could come within `reach` of each other
 * during the interval (0 when none can): a leaf pair whose gap at the start exceeds its
 * travel plus `reach` stays farther apart than `reach` throughout.
 */
function approachTravel(
  a: PartGeometry,
  b: PartGeometry,
  rel: Affine,
  motion: readonly [MotionBound, MotionBound],
  reach: number,
): number {
  if (a.bvh.order.length === 0 || b.bvh.order.length === 0) return 0;
  let worst = 0;
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const [na, nb] = stack.pop() as [number, number];
    const la = nodeTravel(a.bvh, na, motion[0]);
    const lb = nodeTravel(b.bvh, nb, motion[1]);
    // A node's bound covers every point below it: nothing here can raise the result.
    if (la + lb <= worst) continue;
    if (boxGap(a.bvh, na, nodeBox(b.bvh, nb, rel)) > la + lb + reach) continue;
    const leafA = (a.bvh.count[na] as number) > 0;
    const leafB = (b.bvh.count[nb] as number) > 0;
    if (leafA && leafB) {
      worst = la + lb;
      continue;
    }
    if (!leafA && (leafB || la >= lb)) stack.push([na + 1, nb], [a.bvh.start[na] as number, nb]);
    else stack.push([na, nb + 1], [na, b.bvh.start[nb] as number]);
  }
  return worst;
}

/** One pair tested at one u: its interference and, with a clearance threshold, its surface distance. */
interface Entry {
  readonly u: number;
  readonly hit: InterferencePair | undefined;
  /**
   * 0 on contact; Infinity without a threshold, for designed pairs, or beyond twice the
   * threshold. Past the pair's first dip below the threshold it is exact only when it is a
   * new minimum, else an upper bound under the threshold, or the threshold itself.
   */
  readonly distance: number;
}

const GOLDEN = 0.6180339887498949;

/**
 * @internal Test every pair at the given samples, subdivide intervals by travel (and, with
 * a clearance threshold, wherever a pair could dip below it), then bisect each pair's
 * first contact and first confirmation and refine its smallest distance.
 */
export function scanPath(
  parts: readonly PartGeometry[],
  at: (u: number) => Result<ScanPose, ModelingError>,
  contacts: ReadonlyMap<string, number>,
  tolerance: number,
  us: readonly number[],
  options: {
    readonly step: number;
    readonly maxTravel: number;
    readonly refine: number;
    readonly clearance?: number;
    /** Motion of parts `a` and `b` relative to each other between two samples. */
    readonly motion: (
      s0: ScanPose,
      s1: ScanPose,
      a: number,
      b: number,
    ) => readonly [MotionBound, MotionBound];
  },
): Result<ScanReport, ModelingError> {
  const n = parts.length;
  const pairs: [number, number][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) pairs.push([a, b]);
  const log = pairs.map(() => [] as Entry[]);
  const clearance = options.clearance;
  const measured = pairs.map(
    ([a, b]) =>
      clearance !== undefined &&
      !contacts.has(pairKey((parts[a] as PartGeometry).name, (parts[b] as PartGeometry).name)),
  );
  const limit = 2 * (clearance ?? 0);
  const under = (e: Entry) =>
    clearance !== undefined && e.hit === undefined && e.distance < clearance;
  const samples: ScanSample[] = [];
  const clamped: (Clamp & { u: number })[] = [];
  const tested = new WeakMap<Posed, Map<number, Entry>>();
  let evaluated = 0;
  const pose = (u: number): Result<Posed, ModelingError> => {
    const posed = at(u);
    if (!posed.ok) return posed;
    evaluated++;
    for (const c of posed.value.clamped) clamped.push({ ...c, u });
    return ok({ u, ...posed.value });
  };
  // Per pair: the first u found under the threshold and the smallest exact distance so far.
  const firstUnder = pairs.map(() => Infinity);
  const smallest = pairs.map(() => Infinity);
  const measure = (k: number, posed: Posed, hit: InterferencePair | undefined, exact: boolean) => {
    if (clearance === undefined || !measured[k]) return Infinity;
    if (hit !== undefined) return 0;
    const [a, b] = pairs[k] as [number, number];
    if (!exact && posed.u > (firstUnder[k] as number)) {
      // Past its first dip only a new minimum needs the exact distance, which lies within
      // the smallest so far; otherwise whether the pair is under the threshold at all.
      const closer = partDistance(parts, a, b, posed, smallest[k] as number, 0, true);
      if (closer !== Infinity) return closer;
      return Math.min(clearance, partDistance(parts, a, b, posed, clearance, clearance, true));
    }
    return partDistance(parts, a, b, posed, limit, 0, true);
  };
  const test = (k: number, posed: Posed, exact = false): Entry => {
    const [a, b] = pairs[k] as [number, number];
    const hit = pairInterference(parts, a, b, posed, contacts, tolerance);
    const distance = measure(k, posed, hit, exact);
    if (clearance !== undefined && distance < clearance) {
      firstUnder[k] = Math.min(firstUnder[k] as number, posed.u);
    }
    if (distance < (smallest[k] as number)) smallest[k] = distance;
    const entry = { u: posed.u, hit, distance };
    (log[k] as Entry[]).push(entry);
    const row = tested.get(posed) ?? new Map<number, Entry>();
    tested.set(posed, row);
    row.set(k, entry);
    return entry;
  };
  const full: Posed[] = [];
  for (const u of us) {
    const posed = pose(u);
    if (!posed.ok) return posed;
    full.push(posed.value);
    const entries = pairs.map((_, k) => test(k, posed.value));
    const count = (s: InterferenceStatus) => entries.filter((e) => e.hit?.status === s).length;
    samples.push({
      u,
      confirmed: count('confirmed'),
      candidates: count('candidate'),
      designed: count('designed'),
      ...(clearance === undefined ? {} : { clearances: entries.filter(under).length }),
    });
  }
  // Distance changes no faster than the parts move: between samples the pair stays at least
  // (d0 + d1 - travel) / 2 apart, so an interval is split until that bound clears the threshold.
  const dips = (
    k: number,
    s0: Posed,
    s1: Posed,
    rel: Affine,
    motion: readonly [MotionBound, MotionBound],
  ): boolean => {
    // Splitting serves only the first dip: past it the pair is classified.
    if (clearance === undefined || !measured[k] || s0.u >= (firstUnder[k] as number)) return false;
    const d0 = tested.get(s0)?.get(k)?.distance ?? 0;
    const d1 = tested.get(s1)?.get(k)?.distance ?? 0;
    if (d0 < clearance || d1 < clearance) return false;
    const [a, b] = pairs[k] as [number, number];
    const reach = clearance - CLEARANCE_PRECISION;
    const travel = approachTravel(
      parts[a] as PartGeometry,
      parts[b] as PartGeometry,
      rel,
      motion,
      reach,
    );
    return travel > 0 && (Math.min(d0, limit) + Math.min(d1, limit) - travel) / 2 < reach;
  };
  const stack: { s0: Posed; s1: Posed; active: number[] }[] = [];
  for (let i = 0; i + 1 < full.length; i++) {
    stack.push({ s0: full[i] as Posed, s1: full[i + 1] as Posed, active: pairs.map((_, k) => k) });
  }
  while (stack.length > 0) {
    const { s0, s1, active } = stack.pop() as (typeof stack)[number];
    if (s1.u - s0.u < 1e-7) continue;
    const keep = active.filter((k) => {
      const [a, b] = pairs[k] as [number, number];
      const rel = multiply(invertRigid(s0.deltas[a] as Affine), s0.deltas[b] as Affine);
      const motion = options.motion(s0, s1, a, b);
      return (
        needsSplit(
          parts[a] as PartGeometry,
          parts[b] as PartGeometry,
          rel,
          motion,
          options.maxTravel,
        ) || dips(k, s0, s1, rel, motion)
      );
    });
    if (keep.length === 0) continue;
    const mid = pose((s0.u + s1.u) / 2);
    if (!mid.ok) return mid;
    for (const k of keep) test(k, mid.value);
    stack.push({ s0, s1: mid.value, active: keep }, { s0: mid.value, s1, active: keep });
  }
  const sample = (k: number, u: number, exact = false): Result<Entry, ModelingError> => {
    const posed = pose(u);
    if (!posed.ok) return posed;
    return ok(test(k, posed.value, exact));
  };
  const bisect = (
    k: number,
    lo: number,
    hi: number,
    hit: (e: Entry) => boolean,
  ): Result<number, ModelingError> => {
    let l = lo;
    let h = hi;
    for (let i = 0; i < options.refine; i++) {
      const e = sample(k, (l + h) / 2);
      if (!e.ok) return e;
      if (hit(e.value)) h = e.value.u;
      else l = e.value.u;
    }
    return ok(h);
  };
  const first = (
    k: number,
    entries: readonly Entry[],
    hit: (e: Entry) => boolean,
  ): Result<number | undefined, ModelingError> => {
    const i = entries.findIndex(hit);
    if (i < 0) return ok(undefined);
    const found = entries[i] as Entry;
    if (i === 0) return ok(found.u);
    return bisect(k, (entries[i - 1] as Entry).u, found.u, hit);
  };
  const byU = (k: number) => [...(log[k] as Entry[])].sort((x, y) => x.u - y.u);
  const closest = (entries: readonly Entry[]) =>
    entries.reduce((best, e) => (e.distance < best.distance ? e : best));
  // Golden-section search for the smallest distance between the closest sample's neighbours.
  const refineDistance = (k: number): Result<void, ModelingError> => {
    const sorted = byU(k);
    const i = sorted.indexOf(closest(sorted));
    if ((sorted[i] as Entry).distance === 0) return ok(undefined);
    let lo = (sorted[i - 1] ?? sorted[i]) as Entry;
    let hi = (sorted[i + 1] ?? sorted[i]) as Entry;
    if (hi.u - lo.u < 1e-9) return ok(undefined);
    let x1 = sample(k, hi.u - GOLDEN * (hi.u - lo.u), true);
    if (!x1.ok) return x1;
    let x2 = sample(k, lo.u + GOLDEN * (hi.u - lo.u), true);
    if (!x2.ok) return x2;
    for (let r = 0; r < options.refine; r++) {
      if (x1.value.distance <= x2.value.distance) {
        hi = x2.value;
        x2 = x1;
        x1 = sample(k, hi.u - GOLDEN * (hi.u - lo.u), true);
        if (!x1.ok) return x1;
      } else {
        lo = x1.value;
        x1 = x2;
        x2 = sample(k, lo.u + GOLDEN * (hi.u - lo.u), true);
        if (!x2.ok) return x2;
      }
    }
    return ok(undefined);
  };
  const out: ScanPair[] = [];
  for (const k of log.keys()) {
    let sorted = byU(k);
    const near = measured[k] === true && sorted.some((e) => e.hit !== undefined || under(e));
    if (near) {
      const refined = refineDistance(k);
      if (!refined.ok) return refined;
      sorted = byU(k);
    }
    const hits = sorted.filter((e) => e.hit !== undefined);
    if (hits.length === 0 && !near) continue;
    const contact = first(k, sorted, hits.length > 0 ? (e) => e.hit !== undefined : under);
    if (!contact.ok) return contact;
    const confirmed = first(k, sorted, (e) => e.hit?.status === 'confirmed');
    if (!confirmed.ok) return confirmed;
    const nearest = near ? closest(byU(k)) : undefined;
    // Flush faces a rounding apart touch: the exact test sees no contact, the distance does.
    let worst: ScanStatus =
      nearest !== undefined && nearest.distance <= CONTACT_DISTANCE ? 'candidate' : 'clearance';
    let deepest: Entry | undefined;
    for (const e of hits) {
      const h = e.hit as InterferencePair;
      if (worst === 'clearance' || RANK[h.status] < RANK[worst]) worst = h.status;
      if (deepest === undefined || h.depth > (deepest.hit as InterferencePair).depth) deepest = e;
    }
    const [a, b] = pairs[k] as [number, number];
    out.push({
      parts: [
        (parts[a] as PartGeometry).name,
        (parts[b] as PartGeometry).name,
      ].sort() as unknown as readonly [string, string],
      status: worst,
      firstContact: contact.value as number,
      ...(confirmed.value === undefined ? {} : { firstConfirmed: confirmed.value }),
      maxDepth: deepest === undefined ? 0 : (deepest.hit as InterferencePair).depth,
      maxDepthAt: (deepest ?? nearest ?? (sorted[0] as Entry)).u,
      maxReach: Math.max(0, ...hits.map((e) => (e.hit as InterferencePair).reach)),
      ...(nearest === undefined ? {} : { minDistance: nearest.distance, minDistanceAt: nearest.u }),
    });
  }
  out.sort(
    (x, y) =>
      RANK[x.status] - RANK[y.status] ||
      x.firstContact - y.firstContact ||
      pairKey(...x.parts).localeCompare(pairKey(...y.parts)),
  );
  return ok({
    pass: out.every((p) => p.status !== 'confirmed'),
    step: options.step,
    maxTravel: options.maxTravel,
    ...(clearance === undefined ? {} : { clearance }),
    samples,
    evaluated,
    pairs: out,
    clamped: dedupeClamps(clamped),
  });
}

/** One clamp entry per joint and axis: the first u where the path left the limits. */
function dedupeClamps(clamped: readonly (Clamp & { u: number })[]): (Clamp & { u: number })[] {
  const seen = new Map<string, Clamp & { u: number }>();
  for (const c of [...clamped].sort((x, y) => x.u - y.u)) {
    const key = `${c.joint}\n${c.axis ?? ''}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

/** Squared distance between segments pq and rs (closest points clamped to both). */
function segmentDistance2(p: P, q: P, r: P, s: P): number {
  const d1x = q[0] - p[0];
  const d1y = q[1] - p[1];
  const d1z = q[2] - p[2];
  const d2x = s[0] - r[0];
  const d2y = s[1] - r[1];
  const d2z = s[2] - r[2];
  const wx = p[0] - r[0];
  const wy = p[1] - r[1];
  const wz = p[2] - r[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * wx + d2y * wy + d2z * wz;
  let t1 = 0;
  let t2 = 0;
  if (a <= 0 && e <= 0) {
    t1 = 0;
    t2 = 0;
  } else if (a <= 0) {
    t2 = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * wx + d1y * wy + d1z * wz;
    if (e <= 0) {
      t1 = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      t1 = denom > 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t2 = (b * t1 + f) / e;
      if (t2 < 0) {
        t2 = 0;
        t1 = Math.min(1, Math.max(0, -c / a));
      } else if (t2 > 1) {
        t2 = 1;
        t1 = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const x = wx + d1x * t1 - d2x * t2;
  const y = wy + d1y * t1 - d2y * t2;
  const z = wz + d1z * t1 - d2z * t2;
  return x * x + y * y + z * z;
}

/** Squared distance from `p` to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDistance2(p: P, a: P, b: P, c: P): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;
  const bpx = p[0] - b[0];
  const bpy = p[1] - b[1];
  const bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = p[0] - c[0];
  const cpy = p[1] - c[1];
  const cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2;
  const vb = d5 * d2 - d1 * d6;
  const va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) {
    [qx, qy, qz] = a;
  } else if (d3 >= 0 && d4 <= d3) {
    [qx, qy, qz] = b;
  } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    qx = a[0] + abx * v;
    qy = a[1] + aby * v;
    qz = a[2] + abz * v;
  } else if (d6 >= 0 && d5 <= d6) {
    [qx, qy, qz] = c;
  } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    qx = a[0] + acx * w;
    qy = a[1] + acy * w;
    qz = a[2] + acz * w;
  } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    qx = b[0] + (c[0] - b[0]) * w;
    qy = b[1] + (c[1] - b[1]) * w;
    qz = b[2] + (c[2] - b[2]) * w;
  } else {
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    qx = a[0] + abx * v + acx * w;
    qy = a[1] + aby * v + acy * w;
    qz = a[2] + abz * v + acz * w;
  }
  const x = p[0] - qx;
  const y = p[1] - qy;
  const z = p[2] - qz;
  return x * x + y * y + z * z;
}

/**
 * @internal Distance between two triangles: 0 when they touch or cross. `disjoint` skips the exact
 * contact test for triangles already known not to meet. Disjoint triangles are closest at
 * a vertex of one against the other or between two edges.
 */
export function triangleDistance(t1: readonly P[], t2: readonly P[], disjoint = false): number {
  if (!disjoint && triangleContact(t1, t2) !== 'none') return 0;
  const [a, b, c] = t1 as [P, P, P];
  const [d, e, f] = t2 as [P, P, P];
  let best = Math.min(
    pointTriangleDistance2(a, d, e, f),
    pointTriangleDistance2(b, d, e, f),
    pointTriangleDistance2(c, d, e, f),
    pointTriangleDistance2(d, a, b, c),
    pointTriangleDistance2(e, a, b, c),
    pointTriangleDistance2(f, a, b, c),
  );
  for (const [p, q] of [
    [a, b],
    [b, c],
    [c, a],
  ] as const) {
    best = Math.min(
      best,
      segmentDistance2(p, q, d, e),
      segmentDistance2(p, q, e, f),
      segmentDistance2(p, q, f, d),
    );
  }
  return Math.sqrt(best);
}

/**
 * @internal Smallest surface distance between parts `a` and `b` at one placement, searched
 * up to `limit` (Infinity beyond it). A part enclosed by the other closed part counts as
 * touching (0). Stops at the first distance at or below `enough`. `disjoint` parts are
 * known to neither touch nor enclose each other (no interference at this placement), which
 * skips the exact contact and containment tests.
 */
export function partDistance(
  parts: readonly PartGeometry[],
  a: number,
  b: number,
  placement: Placement,
  limit: number,
  enough = 0,
  disjoint = false,
): number {
  const A = parts[a] as PartGeometry;
  const B = parts[b] as PartGeometry;
  const rel = placement.relative(a, b);
  const boxA = padded(rootBox(A, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), limit);
  const boxB = rootBox(B, rel);
  if (boxA === undefined || boxB === undefined || !boxesOverlap(boxA, boxB)) return Infinity;
  let best = Infinity;
  // Only B's nodes within reach of A's bounds hold candidates: a part far larger than the
  // other is pruned to the region near it.
  const unpadded = rootBox(A, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) as [P, P];
  const stack = [0];
  while (stack.length > 0 && best > enough) {
    const node = stack.pop() as number;
    const reach = Math.min(best, limit);
    const [nlo, nhi] = nodeBox(B.bvh, node, rel);
    if (boxSeparation(nlo, nhi, unpadded) > reach) continue;
    const count = B.bvh.count[node] as number;
    if (count === 0) {
      stack.push(B.bvh.start[node] as number, node + 1);
      continue;
    }
    const first = B.bvh.start[node] as number;
    for (let i = first; i < first + count && best > enough; i++) {
      const tb = triangle(B.tris, B.bvh.order[i] as number).map((p) => applyPoint(rel, p)) as P[];
      const [lo, hi] = bounds(tb);
      const r = Math.min(best, limit);
      query(A.bvh, [lo[0] - r, lo[1] - r, lo[2] - r], [hi[0] + r, hi[1] + r, hi[2] + r], (t) => {
        if (best <= enough) return;
        const ta = triangle(A.tris, t);
        if (boundsGap(ta, lo, hi) >= best) return;
        const d = triangleDistance(ta, tb, disjoint);
        if (d < best) best = d;
      });
    }
  }
  if (best <= enough) return best;
  if (!disjoint && containedDepth(B, A, rel) !== undefined) return 0;
  if (!disjoint && containedDepth(A, B, invertRigid(rel)) !== undefined) return 0;
  return best <= limit ? best : Infinity;
}

/** Gap between two boxes (0 when they overlap). */
function boxSeparation(lo: P, hi: P, box: readonly [P, P]): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(
      0,
      (lo[k] as number) - (box[1][k] as number),
      (box[0][k] as number) - (hi[k] as number),
    );
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Gap between a triangle's bounds and a box (a lower bound of their distance). */
function boundsGap(t: readonly P[], lo: P, hi: P): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const a = t[0] as P;
    const b = t[1] as P;
    const c = t[2] as P;
    const min = Math.min(a[k] as number, b[k] as number, c[k] as number);
    const max = Math.max(a[k] as number, b[k] as number, c[k] as number);
    const d = Math.max(0, min - (hi[k] as number), (lo[k] as number) - max);
    s += d * d;
  }
  return Math.sqrt(s);
}

const NEAREST_LIMIT = 0.05;

/**
 * @internal Groups of parts linked by touching (within `gap`): pairs on one joint (`same`)
 * and `crossing` pairs, as a group id per part (union-find, ids are the smallest member
 * index); the seeds form one group. Also every touching crossing pair, and for each part
 * outside the seeds' group the nearest part of another group it may attach to within 5 cm.
 */
export function partGroups(
  parts: readonly PartGeometry[],
  placement: Placement,
  same: (a: number, b: number) => boolean,
  crossing: (a: number, b: number) => boolean,
  seeds: readonly number[],
  gap: number,
): {
  readonly group: Int32Array;
  readonly nearest: ReadonlyMap<number, { part: number; distance: number }>;
  readonly touching: readonly (readonly [number, number])[];
} {
  const boxes = parts.map((p, i) => rootBox(p, placement.deltas[i] as Affine));
  const near = (a: number, b: number, pad: number) => {
    const ba = padded(boxes[a], pad);
    const bb = boxes[b];
    return ba !== undefined && bb !== undefined && boxesOverlap(ba, bb);
  };
  const up = Int32Array.from({ length: parts.length }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while ((up[r] as number) !== r) r = up[r] as number;
    while ((up[i] as number) !== r) {
      const next = up[i] as number;
      up[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) up[rb] = ra;
    else up[ra] = rb;
  };
  for (const s of seeds) union(seeds[0] as number, s);
  const touching: [number, number][] = [];
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const cross = crossing(a, b);
      // Crossings are always measured: they also report which joints are linked.
      if ((!cross && !same(a, b)) || (!cross && find(a) === find(b)) || !near(a, b, gap)) continue;
      if (partDistance(parts, a, b, placement, gap, gap) <= gap) {
        union(a, b);
        if (cross) touching.push([a, b]);
      }
    }
  }
  const group = Int32Array.from({ length: parts.length }, (_, i) => find(i));
  const home = seeds.length > 0 ? group[seeds[0] as number] : -1;
  const nearest = new Map<number, { part: number; distance: number }>();
  for (let f = 0; f < parts.length; f++) {
    if (group[f] === home) continue;
    let best: { part: number; distance: number } | undefined;
    for (let o = 0; o < parts.length; o++) {
      if (group[o] === group[f] || !(same(f, o) || crossing(f, o)) || !near(f, o, NEAREST_LIMIT)) {
        continue;
      }
      const d = partDistance(parts, f, o, placement, best?.distance ?? NEAREST_LIMIT);
      if (d < (best?.distance ?? Infinity)) best = { part: o, distance: d };
    }
    if (best !== undefined) nearest.set(f, best);
  }
  return { group, nearest, touching };
}

/** Closest point of triangle `t` to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: P, t: readonly P[]): P {
  const [a, b, c] = t as [P, P, P];
  const sub3 = (x: P, y: P): P => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: P, y: P) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const along = (o: P, d: P, s: number): P => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub3(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return along(b, sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** @internal The closest surface point of a part (rest space) to `p`, with its triangle's unit normal. */
export function closestPoint(
  part: PartGeometry,
  p: Tuple3,
): { readonly point: Tuple3; readonly normal: Tuple3; readonly distance: number } | undefined {
  let best: { point: P; tri: number; distance: number } | undefined;
  const stack = part.bvh.order.length === 0 ? [] : [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (best !== undefined && boxDistance(part.bvh, node, p) >= best.distance) continue;
    const count = part.bvh.count[node] as number;
    if (count > 0) {
      const s = part.bvh.start[node] as number;
      for (let i = s; i < s + count; i++) {
        const t = part.bvh.order[i] as number;
        const q = closestOnTriangle(p, triangle(part.tris, t));
        const d = hypot3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (best === undefined || d < best.distance) best = { point: q, tri: t, distance: d };
      }
    } else {
      stack.push(part.bvh.start[node] as number, node + 1);
    }
  }
  if (best === undefined) return undefined;
  const [a, b, c] = triangle(part.tris, best.tri) as [P, P, P];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
    (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
    (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
  ];
  const l = hypot3(n[0] as number, n[1] as number, n[2] as number) || 1;
  return {
    point: [...best.point] as Tuple3,
    normal: n.map((x) => x / l) as Tuple3,
    distance: best.distance,
  };
}

/**
 * @internal An approximately closest pair of surface points of two parts in one frame
 * (each vertex of either part against the other's surface).
 */
export function closestPair(
  a: PartGeometry,
  b: PartGeometry,
): { readonly onA: Tuple3; readonly onB: Tuple3; readonly distance: number } | undefined {
  let best: { onA: Tuple3; onB: Tuple3; distance: number } | undefined;
  for (const [from, to, swap] of [
    [a, b, false],
    [b, a, true],
  ] as const) {
    const pts = from.points;
    for (let i = 0; i < pts.length; i += 3) {
      const p: Tuple3 = [pts[i] as number, pts[i + 1] as number, pts[i + 2] as number];
      const q = closestPoint(to, p);
      if (q === undefined || (best !== undefined && q.distance >= best.distance)) continue;
      best = swap
        ? { onA: q.point, onB: p, distance: q.distance }
        : { onA: p, onB: q.point, distance: q.distance };
    }
  }
  return best;
}
