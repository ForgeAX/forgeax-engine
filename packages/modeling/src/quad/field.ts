// Field contract shared by the quad-meshing stages: M3 (cross field), M4 (Instant Meshes position
// field and extraction) and M5 (QuadriFlow rounding). Producers fill these records; consumers read
// only the arrays below and the matching helpers in this file, never solver internals.

import type { TriMesh } from './trimesh';

/** Where a field stores its samples: one per triangle or one per mesh vertex. */
export type FieldSite = 'face' | 'vertex';

/**
 * A cross field (4-RoSy): at each site the four unit tangent directions {q, n x q, -q, -n x q}.
 * `direction` holds the representative q; every consumer must treat the four rotations as equal.
 */
export interface CrossField {
  readonly site: FieldSite;
  /** The mesh the field lives on. It may be a refinement of the caller's input (see the producer report). */
  readonly mesh: TriMesh;
  /** Unit normal per site, 3 numbers per site. */
  readonly normal: Float64Array;
  /** Unit tangent representative q per site, 3 numbers per site, orthogonal to `normal`. */
  readonly direction: Float64Array;
  /** 1 where the site was a hard constraint (feature alignment), else 0. */
  readonly fixed: Uint8Array;
  /**
   * Nonzero indices, in quarter turns (index 1 = +1/4). Face fields place singularities at mesh
   * vertices, vertex fields at triangles. On a closed mesh the indices sum to 4 * chi exactly.
   */
  readonly singularities: readonly Singularity[];
}

export interface Singularity {
  /** Vertex id for a face field, triangle id for a vertex field. */
  readonly at: number;
  /** Index in quarter turns; never 0. */
  readonly index: number;
}

/**
 * A position field (4-PoSy, Instant Meshes): at each vertex a local quad lattice with spacing
 * `scale`, axes {q, n x q} from the vertex-site `orientation`, and origin `origin` (a point in the
 * tangent plane of the vertex). Lattice points are origin + scale * (a q + b (n x q)), a, b integers.
 */
export interface PositionField {
  readonly orientation: CrossField;
  /** Target edge length of the quad lattice, in mesh units. */
  readonly scale: number;
  /** Lattice origin per vertex, 3 numbers per vertex. */
  readonly origin: Float64Array;
  /**
   * Input vertex id per field-mesh vertex. The field mesh may cut the input open along creases, one
   * copy per smooth sector with its own normal; copies share a source and are coupled like
   * neighbours, so their lattices agree across the crease.
   */
  readonly vertexSource: Uint32Array;
}

/** Rotation k in 0..3: the k-th quarter turn of `b`'s cross best matches `a`'s representative. */
export type QuarterTurn = 0 | 1 | 2 | 3;

function at(values: Float64Array, site: number): [number, number, number] {
  const o = 3 * site;
  return [values[o] as number, values[o + 1] as number, values[o + 2] as number];
}

/** The k-th quarter turn of q about n: q, n x q, -q, -(n x q). */
export function rotateQuarter(
  q: readonly [number, number, number],
  n: readonly [number, number, number],
  k: number,
): [number, number, number] {
  const t: [number, number, number] = [
    n[1] * q[2] - n[2] * q[1],
    n[2] * q[0] - n[0] * q[2],
    n[0] * q[1] - n[1] * q[0],
  ];
  switch (((k % 4) + 4) % 4) {
    case 0:
      return [q[0], q[1], q[2]];
    case 1:
      return t;
    case 2:
      return [-q[0], -q[1], -q[2]];
    default:
      return [-t[0], -t[1], -t[2]];
  }
}

/**
 * Extrinsic 4-RoSy matching of Jakob et al. 2015 (compat_orientation_extrinsic_4): the quarter turn
 * of site b whose representative has the largest dot product with site a's representative, compared
 * across both of a's axes. `a` is the turn applied to site a (0 or 1), `b` the turn applied to site b.
 */
export function matchExtrinsic(
  field: CrossField,
  a: number,
  b: number,
): { readonly a: QuarterTurn; readonly b: QuarterTurn } {
  const qa = at(field.direction, a);
  const na = at(field.normal, a);
  const qb = at(field.direction, b);
  const nb = at(field.normal, b);
  const A = [qa, rotateQuarter(qa, na, 1)] as const;
  const B = [qb, rotateQuarter(qb, nb, 1)] as const;
  let best = -Infinity;
  let ka: QuarterTurn = 0;
  let kb: QuarterTurn = 0;
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      const ai = A[i] as [number, number, number];
      const bj = B[j] as [number, number, number];
      const d = ai[0] * bj[0] + ai[1] * bj[1] + ai[2] * bj[2];
      if (Math.abs(d) > best) {
        best = Math.abs(d);
        ka = i as QuarterTurn;
        kb = (d < 0 ? j + 2 : j) as QuarterTurn;
      }
    }
  return { a: ka, b: kb };
}

type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function axpy(o: Vec3, a: Vec3, sa: number, b: Vec3, sb: number): [number, number, number] {
  return [o[0] + a[0] * sa + b[0] * sb, o[1] + a[1] * sa + b[1] * sb, o[2] + a[2] * sa + b[2] * sb];
}

/**
 * Jakob et al. 2015 middle_point: the point midway between p0 and p1 corrected toward the
 * intersection of their tangent planes, so lattices on a curved surface are compared where both
 * tangent planes are close to the surface. The 1e-4 regularizer keeps parallel normals finite.
 */
export function middlePoint(p0: Vec3, n0: Vec3, p1: Vec3, n1: Vec3): [number, number, number] {
  const n0p0 = dot(n0, p0);
  const n0p1 = dot(n0, p1);
  const n1p0 = dot(n1, p0);
  const n1p1 = dot(n1, p1);
  const n0n1 = dot(n0, n1);
  const denom = 1 / (1 - n0n1 * n0n1 + 1e-4);
  const l0 = 2 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * denom;
  const l1 = 2 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * denom;
  return [
    0.5 * (p0[0] + p1[0]) - 0.25 * (n0[0] * l0 + n1[0] * l1),
    0.5 * (p0[1] + p1[1]) - 0.25 * (n0[1] * l0 + n1[1] * l1),
    0.5 * (p0[2] + p1[2]) - 0.25 * (n0[2] * l0 + n1[2] * l1),
  ];
}

/** Integer lattice index (a, b) of p in the lattice {o + scale (a q + b (n x q))}, rounded down. */
export function positionFloorIndex(
  o: Vec3,
  q: Vec3,
  n: Vec3,
  p: Vec3,
  scale: number,
): [number, number] {
  const t = rotateQuarter(q, n, 1);
  const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return [Math.floor(dot(q, d) / scale), Math.floor(dot(t, d) / scale)];
}

/** The lattice point at index (a, b): o + scale (a q + b (n x q)). */
export function latticePoint(
  o: Vec3,
  q: Vec3,
  n: Vec3,
  index: readonly [number, number],
  scale: number,
): [number, number, number] {
  return axpy(o, q, index[0] * scale, rotateQuarter(q, n, 1), index[1] * scale);
}

/** Jakob et al. 2015 position_round_4: the lattice point nearest p's tangent-plane projection. */
export function positionRound(
  o: Vec3,
  q: Vec3,
  n: Vec3,
  p: Vec3,
  scale: number,
): [number, number, number] {
  const t = rotateQuarter(q, n, 1);
  const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return latticePoint(
    o,
    q,
    n,
    [Math.round(dot(q, d) / scale), Math.round(dot(t, d) / scale)],
    scale,
  );
}

/** Real-valued lattice coordinates of p in vertex v's lattice: (p - o) . (q, n x q) / scale. */
export function latticeCoordinates(field: PositionField, v: number, p: Vec3): [number, number] {
  const o = at(field.origin, v);
  const q = at(field.orientation.direction, v);
  const t = rotateQuarter(q, at(field.orientation.normal, v), 1);
  const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return [dot(q, d) / field.scale, dot(t, d) / field.scale];
}

export interface PositionMatch {
  /** Lattice point of vertex i nearest the shared middle point. */
  readonly pi: [number, number, number];
  /** Lattice point of vertex j matched to `pi`. */
  readonly pj: [number, number, number];
  /** Squared distance between `pi` and `pj`; zero when the two lattices agree. */
  readonly error: number;
  /**
   * Integer offset from origin i to origin j in vertex i's frame {q_i, n_i x q_i}, after j's cross
   * is rotated onto i's: (0, 0) means both origins are the same lattice point, a unit offset means
   * they are lattice neighbours (Instant Meshes extraction).
   */
  readonly offset: readonly [number, number];
}

/**
 * Extrinsic 4-PoSy matching of Jakob et al. 2015 (compat_position_extrinsic_index_4): both
 * lattices are floored at the middle point, then the closest pair among the 4 x 4 cell corners is
 * taken. Vertex j's cross is first rotated to match i's so that index offsets share one frame.
 */
export function matchPosition(field: PositionField, i: number, j: number): PositionMatch {
  // Compute each undirected pair once with the lower index first, so that both ends of an edge
  // agree on corner ties; the reverse direction is the negated, swapped result.
  if (i > j) {
    const m = matchPositionOrdered(field, j, i);
    return {
      pi: m.pj,
      pj: m.pi,
      error: m.error,
      offset: [-m.offset[0], -m.offset[1]],
    };
  }
  return matchPositionOrdered(field, i, j);
}

function matchPositionOrdered(field: PositionField, i: number, j: number): PositionMatch {
  const cross = field.orientation;
  const s = field.scale;
  const ni = at(cross.normal, i);
  const nj = at(cross.normal, j);
  const turn = matchExtrinsic(cross, i, j);
  const qi = rotateQuarter(at(cross.direction, i), ni, turn.a);
  const qj = rotateQuarter(at(cross.direction, j), nj, turn.b);
  const oi = at(field.origin, i);
  const oj = at(field.origin, j);
  const middle = middlePoint(at(cross.mesh.positions, i), ni, at(cross.mesh.positions, j), nj);
  const fi = positionFloorIndex(oi, qi, ni, middle, s);
  const fj = positionFloorIndex(oj, qj, nj, middle, s);
  let best = Infinity;
  let bi: [number, number] = fi;
  let bj: [number, number] = fj;
  for (let ci = 0; ci < 4; ci++) {
    const ii: [number, number] = [fi[0] + (ci & 1), fi[1] + (ci >> 1)];
    const pi = latticePoint(oi, qi, ni, ii, s);
    for (let cj = 0; cj < 4; cj++) {
      const jj: [number, number] = [fj[0] + (cj & 1), fj[1] + (cj >> 1)];
      const pj = latticePoint(oj, qj, nj, jj, s);
      const dx = pi[0] - pj[0];
      const dy = pi[1] - pj[1];
      const dz = pi[2] - pj[2];
      const e = dx * dx + dy * dy + dz * dz;
      if (e < best) {
        best = e;
        bi = ii;
        bj = jj;
      }
    }
  }
  // Index offsets are in i's frame after the turn; map them back to the stored representative q_i.
  const raw: [number, number] = [bi[0] - bj[0], bi[1] - bj[1]];
  return {
    pi: latticePoint(oi, qi, ni, bi, s),
    pj: latticePoint(oj, qj, nj, bj, s),
    error: best,
    offset: turn.a === 1 ? [-raw[1], raw[0]] : raw,
  };
}
