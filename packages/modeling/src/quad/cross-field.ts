// Feature-aligned smoothest cross field (M3): Knoeppel, Crane, Pinkall, Schroeder, "Globally Optimal
// Direction Fields", ACM TOG 32(4):59, 2013. A 4-direction field is stored as its 4th power u = z^4
// per triangle, so the four directions become one complex number and smoothness becomes the quadratic
// energy E(u) = sum over interior edges |u_g - r_fg u_f|^2, where r_fg is the 4th power of the
// Levi-Civita transport across the shared edge. Face-based discretization with unit dual-edge weights
// and triangle-area mass. Without constraints u is the smallest eigenvector of A u = lambda M u
// (inverse power iteration). With feature constraints the feature triangles hold u = (edge direction)^4
// and the free triangles minimize E with those values fixed (one linear solve).

import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { CrossField, Singularity } from './field';
import { conjugateGradient, dotN, multiply, Triplets } from './sparse';
import {
  angleDefects,
  cross3,
  dot3,
  type FeatureOptions,
  faceAreas,
  faceNormals,
  featureEdges,
  headOf,
  prevHalfedge,
  sub3,
  type TriMesh,
  type TriTopology,
  triTopology,
  unit3,
  type Vec3,
  vec,
} from './trimesh';

export interface CrossFieldOptions extends FeatureOptions {
  /** Hold feature triangles at their edge direction (default true). `false` is the M3 falsifier. */
  readonly constrain?: boolean;
  /** Inverse power iterations for unconstrained components (default 300). */
  readonly maxEigenIterations?: number;
  /**
   * Curvature alignment weight w > 0 (default off), Knoeppel et al. sections 5 and 6.1.2: solve
   * (A - lambda_t M) u = M psi with lambda_t = -w / (total area) and psi the squared Hopf differential
   * (trace-free shape operator, Cohen-Steiner and Morvan edge dihedrals), M-normalized. Larger w
   * follows principal curvature directions more closely; umbilic regions (psi = 0) stay smoothest.
   */
  readonly curvatureAlignment?: number;
  /**
   * Opt-in extra Dirichlet pins, called once on the refined mesh (after conflict splitting, so triangle
   * ids are those of `field.mesh`). Each returned direction is projected into its triangle's plane and
   * held there mod 90 deg, exactly like a feature triangle; feature triangles keep their edge direction.
   * A direction with no in-plane part fails closed (`model-partial`, reason `pin-degenerate`); a
   * returned error is passed through unchanged.
   */
  readonly pinTriangles?: (
    mesh: TriMesh,
    topology: TriTopology,
  ) => Result<ReadonlyMap<number, Vec3>, ModelingError>;
}

export interface CrossFieldReport {
  /** Triangles split 1-to-3 at their centroid because two of their feature edges disagree mod 90 deg. */
  readonly splitTriangles: number;
  readonly featureEdges: number;
  readonly constrainedTriangles: number;
  readonly components: number;
  readonly solves: readonly {
    readonly kind: Solve['kind'];
    readonly triangles: number;
    readonly iterations: number;
    readonly residual: number;
  }[];
  /** E(u) for the normalized field. */
  readonly energy: number;
  readonly chi: number | null;
  readonly indexSum: number | null;
  /** Largest |index - nearest integer| before rounding (quarter turns); the rounding is validated against this. */
  readonly indexRounding: number;
  /** Angle between the field and each feature edge, over the triangles beside that edge (radians, mod 90 deg). */
  readonly featureAngleError: { readonly max: number; readonly samples: number };
}

export interface CrossFieldResult {
  readonly field: CrossField;
  readonly report: CrossFieldReport;
}

/** Index rounding tolerance in quarter turns; larger means the solve or the topology is wrong. */
const INDEX_TOLERANCE = 1e-6;
/** Two feature directions agree in a triangle when their 4th powers differ by at most this. */
const AGREE = 1e-9;

type Complex = [number, number];

function cmul(a: Complex, b: Complex): Complex {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

function conj(a: Complex): Complex {
  return [a[0], -a[1]];
}

function pow4(a: Complex): Complex {
  const s = cmul(a, a);
  return cmul(s, s);
}

/** Principal square root of a unit complex number, without cancellation near -1 or +1. */
function sqrtUnit(z: Complex): Complex {
  if (z[0] >= 0) {
    const c = Math.sqrt((1 + z[0]) / 2);
    return [c, z[1] / (2 * c)];
  }
  const s = Math.sqrt((1 - z[0]) / 2);
  return [Math.abs(z[1]) / (2 * s), z[1] < 0 ? -s : s];
}

interface Frames {
  readonly normal: Float64Array;
  readonly e1: Float64Array;
  readonly e2: Float64Array;
}

function framesOf(mesh: TriMesh): Frames {
  const normal = faceNormals(mesh);
  const faces = mesh.triangles.length / 3;
  const e1 = new Float64Array(3 * faces);
  const e2 = new Float64Array(3 * faces);
  for (let t = 0; t < faces; t++) {
    const a = vec(mesh.positions, mesh.triangles[3 * t] as number);
    const b = vec(mesh.positions, mesh.triangles[3 * t + 1] as number);
    const x = unit3(sub3(b, a));
    e1.set(x, 3 * t);
    e2.set(cross3(vec(normal, t), x), 3 * t);
  }
  return { normal, e1, e2 };
}

/** Coordinates of a 3D vector in the frame of triangle t. */
function inFrame(frames: Frames, t: number, v: Vec3): Complex {
  return [dot3(v, vec(frames.e1, t)), dot3(v, vec(frames.e2, t))];
}

function edgeUnit(mesh: TriMesh, h: number): Vec3 {
  return unit3(
    sub3(vec(mesh.positions, headOf(mesh, h)), vec(mesh.positions, mesh.triangles[h] as number)),
  );
}

/** Split every triangle whose feature edges disagree mod 90 deg; returns the input when none does. */
function splitConflicts(
  mesh: TriMesh,
  marks: Uint8Array,
): { mesh: TriMesh; split: number; features: [number, number][] } {
  const faces = mesh.triangles.length / 3;
  const features: [number, number][] = [];
  const conflicted = new Uint8Array(faces);
  let split = 0;
  for (let t = 0; t < faces; t++) {
    let first: Vec3 | null = null;
    for (let k = 0; k < 3; k++) {
      const h = 3 * t + k;
      if (marks[h] !== 1) continue;
      features.push([mesh.triangles[h] as number, headOf(mesh, h)]);
      const e = edgeUnit(mesh, h);
      if (first === null) {
        first = e;
        continue;
      }
      const n = cross3(first, e);
      const w = pow4([dot3(first, e), Math.sqrt(dot3(n, n))]);
      if (Math.abs(w[0] - 1) + Math.abs(w[1]) > AGREE) conflicted[t] = 1;
    }
    if (conflicted[t] === 1) split++;
  }
  if (split === 0) return { mesh, split, features };
  const positions = Array.from(mesh.positions);
  const triangles: number[] = [];
  for (let t = 0; t < faces; t++) {
    const a = mesh.triangles[3 * t] as number,
      b = mesh.triangles[3 * t + 1] as number,
      c = mesh.triangles[3 * t + 2] as number;
    if (conflicted[t] !== 1) {
      triangles.push(a, b, c);
      continue;
    }
    const m = positions.length / 3;
    for (let k = 0; k < 3; k++)
      positions.push(
        ((positions[3 * a + k] as number) +
          (positions[3 * b + k] as number) +
          (positions[3 * c + k] as number)) /
          3,
      );
    triangles.push(a, b, m, b, c, m, c, a, m);
  }
  return {
    mesh: { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) },
    split,
    features,
  };
}

interface Connection {
  /** 4th power of the transport from face(h) to face(twin h), per interior half-edge. */
  readonly r: Float64Array;
}

function connectionOf(mesh: TriMesh, topo: TriTopology, frames: Frames): Connection {
  const r = new Float64Array(2 * topo.twin.length);
  for (let h = 0; h < topo.twin.length; h++) {
    const o = topo.twin[h] as number;
    if (o === -1) continue;
    const e = edgeUnit(mesh, h);
    const cf = inFrame(frames, Math.floor(h / 3), e);
    const cg = inFrame(frames, Math.floor(o / 3), e);
    const t = pow4(cmul(cg, conj(cf)));
    r[2 * h] = t[0];
    r[2 * h + 1] = t[1];
  }
  return { r };
}

function transport(c: Connection, h: number): Complex {
  return [c.r[2 * h] as number, c.r[2 * h + 1] as number];
}

/** Connected components of the triangle adjacency graph. */
function componentsOf(topo: TriTopology): Int32Array {
  const label = new Int32Array(topo.faceCount).fill(-1);
  let next = 0;
  for (let s = 0; s < topo.faceCount; s++) {
    if (label[s] !== -1) continue;
    const stack = [s];
    label[s] = next;
    while (stack.length > 0) {
      const t = stack.pop() as number;
      for (let k = 0; k < 3; k++) {
        const o = topo.twin[3 * t + k] as number;
        if (o === -1) continue;
        const g = Math.floor(o / 3);
        if (label[g] === -1) {
          label[g] = next;
          stack.push(g);
        }
      }
    }
    next++;
  }
  return label;
}

interface Solve {
  readonly kind: 'eigen' | 'dirichlet' | 'aligned';
  readonly triangles: number;
  readonly iterations: number;
  readonly residual: number;
}

/**
 * Solve one component. `u` holds the fixed values on entry (fixed[t] = 1) and receives the free ones.
 * The Hermitian system is solved in its real symmetric form: complex entry p + iq becomes [[p, -q], [q, p]].
 */
function solveComponent(
  topo: TriTopology,
  conn: Connection,
  areas: Float64Array,
  members: readonly number[],
  fixed: Uint8Array,
  u: Float64Array,
  maxEigen: number,
  align: Alignment | null,
): Result<Solve, ModelingError> {
  const local = new Map<number, number>();
  for (const t of members) if (fixed[t] !== 1) local.set(t, local.size);
  const n = local.size;
  const constrained = members.length !== n;
  if (n === 0) return ok({ kind: 'dirichlet', triangles: 0, iterations: 0, residual: 0 });
  const a = new Triplets(2 * n);
  const b = new Float64Array(2 * n);
  const addComplex = (i: number, j: number, p: number, q: number) => {
    a.add(2 * i, 2 * j, p);
    a.add(2 * i, 2 * j + 1, -q);
    a.add(2 * i + 1, 2 * j, q);
    a.add(2 * i + 1, 2 * j + 1, p);
  };
  for (const f of members) {
    for (let k = 0; k < 3; k++) {
      const h = 3 * f + k;
      const o = topo.twin[h] as number;
      if (o === -1) continue;
      const g = Math.floor(o / 3);
      const i = local.get(f);
      // Row of f: |u_f - conj(r_fg) u_g|^2 has the same value as the g-row form; each edge adds w to
      // both diagonals and -w conj(r_fg) at (f, g).
      if (i === undefined) continue;
      addComplex(i, i, 1, 0);
      const r = conj(transport(conn, h));
      const j = local.get(g);
      if (j !== undefined) addComplex(i, j, -r[0], -r[1]);
      else {
        const v = cmul(r, [u[2 * g] as number, u[2 * g + 1] as number]);
        b[2 * i] = (b[2 * i] as number) + v[0];
        b[2 * i + 1] = (b[2 * i + 1] as number) + v[1];
      }
    }
  }
  const aligned = align !== null && hasGuidance(align.psi, local);
  if (align !== null && aligned) {
    for (const [f, i] of local) {
      const m = areas[f] as number;
      addComplex(i, i, -align.lambda * m, 0);
      b[2 * i] = (b[2 * i] as number) + m * (align.psi[2 * f] as number);
      b[2 * i + 1] = (b[2 * i + 1] as number) + m * (align.psi[2 * f + 1] as number);
    }
  }
  if (constrained || aligned) {
    const solved = conjugateGradient(a.build(), b, { tolerance: 1e-13 });
    if (!solved.ok) return solved;
    for (const [t, i] of local) {
      u[2 * t] = solved.value.x[2 * i] as number;
      u[2 * t + 1] = solved.value.x[2 * i + 1] as number;
    }
    return ok({
      kind: constrained ? 'dirichlet' : 'aligned',
      triangles: n,
      iterations: solved.value.iterations,
      residual: solved.value.residual,
    });
  }
  return inversePower(a, areas, local, u, maxEigen);
}

function hasGuidance(psi: Float64Array, local: Map<number, number>): boolean {
  for (const t of local.keys()) if (psi[2 * t] !== 0 || psi[2 * t + 1] !== 0) return true;
  return false;
}

interface Alignment {
  /** lambda_t < 0. */
  readonly lambda: number;
  /** Guidance per triangle (complex, 2 numbers per triangle). */
  readonly psi: Float64Array;
}

/**
 * Face-based Hopf differential (Knoeppel et al. 6.1.2 with Cohen-Steiner and Morvan 2003): each
 * interior edge contributes -(1/2) theta_e |e| (edge direction)^2 to both adjacent triangles, divided by
 * the triangle area (M q = q~); for 4-direction fields the guidance is q^2, M-normalized to 1.
 * Returns null for a developable mesh (q = 0 everywhere).
 */
function curvatureGuidance(
  mesh: TriMesh,
  topo: TriTopology,
  frames: Frames,
  areas: Float64Array,
): Float64Array | null {
  const psi = new Float64Array(2 * topo.faceCount);
  for (let h = 0; h < topo.twin.length; h++) {
    const o = topo.twin[h] as number;
    if (o === -1) continue;
    const f = Math.floor(h / 3);
    const g = Math.floor(o / 3);
    const e = sub3(
      vec(mesh.positions, headOf(mesh, h)),
      vec(mesh.positions, mesh.triangles[h] as number),
    );
    const length = Math.sqrt(dot3(e, e));
    const nf = vec(frames.normal, f);
    const ng = vec(frames.normal, g);
    const theta = atan2(dot3(cross3(nf, ng), e) / length, dot3(nf, ng));
    const c = inFrame(frames, f, unit3(e));
    const sq = cmul(c, c);
    const w = (-0.5 * theta * length) / (areas[f] as number);
    psi[2 * f] = (psi[2 * f] as number) + w * sq[0];
    psi[2 * f + 1] = (psi[2 * f + 1] as number) + w * sq[1];
  }
  let norm = 0;
  for (let t = 0; t < topo.faceCount; t++) {
    const q = cmul(
      [psi[2 * t] as number, psi[2 * t + 1] as number],
      [psi[2 * t] as number, psi[2 * t + 1] as number],
    );
    psi[2 * t] = q[0];
    psi[2 * t + 1] = q[1];
    norm += (areas[t] as number) * (q[0] * q[0] + q[1] * q[1]);
  }
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < psi.length; i++) psi[i] = (psi[i] as number) * inv;
  return psi;
}

/** Inverse power iteration (A + eps M) x_{k+1} = M x_k for the smallest eigenvector of A u = lambda M u. */
function inversePower(
  a: Triplets,
  areas: Float64Array,
  local: Map<number, number>,
  u: Float64Array,
  maxEigen: number,
): Result<Solve, ModelingError> {
  const n = local.size;
  const mass = new Float64Array(2 * n);
  let massSum = 0;
  for (const [t, i] of local) {
    mass[2 * i] = areas[t] as number;
    mass[2 * i + 1] = areas[t] as number;
    massSum += areas[t] as number;
  }
  // Shift so A + eps M is positive definite even when the smallest eigenvalue is 0 (flat holonomy).
  const plain = a.build();
  let trace = 0;
  for (let r = 0; r < plain.n; r++)
    for (let k = plain.rowStart[r] as number; k < (plain.rowStart[r + 1] as number); k++)
      if (plain.col[k] === r) trace += plain.value[k] as number;
  const eps = (1e-8 * trace) / (2 * massSum);
  for (let i = 0; i < 2 * n; i++) a.add(i, i, eps * (mass[i] as number));
  const shifted = a.build();
  // A start vector that shares the mesh's symmetry stays in that invariant subspace and converges to
  // the wrong eigenvector (a UV sphere then gives two index-4 poles), so start from hashed noise.
  let x: Float64Array = new Float64Array(2 * n);
  let state = 0x9e3779b9;
  for (let i = 0; i < 2 * n; i++) {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) ^ i;
    state = Math.imul(state ^ (state >>> 12), 0x297a2d39);
    x[i] = ((state >>> 0) / 4294967296) * 2 - 1;
  }
  const normalize = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < v.length; i++)
      s += (mass[i] as number) * (v[i] as number) * (v[i] as number);
    const inv = 1 / Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) * inv;
  };
  normalize(x);
  const ax = new Float64Array(2 * n);
  let iterations = 0;
  let residual = Infinity;
  for (; iterations < maxEigen; iterations++) {
    const rhs = new Float64Array(2 * n);
    for (let i = 0; i < 2 * n; i++) rhs[i] = (mass[i] as number) * (x[i] as number);
    const solved = conjugateGradient(shifted, rhs, { tolerance: 1e-12, x0: x });
    if (!solved.ok) return solved;
    x = solved.value.x;
    normalize(x);
    multiply(plain, x, ax);
    const lambda = dotN(x, ax);
    let r2 = 0;
    let a2 = 0;
    for (let i = 0; i < 2 * n; i++) {
      const d = (ax[i] as number) - lambda * (mass[i] as number) * (x[i] as number);
      r2 += d * d;
      a2 += (ax[i] as number) * (ax[i] as number);
    }
    residual = Math.sqrt(r2 / Math.max(a2, Number.MIN_VALUE));
    if (residual <= 1e-8) {
      iterations++;
      break;
    }
  }
  for (const [t, i] of local) {
    u[2 * t] = x[2 * i] as number;
    u[2 * t + 1] = x[2 * i + 1] as number;
  }
  return ok({ kind: 'eigen', triangles: n, iterations, residual });
}

/** Smoothest feature-aligned cross field on a closed or open triangle mesh. */
export function crossField(
  input: TriMesh,
  options: CrossFieldOptions = {},
): Result<CrossFieldResult, ModelingError> {
  const inputTopo = triTopology(input);
  if (!inputTopo.ok) return inputTopo;
  const inputMarks = featureEdges(input, inputTopo.value, options);
  if (!inputMarks.ok) return inputMarks;
  const constrain = options.constrain ?? true;
  const refined = constrain
    ? splitConflicts(input, inputMarks.value)
    : { mesh: input, split: 0, features: [] };
  const mesh = refined.mesh;
  const topoR = refined.split === 0 ? inputTopo : triTopology(mesh);
  if (!topoR.ok) return topoR;
  const topo = topoR.value;
  let featureMarks = inputMarks.value;
  if (refined.split > 0) {
    // Dihedral detection is off (180 deg) so the split triangles' new inner edges never become features.
    const carried = featureEdges(mesh, topo, { sharpDegrees: 180, edges: refined.features });
    if (!carried.ok) return carried;
    featureMarks = carried.value;
  }
  const frames = framesOf(mesh);
  const conn = connectionOf(mesh, topo, frames);
  const areas = faceAreas(mesh);
  const faces = topo.faceCount;
  const u = new Float64Array(2 * faces);
  const fixed = new Uint8Array(faces);
  let featureCount = 0;
  for (let h = 0; h < featureMarks.length; h++) {
    if (featureMarks[h] !== 1) continue;
    const o = topo.twin[h] as number;
    if (o === -1 || h < o) featureCount++;
    const t = Math.floor(h / 3);
    if (!constrain || fixed[t] === 1) continue;
    const c = pow4(inFrame(frames, t, edgeUnit(mesh, h)));
    u[2 * t] = c[0];
    u[2 * t + 1] = c[1];
    fixed[t] = 1;
  }
  if (constrain && options.pinTriangles !== undefined) {
    const pins = options.pinTriangles(mesh, topo);
    if (!pins.ok) return pins;
    for (const [t, direction] of pins.value) {
      if (!(t >= 0 && t < faces) || fixed[t] === 1) continue;
      const d = inFrame(frames, t, direction);
      const m = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      if (!(m > 1e-9))
        return err(
          modelingError('model-partial', 'a pinned direction with an in-plane part', {
            reason: 'pin-degenerate',
            triangle: t,
          }),
        );
      const c = pow4([d[0] / m, d[1] / m]);
      u[2 * t] = c[0];
      u[2 * t + 1] = c[1];
      fixed[t] = 1;
    }
  }
  const label = componentsOf(topo);
  const groups = new Map<number, number[]>();
  for (let t = 0; t < faces; t++) {
    const g = groups.get(label[t] as number);
    if (g === undefined) groups.set(label[t] as number, [t]);
    else g.push(t);
  }
  const weight = options.curvatureAlignment;
  if (weight !== undefined && !(weight > 0 && Number.isFinite(weight)))
    return err(
      modelingError('model-invalid-argument', 'curvatureAlignment is a finite number > 0', {
        reason: 'bad-curvature-alignment',
        curvatureAlignment: weight,
      }),
    );
  let align: Alignment | null = null;
  if (weight !== undefined) {
    const psi = curvatureGuidance(mesh, topo, frames, areas);
    const total = areas.reduce((s, x) => s + x, 0);
    if (psi !== null) align = { lambda: -weight / total, psi };
  }
  const solves: Solve[] = [];
  for (const members of groups.values()) {
    const s = solveComponent(
      topo,
      conn,
      areas,
      members,
      fixed,
      u,
      options.maxEigenIterations ?? 300,
      align,
    );
    if (!s.ok) return s;
    solves.push(s.value);
  }
  for (let t = 0; t < faces; t++) {
    const m = Math.sqrt(
      (u[2 * t] as number) * (u[2 * t] as number) +
        (u[2 * t + 1] as number) * (u[2 * t + 1] as number),
    );
    if (!(m > 1e-300))
      return err(
        modelingError('model-partial', 'a nonzero field on every triangle', {
          reason: 'zero-field',
          face: t,
        }),
      );
    u[2 * t] = (u[2 * t] as number) / m;
    u[2 * t + 1] = (u[2 * t + 1] as number) / m;
  }
  const singular = singularitiesOf(mesh, topo, conn, u);
  if (!singular.ok) return singular;
  const direction = new Float64Array(3 * faces);
  for (let t = 0; t < faces; t++) {
    const z = sqrtUnit(sqrtUnit([u[2 * t] as number, u[2 * t + 1] as number]));
    for (let k = 0; k < 3; k++)
      direction[3 * t + k] =
        z[0] * (frames.e1[3 * t + k] as number) + z[1] * (frames.e2[3 * t + k] as number);
  }
  let energy = 0;
  for (let h = 0; h < topo.twin.length; h++) {
    const o = topo.twin[h] as number;
    if (o === -1 || o < h) continue;
    const f = Math.floor(h / 3);
    const g = Math.floor(o / 3);
    const ru = cmul(transport(conn, h), [u[2 * f] as number, u[2 * f + 1] as number]);
    const d0 = (u[2 * g] as number) - ru[0];
    const d1 = (u[2 * g + 1] as number) - ru[1];
    energy += d0 * d0 + d1 * d1;
  }
  const field: CrossField = {
    site: 'face',
    mesh,
    normal: frames.normal,
    direction,
    fixed,
    singularities: singular.value.singularities,
  };
  const featureAngleError = featureAngleErrorOf(field, featureMarks);
  if (topo.closed && singular.value.indexSum !== 4 * topo.chi)
    return err(
      modelingError('model-partial', 'singularity indices summing to 4 chi', {
        reason: 'index-sum',
        indexSum: singular.value.indexSum,
        chi: topo.chi,
      }),
    );
  return ok({
    field,
    report: {
      splitTriangles: refined.split,
      featureEdges: featureCount,
      constrainedTriangles: fixed.reduce((s, x) => s + x, 0),
      components: groups.size,
      solves,
      energy,
      chi: topo.closed ? topo.chi : null,
      indexSum: topo.closed ? singular.value.indexSum : null,
      indexRounding: singular.value.rounding,
      featureAngleError,
    },
  });
}

/**
 * Index of each interior vertex in quarter turns: (sum over its CCW triangle ring of the field's
 * rotation relative to transport, in 4th-power space, + 4 * angle defect) / 2 pi. It is an integer
 * up to rounding; a value farther than INDEX_TOLERANCE from an integer fails closed.
 */
function singularitiesOf(
  mesh: TriMesh,
  topo: TriTopology,
  conn: Connection,
  u: Float64Array,
): Result<{ singularities: Singularity[]; indexSum: number; rounding: number }, ModelingError> {
  const defects = angleDefects(mesh, topo);
  const singularities: Singularity[] = [];
  let indexSum = 0;
  let rounding = 0;
  for (let v = 0; v < topo.vertexCount; v++) {
    const start = topo.ringStart[v] as number;
    const end = topo.ringStart[v + 1] as number;
    if (topo.boundary[v] === 1 || start === end) continue;
    let sum = 0;
    for (let i = start; i < end; i++) {
      const h = topo.ring[i] as number;
      const across = prevHalfedge(h);
      const o = topo.twin[across] as number;
      const f = Math.floor(h / 3);
      const g = Math.floor(o / 3);
      const ru = cmul(transport(conn, across), [u[2 * f] as number, u[2 * f + 1] as number]);
      const d = cmul([u[2 * g] as number, u[2 * g + 1] as number], conj(ru));
      sum += atan2(d[1], d[0]);
    }
    const index = (sum + 4 * (defects[v] as number)) / (2 * Math.PI);
    const k = Math.round(index);
    rounding = Math.max(rounding, Math.abs(index - k));
    if (Math.abs(index - k) > INDEX_TOLERANCE)
      return err(
        modelingError('model-partial', 'integral singularity indices', {
          reason: 'index-not-integral',
          vertex: v,
          index,
        }),
      );
    if (k !== 0) singularities.push({ at: v, index: k });
    indexSum += k;
  }
  return ok({ singularities, indexSum, rounding });
}

/** Max angle (mod 90 deg) between the field and each feature edge, over the triangles beside it. */
export function featureAngleErrorOf(
  field: CrossField,
  marks: Uint8Array,
): { max: number; samples: number } {
  let max = 0;
  let samples = 0;
  for (let h = 0; h < marks.length; h++) {
    if (marks[h] !== 1) continue;
    const t = Math.floor(h / 3);
    const e = edgeUnit(field.mesh, h);
    const d = vec(field.direction, t);
    const w = pow4([dot3(d, e), dot3(cross3(e, d), vec(field.normal, t))]);
    max = Math.max(max, Math.abs(atan2(w[1], w[0])) / 4);
    samples++;
  }
  return { max, samples };
}
