import { err, ok, type Result } from '@forgeax/engine-types';
import { type FrameMode, type PathInput, pathFrames, samplePath } from './curve';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  add,
  axisIndex,
  axisVector,
  cross,
  dot,
  faceCentroid,
  facesVolume,
  length,
  newell,
  normalize,
  type SignedAxis,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { EDGE_SHARP, type EditMesh } from './mesh';
import {
  isClosed,
  type OpDiagnostic,
  type RoleCounts,
  requireFinite,
  requirePositive,
  requireSegments,
} from './ops';

/** Axis-aligned box `{ min, max }` in meters. */
export interface DeformBounds {
  readonly min: Tuple3;
  readonly max: Tuple3;
}

export interface LatticeOptions {
  /** Control points per axis, each 2 to 16 (degree = points - 1). */
  readonly resolution: readonly [number, number, number];
  /**
   * Lattice box (default: bounds of the deformed vertices). Vertices outside move with
   * the nearest point of the box, so the deformation stays continuous.
   */
  readonly bounds?: DeformBounds;
  /** Moves of individual control points `[i, j, k]` (x, y, z order) in meters. */
  readonly offsets: readonly {
    readonly index: readonly [number, number, number];
    readonly offset: Tuple3;
  }[];
}

export interface CageOptions {
  /** Rest cage: a closed, outward-facing polygon mesh around the deformed vertices. */
  readonly cage: {
    readonly points: readonly Tuple3[];
    readonly faces: readonly (readonly number[])[];
  };
  /** Moved cage points, one per rest point. */
  readonly deformed: readonly Tuple3[];
}

/** Shared parameterization of bend, twist and taper. */
export interface AxisRange {
  /** The axis the deformation runs along. */
  readonly axis: Axis;
  /** `[start, end]` along `axis` in meters (default: the extent of the deformed vertices). */
  readonly range?: readonly [number, number];
  /** Center of the cross section (default: the center of the deformed vertices' bounds). */
  readonly origin?: Tuple3;
}

export interface BendOptions extends AxisRange {
  /** The perpendicular direction the bent end curls toward. */
  readonly toward: SignedAxis;
  /** Total bend over the range, degrees (non-zero, within [-360, 360]). */
  readonly angle: number;
}

export interface TwistOptions extends AxisRange {
  /** Rotation reached at the end of the range, degrees (non-zero; right-handed about axis). */
  readonly angle: number;
}

export interface TaperOptions extends AxisRange {
  /** Cross-section scale at the end of the range (> 0, not 1); 1 at the start. */
  readonly factor: number;
  /** Perpendicular axes that scale (default both). */
  readonly axes?: readonly Axis[];
}

export interface CurveDeformOptions {
  readonly path: PathInput;
  /** Mesh axis laid along the path; the other two follow the path frame (cyclic order). */
  readonly axis: Axis;
  /** Mesh point mapped to the path start (default: bounds minimum along axis, center across). */
  readonly origin?: Tuple3;
  /** Frames along the path (default 'rmf'). */
  readonly frame?: FrameMode;
  readonly up?: Tuple3;
  /** Scale the length so the deformed extent along `axis` spans the whole path. */
  readonly stretch?: boolean;
}

export interface SmoothOptions {
  readonly iterations: number;
  /** Shrink factor (default 0.5, within (0, 1]). */
  readonly lambda?: number;
  /** Inflate factor (default -0.53, below -lambda). */
  readonly mu?: number;
  /** Keep mesh-boundary and sharp-edge vertices in place (both default true). */
  readonly pin?: { readonly boundary?: boolean; readonly sharp?: boolean };
}

const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

function finiteTuple(name: string, value: unknown): Result<Tuple3, ModelingError> {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((c) => typeof c === 'number' && Number.isFinite(c))
  ) {
    return invalid(`${name} is three finite numbers`, { [name]: value });
  }
  return ok(value as unknown as Tuple3);
}

function boundsOf(mesh: EditMesh, vertices: readonly number[]): DeformBounds {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return { min, max };
}

/**
 * A face whose canonical triangulation (the one export uses) fails or contains a
 * triangle turned against the face normal: export would reject it.
 */
export function faceFolded(mesh: EditMesh, f: number): boolean {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  const n = newell(points);
  const triangles = triangulateLoop(points);
  if (triangles === undefined) return true;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => points[triangles[i + k] as number] as Tuple3) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    if (dot(cross(sub(b, a), sub(c, a)), n) <= 0) return true;
  }
  return false;
}

/** Sign of the Jacobian determinant of a point map at p (central differences). */
function jacobianSign(map: (p: Tuple3) => Tuple3, p: Tuple3, h: number): number {
  const columns = [0, 1, 2].map((k) => {
    const a: Tuple3 = [...p];
    const b: Tuple3 = [...p];
    a[k] = (a[k] as number) + h;
    b[k] = (b[k] as number) - h;
    return sub(map(a), map(b));
  }) as [Tuple3, Tuple3, Tuple3];
  return Math.sign(dot(columns[0], cross(columns[1], columns[2])));
}

/** How a deformer moves vertices: a point map, or per-vertex positions (smoothing). */
export type Deformation =
  | { readonly kind: 'field'; readonly map: (p: Tuple3) => Tuple3 }
  | {
      readonly kind: 'positions';
      readonly position: (v: number) => Tuple3;
      /**
       * The direction a face normal should keep after the move (default: the normal
       * before), for solvers that rotate regions on purpose.
       */
      readonly orient?: (face: number, normal: Tuple3) => Tuple3;
    };

/**
 * Apply new positions to vertices, assert the effect and report it: the largest move
 * (`model-op-no-effect` when nothing moves farther than the tolerance), and as a
 * warning the faces turned inside out (a point map whose Jacobian determinant is not
 * positive at a face vertex; for per-vertex positions, a face normal that turns against
 * its `orient` direction, by default its direction before),
 * collapsed or folded so export would reject them.
 */
export function applyDeformation(
  mesh: EditMesh,
  op: string,
  vertices: readonly number[],
  deformation: Deformation,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  /** Facts gathered while computing the new positions, added to the report. */
  facts: () => Readonly<Record<string, unknown>> = () => ({}),
): Result<RoleCounts, ModelingError> {
  const moved = new Map<number, Tuple3>();
  let maxDisplacement = 0;
  let maxVertex = -1;
  for (const v of vertices) {
    const p = mesh.position(v);
    const q = deformation.kind === 'field' ? deformation.map(p) : deformation.position(v);
    if (!q.every(Number.isFinite)) {
      return err(
        modelingError('model-degenerate', `${op} yields finite positions`, {
          vertex: v,
          position: q,
        }),
      );
    }
    const d = length(sub(q, p));
    if (d > 0) moved.set(v, q);
    if (d > maxDisplacement) {
      maxDisplacement = d;
      maxVertex = v;
    }
  }
  const extra = facts();
  if (maxDisplacement <= tolerance) {
    return err(
      modelingError(
        'model-op-no-effect',
        `${op} moves at least one vertex farther than the tolerance`,
        { maxDisplacement, tolerance, vertices: vertices.length, ...extra },
        'check that the deformation range, offsets or angle reach the selected vertices',
      ),
    );
  }
  const touched = new Set<number>();
  for (const f of mesh.faces()) {
    if (mesh.faceVertices(f).some((v) => moved.has(v))) touched.add(f);
  }
  const reversed = new Set<number>();
  if (deformation.kind === 'field') {
    const box = boundsOf(mesh, vertices);
    const h = Math.max(tolerance, length(sub(box.max, box.min)) * 1e-5);
    for (const v of moved.keys()) {
      if (jacobianSign(deformation.map, mesh.position(v), h) <= 0) reversed.add(v);
    }
  }
  const before = new Map<number, Tuple3>();
  const foldedBefore = new Set<number>();
  for (const f of touched) {
    before.set(f, newell(mesh.faceVertices(f).map((v) => mesh.position(v))));
    if (faceFolded(mesh, f)) foldedBefore.add(f);
  }
  const closed = isClosed(mesh);
  const volumeBefore = closed ? facesVolume(mesh, mesh.faces()) : 0;
  for (const [v, q] of moved) mesh.setPosition(v, ...q);
  const inverted: number[] = [];
  const collapsed: number[] = [];
  const folded: number[] = [];
  for (const f of touched) {
    const n1 = newell(mesh.faceVertices(f).map((v) => mesh.position(v)));
    if (length(n1) / 2 <= tolerance * tolerance) collapsed.push(f);
    else if (
      deformation.kind === 'field'
        ? mesh.faceVertices(f).some((v) => reversed.has(v))
        : dot(
            deformation.orient === undefined
              ? (before.get(f) as Tuple3)
              : deformation.orient(f, before.get(f) as Tuple3),
            n1,
          ) <= 0
    )
      inverted.push(f);
    else if (!foldedBefore.has(f) && faceFolded(mesh, f)) folded.push(f);
  }
  diagnostics.push({
    severity: 'info',
    message: `${op} moved ${moved.size} vertices by up to ${maxDisplacement.toPrecision(4)} m`,
    detail: {
      maxDisplacement,
      at: mesh.position(maxVertex),
      movedVertices: moved.size,
      faces: touched.size,
      ...(closed ? { volumeBefore, volumeAfter: facesVolume(mesh, mesh.faces()) } : {}),
      ...extra,
    },
  });
  if (inverted.length + collapsed.length + folded.length > 0) {
    const flagged = [...inverted, ...collapsed, ...folded];
    diagnostics.push({
      severity: 'warn',
      message: `${op} inverted ${inverted.length}, collapsed ${collapsed.length} and folded ${folded.length} face(s)`,
      detail: {
        invertedFaces: inverted.slice(0, MAX_REPORTED),
        collapsedFaces: collapsed.slice(0, MAX_REPORTED),
        foldedFaces: folded.slice(0, MAX_REPORTED),
        at: flagged.slice(0, MAX_REPORTED).map((f) => faceCentroid(mesh, f)),
      },
    });
  }
  return ok({ moved: touched.size });
}

// ---- lattice (free-form deformation) -------------------------------------------------

function bernstein(degree: number, t: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= degree; i++) {
    let c = 1;
    for (let k = 1; k <= i; k++) c = (c * (degree - i + k)) / k;
    let term = c;
    for (let k = 0; k < i; k++) term *= t;
    for (let k = 0; k < degree - i; k++) term *= 1 - t;
    out.push(term);
  }
  return out;
}

/** Sederberg-Parry FFD: Bernstein weights of the point in the lattice box move it with the control points. */
export function lattice(
  mesh: EditMesh,
  vertices: readonly number[],
  options: LatticeOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const resolution = options.resolution;
  if (!Array.isArray(resolution) || resolution.length !== 3) {
    return invalid('resolution is [nx, ny, nz]', { resolution });
  }
  for (const n of resolution) {
    if (!Number.isInteger(n) || n < 2 || n > 16) {
      return invalid('each resolution entry is an integer from 2 to 16', { resolution });
    }
  }
  const box = options.bounds ?? boundsOf(mesh, vertices);
  const min = finiteTuple('bounds.min', box.min);
  if (!min.ok) return min;
  const max = finiteTuple('bounds.max', box.max);
  if (!max.ok) return max;
  if (!Array.isArray(options.offsets) || options.offsets.length === 0) {
    return invalid('offsets lists at least one moved control point', { offsets: options.offsets });
  }
  const [nx, ny, nz] = resolution as [number, number, number];
  const grid: {
    readonly i: number;
    readonly j: number;
    readonly k: number;
    readonly offset: Tuple3;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of options.offsets) {
    const [i, j, k] = entry.index ?? [];
    const inside = [i, j, k].every(
      (c, a) =>
        Number.isInteger(c) && (c as number) >= 0 && (c as number) < (resolution[a] as number),
    );
    if (!inside) return invalid('offset indices lie within the resolution', { index: entry.index });
    const offset = finiteTuple('offset', entry.offset);
    if (!offset.ok) return offset;
    const key = `${i},${j},${k}`;
    if (seen.has(key)) return invalid('each control point is offset once', { index: entry.index });
    seen.add(key);
    grid.push({ i: i as number, j: j as number, k: k as number, offset: offset.value });
  }
  const extent = [0, 1, 2].map((a) => (max.value[a] as number) - (min.value[a] as number));
  if (extent.some((e) => e < 0)) return invalid('bounds.min <= bounds.max', { bounds: box });
  const local = (p: Tuple3) =>
    [0, 1, 2].map((a) =>
      (extent[a] as number) <= tolerance
        ? 0.5
        : ((p[a] as number) - (min.value[a] as number)) / (extent[a] as number),
    );
  const outside = (t: readonly number[]) => t.some((x) => x < -1e-12 || x > 1 + 1e-12);
  const outsideCount = vertices.filter((v) => outside(local(mesh.position(v)))).length;
  return applyDeformation(
    mesh,
    'lattice',
    vertices,
    {
      kind: 'field',
      map: (p) => {
        const t = local(p).map((x) => Math.min(1, Math.max(0, x)));
        const bx = bernstein(nx - 1, t[0] as number);
        const by = bernstein(ny - 1, t[1] as number);
        const bz = bernstein(nz - 1, t[2] as number);
        const d: Tuple3 = [0, 0, 0];
        for (const { i, j, k, offset } of grid) {
          const w = (bx[i] as number) * (by[j] as number) * (bz[k] as number);
          d[0] += w * offset[0];
          d[1] += w * offset[1];
          d[2] += w * offset[2];
        }
        return add(p, d);
      },
    },
    tolerance,
    diagnostics,
    () => ({ resolution, outside: outsideCount }),
  );
}

// ---- cage (mean value coordinates) ---------------------------------------------------

function asin(x: number): number {
  const c = Math.min(1, Math.max(-1, x));
  return atan2(c, Math.sqrt(Math.max(0, 1 - c * c)));
}

/**
 * Mean value coordinates of `x` against a closed triangle cage; undefined when every triangle degenerates.
 */
export function meanValueWeights(
  x: Tuple3,
  points: readonly Tuple3[],
  triangles: readonly (readonly [number, number, number])[],
  epsilon: number,
): Float64Array | undefined {
  const weights = new Float64Array(points.length);
  const d = new Float64Array(points.length);
  const u: Tuple3[] = [];
  for (const [j, p] of points.entries()) {
    const r = sub(p, x);
    d[j] = length(r);
    if ((d[j] as number) < epsilon) {
      weights[j] = 1;
      return weights;
    }
    u.push(scale(r, 1 / (d[j] as number)));
  }
  let total = 0;
  for (const tri of triangles) {
    const uu = tri.map((j) => u[j] as Tuple3);
    const theta = [0, 1, 2].map(
      (i) => 2 * asin(length(sub(uu[(i + 1) % 3] as Tuple3, uu[(i + 2) % 3] as Tuple3)) / 2),
    );
    const h = ((theta[0] as number) + (theta[1] as number) + (theta[2] as number)) / 2;
    if (Math.PI - h < epsilon) {
      // x lies on this triangle: barycentric weights.
      weights.fill(0);
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        const w =
          sin(theta[i] as number) *
          (d[tri[(i + 2) % 3] as number] as number) *
          (d[tri[(i + 1) % 3] as number] as number);
        weights[tri[i] as number] = (weights[tri[i] as number] as number) + w;
        sum += w;
      }
      if (sum <= 0) return undefined;
      for (let j = 0; j < weights.length; j++) weights[j] = (weights[j] as number) / sum;
      return weights;
    }
    const c = [0, 1, 2].map(
      (i) =>
        (2 * sin(h) * sin(h - (theta[i] as number))) /
          (sin(theta[(i + 1) % 3] as number) * sin(theta[(i + 2) % 3] as number)) -
        1,
    );
    const det = dot(uu[0] as Tuple3, cross(uu[1] as Tuple3, uu[2] as Tuple3));
    const sign = det < 0 ? -1 : 1;
    const s = c.map((ci) => sign * Math.sqrt(Math.max(0, 1 - ci * ci)));
    if (s.some((si) => Math.abs(si) <= epsilon)) continue;
    for (let i = 0; i < 3; i++) {
      const prev = (i + 2) % 3;
      const next = (i + 1) % 3;
      const w =
        ((theta[i] as number) -
          (c[next] as number) * (theta[prev] as number) -
          (c[prev] as number) * (theta[next] as number)) /
        ((d[tri[i] as number] as number) * sin(theta[next] as number) * (s[prev] as number));
      weights[tri[i] as number] = (weights[tri[i] as number] as number) + w;
      total += w;
    }
  }
  if (!(Math.abs(total) > 0)) return undefined;
  for (let j = 0; j < weights.length; j++) weights[j] = (weights[j] as number) / total;
  return weights;
}

/** Deform vertices with a closed cage by mean value coordinates. */
export function cage(
  mesh: EditMesh,
  vertices: readonly number[],
  options: CageOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const points = options.cage?.points;
  const faces = options.cage?.faces;
  if (!Array.isArray(points) || points.length < 4 || !Array.isArray(faces) || faces.length < 4) {
    return invalid('cage has at least 4 points and 4 faces', {});
  }
  for (const p of points) {
    const checked = finiteTuple('cage point', p);
    if (!checked.ok) return checked;
  }
  if (!Array.isArray(options.deformed) || options.deformed.length !== points.length) {
    return invalid('deformed has one point per cage point', {
      points: points.length,
      deformed: options.deformed?.length,
    });
  }
  for (const p of options.deformed) {
    const checked = finiteTuple('deformed point', p);
    if (!checked.ok) return checked;
  }
  const directed = new Map<string, number>();
  const triangles: [number, number, number][] = [];
  for (const [index, face] of faces.entries()) {
    if (
      !Array.isArray(face) ||
      face.length < 3 ||
      !face.every((j) => Number.isInteger(j) && j >= 0 && j < points.length)
    ) {
      return invalid('cage faces list at least 3 valid point indices', { face: index });
    }
    for (let i = 0; i < face.length; i++) {
      const key = `${face[i]},${face[(i + 1) % face.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
    const local = triangulateLoop(face.map((j) => points[j] as Tuple3));
    if (local === undefined) {
      return err(
        modelingError('model-degenerate', 'every cage face can be triangulated', { face: index }),
      );
    }
    for (let i = 0; i < local.length; i += 3) {
      triangles.push([
        face[local[i] as number] as number,
        face[local[i + 1] as number] as number,
        face[local[i + 2] as number] as number,
      ]);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(',');
    if (count !== 1 || directed.get(`${b},${a}`) !== 1) {
      return err(
        modelingError(
          'model-precondition',
          'the cage is a closed, consistently oriented manifold',
          { edge: [Number(a), Number(b)] },
          'every cage edge must be used once in each direction',
        ),
      );
    }
  }
  let volume = 0;
  for (const [a, b, c] of triangles) {
    volume += dot(points[a] as Tuple3, cross(points[b] as Tuple3, points[c] as Tuple3)) / 6;
  }
  if (volume <= 0) {
    return err(
      modelingError(
        'model-precondition',
        'the cage faces point outward (positive volume)',
        { volume },
        'reverse the order of every cage face',
      ),
    );
  }
  let maxReproduction = 0;
  let failed: Tuple3 | undefined;
  const result = applyDeformation(
    mesh,
    'cage',
    vertices,
    {
      kind: 'field',
      map: (p) => {
        const w = meanValueWeights(p, points, triangles, tolerance * 1e-3);
        if (w === undefined) {
          failed = p;
          return p;
        }
        const rest: Tuple3 = [0, 0, 0];
        const moved: Tuple3 = [0, 0, 0];
        for (let j = 0; j < w.length; j++) {
          const wj = w[j] as number;
          const a = points[j] as Tuple3;
          const b = options.deformed[j] as Tuple3;
          for (let k = 0; k < 3; k++) {
            rest[k] = (rest[k] as number) + wj * (a[k] as number);
            moved[k] = (moved[k] as number) + wj * (b[k] as number);
          }
        }
        maxReproduction = Math.max(maxReproduction, length(sub(rest, p)));
        return moved;
      },
    },
    tolerance,
    diagnostics,
    () => ({ maxReproductionError: maxReproduction }),
  );
  if (failed !== undefined) {
    return err(
      modelingError('model-degenerate', 'mean value coordinates exist for every vertex', {
        position: failed,
      }),
    );
  }
  if (result.ok && maxReproduction > tolerance * 10) {
    diagnostics.push({
      severity: 'warn',
      message: `mean value coordinates reproduce rest positions only within ${maxReproduction.toPrecision(3)} m (a vertex lies outside or on the cage)`,
      detail: { maxReproductionError: maxReproduction },
    });
  }
  return result;
}

// ---- bend, twist, taper -----------------------------------------------------------------

interface ResolvedRange {
  readonly a: 0 | 1 | 2;
  readonly lo: number;
  readonly hi: number;
  readonly origin: Tuple3;
}

function resolveRange(
  mesh: EditMesh,
  vertices: readonly number[],
  options: AxisRange,
  tolerance: number,
): Result<ResolvedRange, ModelingError> {
  if (options.axis !== 'x' && options.axis !== 'y' && options.axis !== 'z') {
    return invalid("axis is 'x', 'y' or 'z'", { axis: options.axis });
  }
  const a = axisIndex(options.axis);
  const box = boundsOf(mesh, vertices);
  const center: Tuple3 = [0, 1, 2].map(
    (k) => ((box.min[k] as number) + (box.max[k] as number)) / 2,
  ) as Tuple3;
  const origin = options.origin === undefined ? ok(center) : finiteTuple('origin', options.origin);
  if (!origin.ok) return origin;
  const [lo, hi] = options.range ?? [box.min[a] as number, box.max[a] as number];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo <= tolerance) {
    return invalid('range is [start, end] with start < end', {
      range: options.range,
      extent: [box.min[a], box.max[a]],
    });
  }
  return ok({ a, lo, hi, origin: origin.value });
}

function rampOf(range: ResolvedRange, s: number): number {
  return Math.min(1, Math.max(0, (s - range.lo) / (range.hi - range.lo)));
}

/** Bend the range of `axis` into a circular arc of `angle` degrees curling toward `toward`. */
export function bend(
  mesh: EditMesh,
  vertices: readonly number[],
  options: BendOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const range = resolveRange(mesh, vertices, options, tolerance);
  if (!range.ok) return range;
  const angle = requireFinite('angle', options.angle);
  if (!angle.ok) return angle;
  if (options.angle === 0 || Math.abs(options.angle) > 360) {
    return invalid('angle is non-zero and within [-360, 360] degrees', { angle: options.angle });
  }
  const direction = axisVector(options.toward);
  const b = direction.findIndex((c) => c !== 0) as 0 | 1 | 2;
  if (b === range.value.a) {
    return invalid('toward is perpendicular to axis', {
      axis: options.axis,
      toward: options.toward,
    });
  }
  const sign = direction[b] as number;
  const { a, lo, hi, origin } = range.value;
  const theta = (options.angle * Math.PI) / 180;
  const radius = (hi - lo) / theta;
  return applyDeformation(
    mesh,
    'bend',
    vertices,
    {
      kind: 'field',
      map: (p) => {
        const s = p[a] as number;
        if (s <= lo) return p;
        const d = sign * ((p[b] as number) - (origin[b] as number));
        const phi = theta * rampOf(range.value, s);
        const beyond = Math.max(0, s - hi);
        const r = radius - d;
        const q: Tuple3 = [...p];
        q[a] = lo + r * sin(phi) + beyond * cos(phi);
        q[b] = (origin[b] as number) + sign * (radius - r * cos(phi) + beyond * sin(phi));
        return q;
      },
    },
    tolerance,
    diagnostics,
    () => ({ radius }),
  );
}

function rotateAbout(p: Tuple3, a: 0 | 1 | 2, origin: Tuple3, angle: number): Tuple3 {
  const u = ((a + 1) % 3) as 0 | 1 | 2;
  const w = ((a + 2) % 3) as 0 | 1 | 2;
  const x = (p[u] as number) - (origin[u] as number);
  const y = (p[w] as number) - (origin[w] as number);
  const c = cos(angle);
  const s = sin(angle);
  const q: Tuple3 = [...p];
  q[u] = (origin[u] as number) + c * x - s * y;
  q[w] = (origin[w] as number) + s * x + c * y;
  return q;
}

/** Rotate cross sections about the axis line through `origin`, ramping to `angle` over the range. */
export function twist(
  mesh: EditMesh,
  vertices: readonly number[],
  options: TwistOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const range = resolveRange(mesh, vertices, options, tolerance);
  if (!range.ok) return range;
  const angle = requireFinite('angle', options.angle);
  if (!angle.ok) return angle;
  if (options.angle === 0) return invalid('angle is non-zero degrees', { angle: options.angle });
  const theta = (options.angle * Math.PI) / 180;
  const { a, origin } = range.value;
  return applyDeformation(
    mesh,
    'twist',
    vertices,
    {
      kind: 'field',
      map: (p) => rotateAbout(p, a, origin, theta * rampOf(range.value, p[a] as number)),
    },
    tolerance,
    diagnostics,
  );
}

/** Scale cross sections about the axis line through `origin`, ramping to `factor` over the range. */
export function taper(
  mesh: EditMesh,
  vertices: readonly number[],
  options: TaperOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const range = resolveRange(mesh, vertices, options, tolerance);
  if (!range.ok) return range;
  const factor = requirePositive('factor', options.factor);
  if (!factor.ok) return factor;
  if (options.factor === 1) return invalid('factor differs from 1', { factor: options.factor });
  const { a, origin } = range.value;
  const axes = (options.axes ?? (['x', 'y', 'z'] as const).filter((x) => axisIndex(x) !== a)).map(
    (x) => axisIndex(x),
  );
  if (axes.length === 0 || axes.includes(a)) {
    return invalid('axes lists perpendicular axes only', {
      axis: options.axis,
      axes: options.axes,
    });
  }
  return applyDeformation(
    mesh,
    'taper',
    vertices,
    {
      kind: 'field',
      map: (p) => {
        const k = 1 + (options.factor - 1) * rampOf(range.value, p[a] as number);
        const q: Tuple3 = [...p];
        for (const c of axes)
          q[c] = (origin[c] as number) + k * ((p[c] as number) - (origin[c] as number));
        return q;
      },
    },
    tolerance,
    diagnostics,
  );
}

// ---- curve deform -----------------------------------------------------------------------

/**
 * Lay the mesh along a path: the distance along `axis` from `origin` becomes arc length,
 * the perpendicular offsets follow the path frame (frame x, y for the next two axes in
 * cyclic order, so orientation is kept). Beyond the ends the path continues straight.
 */
export function curveDeform(
  mesh: EditMesh,
  vertices: readonly number[],
  options: CurveDeformOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  if (options.axis !== 'x' && options.axis !== 'y' && options.axis !== 'z') {
    return invalid("axis is 'x', 'y' or 'z'", { axis: options.axis });
  }
  const sampled = samplePath(options.path, false, tolerance);
  if (!sampled.ok) return sampled;
  const up = options.up === undefined ? ok<Tuple3>([0, 1, 0]) : finiteTuple('up', options.up);
  if (!up.ok) return up;
  const frames = pathFrames(sampled.value, false, options.frame ?? 'rmf', up.value);
  if (!frames.ok) return frames;
  const stations = frames.value;
  const total = (stations.at(-1) as (typeof stations)[number]).s;
  const a = axisIndex(options.axis);
  const u = ((a + 1) % 3) as 0 | 1 | 2;
  const w = ((a + 2) % 3) as 0 | 1 | 2;
  const box = boundsOf(mesh, vertices);
  const fallback: Tuple3 = [0, 1, 2].map((k) =>
    k === a ? (box.min[k] as number) : ((box.min[k] as number) + (box.max[k] as number)) / 2,
  ) as Tuple3;
  const origin =
    options.origin === undefined ? ok(fallback) : finiteTuple('origin', options.origin);
  if (!origin.ok) return origin;
  const extent = (box.max[a] as number) - (origin.value[a] as number);
  const stretch = options.stretch === true ? (extent > tolerance ? total / extent : 1) : 1;
  return applyDeformation(
    mesh,
    'curveDeform',
    vertices,
    {
      kind: 'field',
      map: (p) => {
        const s = ((p[a] as number) - (origin.value[a] as number)) * stretch;
        const x = (p[u] as number) - (origin.value[u] as number);
        const y = (p[w] as number) - (origin.value[w] as number);
        let lo = 0;
        let hi = stations.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if ((stations[mid] as (typeof stations)[number]).s <= s) lo = mid;
          else hi = mid;
        }
        const f0 = stations[lo] as (typeof stations)[number];
        const f1 = stations[hi] as (typeof stations)[number];
        const span = f1.s - f0.s;
        const t = Math.min(1, Math.max(0, (s - f0.s) / span));
        const point = add(scale(f0.point, 1 - t), scale(f1.point, t));
        const fy = normalize(add(scale(f0.y, 1 - t), scale(f1.y, t)));
        const fx = normalize(add(scale(f0.x, 1 - t), scale(f1.x, t)));
        const beyond = s < 0 ? s : s > total ? s - total : 0;
        const tangent = s < 0 ? f0.tangent : f1.tangent;
        return add(add(add(point, scale(fx, x)), scale(fy, y)), scale(tangent, beyond));
      },
    },
    tolerance,
    diagnostics,
    () => ({ pathLength: total, stretch }),
  );
}

// ---- Taubin smoothing ---------------------------------------------------------------------

/** Taubin lambda/mu smoothing (uniform umbrella weights): fairs without shrinking. */
export function smooth(
  mesh: EditMesh,
  vertices: readonly number[],
  options: SmoothOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const iterations = requireSegments('iterations', options.iterations, 1);
  if (!iterations.ok) return iterations;
  if (options.iterations > 1000) {
    return invalid('iterations is at most 1000', { iterations: options.iterations });
  }
  const lambda = options.lambda ?? 0.5;
  const mu = options.mu ?? -0.53;
  if (!(lambda > 0 && lambda <= 1)) return invalid('lambda is within (0, 1]', { lambda });
  if (!(Number.isFinite(mu) && mu < -lambda)) return invalid('mu is below -lambda', { lambda, mu });
  const neighbours = new Map<number, number[]>();
  const pinned = new Set<number>();
  for (const e of mesh.edges()) {
    const [p, q] = mesh.edgeVertices(e);
    for (const [x, y] of [
      [p, q],
      [q, p],
    ] as const) {
      const list = neighbours.get(x);
      if (list === undefined) neighbours.set(x, [y]);
      else list.push(y);
    }
    const pin =
      ((options.pin?.boundary ?? true) && mesh.isBoundaryEdge(e)) ||
      ((options.pin?.sharp ?? true) && ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
    if (pin) {
      pinned.add(p);
      pinned.add(q);
    }
  }
  const free = vertices.filter((v) => !pinned.has(v) && neighbours.has(v));
  const current = new Map<number, Tuple3>();
  for (const v of mesh.vertices()) current.set(v, mesh.position(v));
  const laplacian = (v: number): Tuple3 => {
    const list = neighbours.get(v) as number[];
    const c: Tuple3 = [0, 0, 0];
    for (const n of list) {
      const q = current.get(n) as Tuple3;
      c[0] += q[0];
      c[1] += q[1];
      c[2] += q[2];
    }
    return sub(scale(c, 1 / list.length), current.get(v) as Tuple3);
  };
  const roughness = () =>
    free.reduce((sum, v) => sum + length(laplacian(v)), 0) / Math.max(1, free.length);
  const roughnessBefore = roughness();
  for (let i = 0; i < iterations.value; i++) {
    for (const factor of [lambda, mu]) {
      const step = free.map((v) => [v, laplacian(v)] as const);
      for (const [v, d] of step) current.set(v, add(current.get(v) as Tuple3, scale(d, factor)));
    }
  }
  const roughnessAfter = roughness();
  const result = applyDeformation(
    mesh,
    'smooth',
    free,
    { kind: 'positions', position: (v) => current.get(v) as Tuple3 },
    tolerance,
    diagnostics,
    () => ({ pinned: vertices.length - free.length, roughnessBefore, roughnessAfter }),
  );
  if (result.ok && roughnessAfter >= roughnessBefore) {
    diagnostics.push({
      severity: 'warn',
      message: 'smoothing did not reduce the mean umbrella length (roughness)',
      detail: { roughnessBefore, roughnessAfter },
    });
  }
  return result;
}
