import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import {
  type ComputeOptions,
  type ComputePolicy,
  runComputeJob,
  type SolveMethod,
} from './compute/job';
import {
  DEFAULT_SOLVE_TOLERANCE,
  decodeVector,
  encodeCsr,
  encodeVector,
  TripletList,
} from './compute/sparse';
import { tsUvBackend } from './compute/uv-backend';
import { applyDeformation } from './deform';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { cross, dot, length, sub, type Tuple3, triangulateLoop } from './geom';
import { EDGE_SHARP, type EditMesh, edgeKey } from './mesh';
import {
  isClosed,
  type OpDiagnostic,
  type RoleCounts,
  requireFinite,
  requireSegments,
} from './ops';
import { Selector } from './selectors';

/**
 * Vertices a solve keeps in place: mesh-boundary vertices, vertices on sharp edges, or
 * the vertices of a face, edge or vertex selection.
 */
export type PinRule = 'boundary' | 'sharp' | Selector<'face' | 'edge' | 'vert'>;

/** The linear solves (solve.sparse jobs) of an assembled deformer. */
export interface DeformSolverOptions {
  /** Relative residual of each solve (default 1e-10). */
  readonly tolerance?: number;
  /** Conjugate-gradient iteration cap per solve (default max(100, 4 x unknowns)). */
  readonly maxIterations?: number;
  readonly compute?: ComputePolicy;
  /** Work units per solve job (default: the session budget). */
  readonly budget?: number;
}

export interface ImplicitSmoothOptions {
  /**
   * Diffusion time of each backward-Euler step, in units of the mean vertex area of the
   * smoothed region (so it does not depend on the model scale); 0.1 is a moderate step,
   * 1 a strong one that also flattens curved patches.
   */
  readonly lambda: number;
  /** Backward-Euler steps, each re-assembled on the current shape (default 1, at most 100). */
  readonly iterations?: number;
  /** Vertices that stay in place (default ['boundary', 'sharp']; [] pins nothing). */
  readonly pin?: PinRule | readonly PinRule[];
  /** Restore the enclosed volume after each step (closed meshes only). */
  readonly preserveVolume?: boolean;
  readonly solver?: DeformSolverOptions;
}

/** A rotation about `axis` through `origin` (default: the handle's centroid). */
export interface HandleRotation {
  readonly axis: Tuple3;
  /** Degrees, right-handed about axis. */
  readonly angle: number;
  readonly origin?: Tuple3;
}

/**
 * Vertices moved rigidly to a target: rotated about the rotation origin, then shifted
 * by `translate`, or so the centroid lands on `to`.
 */
export interface ArapHandle {
  readonly selector: Selector<'face' | 'edge' | 'vert'>;
  readonly translate?: Tuple3;
  readonly to?: Tuple3;
  readonly rotate?: HandleRotation;
}

export interface ArapOptions {
  readonly handles: readonly ArapHandle[];
  /** Local/global iterations (default 10, at most 200). */
  readonly iterations?: number;
  /** Vertices that stay in place besides the handles (default none). */
  readonly pin?: PinRule | readonly PinRule[];
  readonly solver?: DeformSolverOptions;
}

/** Session facts an assembled deformer needs: tolerance and the compute context of its jobs. */
export interface SolveContext extends ComputeOptions {
  readonly tolerance: number;
  readonly policy: ComputePolicy;
}

const W_MIN = 1e-3;
const W_MAX = 1e3;
const AXES = ['x', 'y', 'z'] as const;

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
  return ok([value[0], value[1], value[2]] as Tuple3);
}

/** JSON form of pin rules and handles for the journal (selectors become their descriptions). */
export function describePins(pin: PinRule | readonly PinRule[] | undefined): unknown {
  if (pin === undefined) return undefined;
  const one = (rule: PinRule) => (rule instanceof Selector ? rule.description : rule);
  return Array.isArray(pin) ? pin.map(one) : one(pin as PinRule);
}

export function describeHandles(handles: readonly ArapHandle[] | undefined): unknown {
  if (!Array.isArray(handles)) return handles;
  return handles.map((h) => ({
    ...h,
    selector: h?.selector instanceof Selector ? h.selector.description : h?.selector,
  }));
}

function selectorVertices(
  mesh: EditMesh,
  selector: unknown,
  name: string,
): Result<number[], ModelingError> {
  if (!(selector instanceof Selector))
    return invalid(`${name} is a selector`, { [name]: selector });
  const ids = (selector as Selector<'face' | 'edge' | 'vert'>).resolve(mesh);
  if (!ids.ok) return ids;
  if (selector.domain === 'vert') return ids;
  const set = new Set<number>();
  for (const id of ids.value) {
    const vs = selector.domain === 'face' ? mesh.faceVertices(id) : mesh.edgeVertices(id);
    for (const v of vs) set.add(v);
  }
  return ok([...set].sort((a, b) => a - b));
}

function pinnedVertices(
  mesh: EditMesh,
  pin: PinRule | readonly PinRule[],
): Result<{ readonly rules: Set<number>; readonly selected: Set<number> }, ModelingError> {
  const rules = new Set<number>();
  const selected = new Set<number>();
  const list = (Array.isArray(pin) ? pin : [pin]) as readonly unknown[];
  for (const rule of list) {
    if (rule === 'boundary' || rule === 'sharp') {
      for (const e of mesh.edges()) {
        const hit =
          rule === 'boundary'
            ? mesh.isBoundaryEdge(e)
            : ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0;
        if (hit) for (const v of mesh.edgeVertices(e)) rules.add(v);
      }
      continue;
    }
    if (!(rule instanceof Selector)) {
      return invalid("each pin rule is 'boundary', 'sharp' or a selector", { pin: rule });
    }
    const ids = selectorVertices(mesh, rule, 'pin');
    if (!ids.ok) return ids;
    for (const v of ids.value) selected.add(v);
  }
  return ok({ rules, selected });
}

// ---- cotangent stencil ------------------------------------------------------------------

/** One undirected edge of the stencil with its clamped cotangent weight. */
interface StencilEdge {
  readonly a: number;
  readonly b: number;
  readonly w: number;
}

/**
 * Cotangent Laplacian of the faces around the free vertices (each face in its export
 * triangulation, so n-gons gain their diagonals): clamped edge weights and lumped
 * (one third of each triangle) vertex areas.
 */
interface Stencil {
  readonly edges: readonly StencilEdge[];
  readonly neighbours: ReadonlyMap<number, readonly { readonly j: number; readonly w: number }[]>;
  readonly area: ReadonlyMap<number, number>;
  readonly faces: readonly number[];
  readonly clamped: number;
}

function lowestPoint(points: readonly Tuple3[]): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i] as Tuple3;
    const q = points[best] as Tuple3;
    if (p[0] < q[0] || (p[0] === q[0] && (p[1] < q[1] || (p[1] === q[1] && p[2] < q[2])))) best = i;
  }
  return best;
}

function cotanStencil(
  mesh: EditMesh,
  free: ReadonlySet<number>,
  position: (v: number) => Tuple3,
  op: string,
): Result<Stencil, ModelingError> {
  const weight = new Map<number, { a: number; b: number; w: number }>();
  const area = new Map<number, number>();
  const faces: number[] = [];
  const key = edgeKey;
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f);
    if (!loop.some((v) => free.has(v))) continue;
    faces.push(f);
    // Start each loop at its lexicographically smallest point, so the triangulation (and
    // with it the weights of non-planar faces) depends on the geometry, not on ids.
    const start = lowestPoint(loop.map(position));
    const vs = [...loop.slice(start), ...loop.slice(0, start)];
    const points = vs.map(position);
    const triangles = triangulateLoop(points);
    if (triangles === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          `${op}: every face around the solved vertices can be triangulated`,
          {
            face: f,
          },
        ),
      );
    }
    for (let t = 0; t < triangles.length; t += 3) {
      const ids = [0, 1, 2].map((k) => triangles[t + k] as number);
      const p = ids.map((i) => points[i] as Tuple3);
      const doubled = length(
        cross(sub(p[1] as Tuple3, p[0] as Tuple3), sub(p[2] as Tuple3, p[0] as Tuple3)),
      );
      if (!(doubled > 0)) {
        return err(
          modelingError(
            'model-degenerate',
            `${op}: the faces around the solved vertices have no zero-area triangles`,
            { face: f },
            'weld or dissolve collapsed faces before solving',
          ),
        );
      }
      for (let k = 0; k < 3; k++) {
        const vk = vs[ids[k] as number] as number;
        area.set(vk, (area.get(vk) ?? 0) + doubled / 6);
        const pk = p[k] as Tuple3;
        const u = sub(p[(k + 1) % 3] as Tuple3, pk);
        const w = sub(p[(k + 2) % 3] as Tuple3, pk);
        const cot = dot(u, w) / doubled;
        const a = vs[ids[(k + 1) % 3] as number] as number;
        const b = vs[ids[(k + 2) % 3] as number] as number;
        const id = key(a, b);
        const entry = weight.get(id);
        if (entry === undefined)
          weight.set(id, { a: Math.min(a, b), b: Math.max(a, b), w: cot / 2 });
        else entry.w += cot / 2;
      }
    }
  }
  let clamped = 0;
  const edges: StencilEdge[] = [];
  const neighbours = new Map<number, { j: number; w: number }[]>();
  const link = (x: number, y: number, w: number) => {
    const list = neighbours.get(x);
    if (list === undefined) neighbours.set(x, [{ j: y, w }]);
    else list.push({ j: y, w });
  };
  for (const entry of weight.values()) {
    if (!free.has(entry.a) && !free.has(entry.b)) continue;
    // Right-angle diagonals of planar quads weigh zero; only obtuse or needle triangles count as clamped.
    const w = Math.min(W_MAX, Math.max(W_MIN, entry.w));
    if (entry.w < 0 || entry.w > W_MAX) clamped++;
    edges.push({ a: entry.a, b: entry.b, w });
    link(entry.a, entry.b, w);
    link(entry.b, entry.a, w);
  }
  return ok({ edges, neighbours, area, faces, clamped });
}

/** Mean curvature |H| at each vertex: the cotangent Laplacian over twice the lumped area. */
function curvatures(
  stencil: Stencil,
  vertices: readonly number[],
  position: (v: number) => Tuple3,
): number[] {
  return vertices.map((v) => {
    const p = position(v);
    const sum: Tuple3 = [0, 0, 0];
    for (const { j, w } of stencil.neighbours.get(v) ?? []) {
      const q = position(j);
      for (let k = 0; k < 3; k++)
        sum[k] = (sum[k] as number) + w * ((p[k] as number) - (q[k] as number));
    }
    return length(sum) / (2 * (stencil.area.get(v) ?? 1));
  });
}

function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let mean = 0;
  for (const x of values) mean += x;
  mean /= values.length;
  let sum = 0;
  for (const x of values) sum += (x - mean) * (x - mean);
  return sum / values.length;
}

/**
 * Mean curvature |H| of vertices (cotangent Laplacian over twice the lumped area of
 * the surrounding triangles); used by smooth.implicit's report and its tests.
 */
export function meanCurvatures(
  mesh: EditMesh,
  vertices: readonly number[],
): Result<number[], ModelingError> {
  const position = (v: number) => mesh.position(v);
  const stencil = cotanStencil(mesh, new Set(vertices), position, 'meanCurvatures');
  if (!stencil.ok) return stencil;
  return ok(curvatures(stencil.value, vertices, position));
}

// ---- solve.sparse jobs --------------------------------------------------------------------

interface SolvedColumn {
  readonly x: Float64Array;
  readonly iterations: number;
  readonly residual: number;
}

function solveColumn(
  csr: Uint8Array,
  rhs: Float64Array,
  initial: Float64Array,
  method: SolveMethod,
  context: SolveContext,
  solver: DeformSolverOptions,
  where: Record<string, unknown>,
): Result<SolvedColumn, ModelingError> {
  const budget = solver.budget ?? context.budget;
  const job = runComputeJob(
    {
      kind: 'solve.sparse',
      inputs: [csr, encodeVector(rhs), encodeVector(initial)],
      params: {
        method,
        tolerance: solver.tolerance ?? DEFAULT_SOLVE_TOLERANCE,
        ...(solver.maxIterations === undefined ? {} : { maxIterations: solver.maxIterations }),
      },
    },
    tsUvBackend,
    {
      policy: solver.compute ?? context.policy,
      ...(context.native === undefined ? {} : { native: context.native }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(budget === undefined ? {} : { budget }),
    },
  );
  if (!job.ok) {
    const cause = job.error;
    return err(
      modelingError(cause.code, cause.expected, { ...cause.detail, ...where }, cause.hint),
    );
  }
  const metrics = job.value.report.metrics;
  return ok({
    x: decodeVector(job.value.outputs[0] as Uint8Array),
    iterations: metrics.iterations as number,
    residual: metrics.residual as number,
  });
}

function checkSolver(
  solver: DeformSolverOptions | undefined,
): Result<DeformSolverOptions, ModelingError> {
  const s = solver ?? {};
  if (typeof s !== 'object' || s === null)
    return invalid('solver is an options object', { solver });
  if (s.tolerance !== undefined && !(s.tolerance > 0 && s.tolerance < 1)) {
    return invalid('solver.tolerance is in (0, 1)', { tolerance: s.tolerance });
  }
  if (
    s.maxIterations !== undefined &&
    !(Number.isInteger(s.maxIterations) && s.maxIterations >= 1)
  ) {
    return invalid('solver.maxIterations is an integer >= 1', { maxIterations: s.maxIterations });
  }
  return ok(s);
}

function checkIterations(
  value: number | undefined,
  fallback: number,
  maximum: number,
): Result<number, ModelingError> {
  if (value === undefined) return ok(fallback);
  const n = requireSegments('iterations', value, 1);
  if (!n.ok) return n;
  if (value > maximum) return invalid(`iterations is at most ${maximum}`, { iterations: value });
  return ok(value);
}

// ---- smooth.implicit ----------------------------------------------------------------------

/** Volume of the closed mesh with free vertices at `position` (the fan rule of facesVolume). */
function volumeWith(mesh: EditMesh, position: (v: number) => Tuple3): number {
  let volume = 0;
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const o = position(vs[0] as number);
    for (let i = 1; i + 1 < vs.length; i++) {
      volume += dot(o, cross(position(vs[i] as number), position(vs[i + 1] as number))) / 6;
    }
  }
  return volume;
}

/** Gradient of volumeWith with respect to each free vertex. */
function volumeGradient(
  mesh: EditMesh,
  free: ReadonlySet<number>,
  position: (v: number) => Tuple3,
): Map<number, Tuple3> {
  const gradient = new Map<number, Tuple3>();
  const addTo = (v: number, g: Tuple3) => {
    if (!free.has(v)) return;
    const current = gradient.get(v) ?? [0, 0, 0];
    gradient.set(v, [current[0] + g[0] / 6, current[1] + g[1] / 6, current[2] + g[2] / 6]);
  };
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const o = vs[0] as number;
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[i] as number;
      const b = vs[i + 1] as number;
      addTo(o, cross(position(a), position(b)));
      addTo(a, cross(position(b), position(o)));
      addTo(b, cross(position(o), position(a)));
    }
  }
  return gradient;
}

/**
 * Backward-Euler smoothing with the cotangent Laplacian:
 * (M + lambda L) x' = M x per step, pinned and unselected vertices substituted into the
 * right-hand side, each coordinate solved by a Jacobi-PCG solve.sparse job. The
 * optional volume step moves the free vertices along the volume gradient (minimum norm)
 * until the enclosed volume is restored.
 */
export function implicitSmooth(
  mesh: EditMesh,
  vertices: readonly number[],
  options: ImplicitSmoothOptions,
  context: SolveContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const op = 'smooth.implicit';
  if (typeof options !== 'object' || options === null) return invalid('options is an object', {});
  const lambda = requireFinite('lambda', options.lambda);
  if (!lambda.ok) return lambda;
  if (!(options.lambda > 0) || options.lambda > 1e6) {
    return invalid('lambda is within (0, 1e6]', { lambda: options.lambda });
  }
  const iterations = checkIterations(options.iterations, 1, 100);
  if (!iterations.ok) return iterations;
  const solver = checkSolver(options.solver);
  if (!solver.ok) return solver;
  const pins = pinnedVertices(mesh, options.pin ?? ['boundary', 'sharp']);
  if (!pins.ok) return pins;
  const preserve = options.preserveVolume === true;
  if (preserve && !isClosed(mesh)) {
    return err(
      modelingError(
        'model-precondition',
        'preserveVolume needs a closed mesh',
        {},
        'close the mesh (cap its holes) or smooth without preserveVolume',
      ),
    );
  }
  const free = vertices.filter((v) => !pins.value.rules.has(v) && !pins.value.selected.has(v));
  if (free.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        `${op} has at least one selected vertex that is not pinned`,
        { selected: vertices.length },
        'pin fewer vertices (pin: [] pins nothing), or select vertices away from boundary and sharp edges',
      ),
    );
  }
  const freeSet = new Set(free);
  const row = new Map(free.map((v, i) => [v, i] as const));
  const current = new Map<number, Tuple3>();
  for (const v of mesh.vertices()) current.set(v, mesh.position(v));
  const position = (v: number) => current.get(v) as Tuple3;
  const volumeBefore = preserve ? volumeWith(mesh, position) : 0;
  let solves = 0;
  let solverIterations = 0;
  let maxResidual = 0;
  let clamped = 0;
  let curvatureBefore: number[] = [];
  for (let step = 0; step < iterations.value; step++) {
    const stencil = cotanStencil(mesh, freeSet, position, op);
    if (!stencil.ok) return stencil;
    if (step === 0) curvatureBefore = curvatures(stencil.value, free, position);
    clamped = Math.max(clamped, stencil.value.clamped);
    let meanArea = 0;
    for (const v of free) meanArea += stencil.value.area.get(v) ?? 0;
    meanArea /= free.length;
    const t = options.lambda;
    const system = new TripletList(free.length, free.length);
    const rhs = AXES.map(() => new Float64Array(free.length));
    for (const [i, v] of free.entries()) {
      const mass = (stencil.value.area.get(v) ?? 0) / meanArea;
      const p = position(v);
      let diagonal = mass;
      for (const { j, w } of stencil.value.neighbours.get(v) ?? []) {
        diagonal += t * w;
        const c = row.get(j);
        if (c !== undefined) system.add(i, c, -t * w);
        else {
          const q = position(j);
          for (let k = 0; k < 3; k++) {
            const r = rhs[k] as Float64Array;
            r[i] = (r[i] as number) + t * w * (q[k] as number);
          }
        }
      }
      system.add(i, i, diagonal);
      for (let k = 0; k < 3; k++) {
        const r = rhs[k] as Float64Array;
        r[i] = (r[i] as number) + mass * (p[k] as number);
      }
    }
    const csr = encodeCsr(system.toCsr());
    const next = free.map((v) => [...position(v)] as Tuple3);
    for (let k = 0; k < 3; k++) {
      const initial = Float64Array.from(free, (v) => position(v)[k] as number);
      const solved = solveColumn(
        csr,
        rhs[k] as Float64Array,
        initial,
        'pcg-jacobi',
        context,
        solver.value,
        {
          step: step + 1,
          coordinate: AXES[k],
        },
      );
      if (!solved.ok) return solved;
      solves++;
      solverIterations += solved.value.iterations;
      maxResidual = Math.max(maxResidual, solved.value.residual);
      for (let i = 0; i < free.length; i++) (next[i] as Tuple3)[k] = solved.value.x[i] as number;
    }
    for (const [i, v] of free.entries()) current.set(v, next[i] as Tuple3);
    if (preserve) {
      for (let pass = 0; pass < 8; pass++) {
        const deficit = volumeBefore - volumeWith(mesh, position);
        if (Math.abs(deficit) <= Math.abs(volumeBefore) * 1e-12) break;
        const gradient = volumeGradient(mesh, freeSet, position);
        let norm = 0;
        for (const g of gradient.values()) norm += dot(g, g);
        if (!(norm > 0)) break;
        const delta = deficit / norm;
        for (const [v, g] of gradient) {
          const p = position(v);
          current.set(v, [p[0] + delta * g[0], p[1] + delta * g[1], p[2] + delta * g[2]]);
        }
      }
    }
  }
  const after = cotanStencil(mesh, freeSet, position, op);
  if (!after.ok) return after;
  const curvatureAfter = curvatures(after.value, free, position);
  const before = variance(curvatureBefore);
  const varianceAfter = variance(curvatureAfter);
  const result = applyDeformation(
    mesh,
    op,
    free,
    { kind: 'positions', position },
    context.tolerance,
    diagnostics,
    () => ({
      lambda: options.lambda,
      steps: iterations.value,
      pinned: vertices.length - free.length,
      solves,
      solverIterations,
      maxResidual,
      clampedWeights: clamped,
      curvatureVarianceBefore: before,
      curvatureVarianceAfter: varianceAfter,
      ...(preserve ? { volumeTarget: volumeBefore } : {}),
    }),
  );
  if (result.ok && varianceAfter >= before) {
    diagnostics.push({
      severity: 'warn',
      message: 'implicit smoothing did not reduce the variance of the mean curvature',
      detail: { curvatureVarianceBefore: before, curvatureVarianceAfter: varianceAfter },
    });
  }
  return result;
}

// ---- ARAP -----------------------------------------------------------------------------------

/** Row-major 3x3 rotation. */
type Rotation = readonly [number, number, number, number, number, number, number, number, number];
type Quaternion = [number, number, number, number];

const IDENTITY: Rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function rotationOf(q: Quaternion): Rotation {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

function axisAngle(axis: Tuple3, angle: number): Quaternion {
  const s = sin(angle / 2);
  return [cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function apply(r: Rotation, v: Tuple3): Tuple3 {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

/**
 * Rotational part of a 3x3 matrix (row-major `a`) by polar iteration
 * 2016, warm-started from and written back to `q`: always a proper rotation, no SVD,
 * no reflection fix-up.
 */
function extractRotation(a: readonly number[], q: Quaternion): Rotation {
  const columns = [0, 1, 2].map(
    (c) => [a[c] as number, a[3 + c] as number, a[6 + c] as number] as Tuple3,
  );
  const scaleOf = columns.reduce((s, c) => s + length(c), 0);
  if (!(scaleOf > 0)) return rotationOf(q);
  for (let it = 0; it < 32; it++) {
    const r = rotationOf(q);
    const rc = [0, 1, 2].map((c) => [r[c], r[3 + c], r[6 + c]] as Tuple3);
    const omega: Tuple3 = [0, 0, 0];
    let along = 0;
    for (let c = 0; c < 3; c++) {
      const x = cross(rc[c] as Tuple3, columns[c] as Tuple3);
      omega[0] += x[0];
      omega[1] += x[1];
      omega[2] += x[2];
      along += dot(rc[c] as Tuple3, columns[c] as Tuple3);
    }
    const s = 1 / (Math.abs(along) + scaleOf * 1e-12);
    const w = length(omega) * s;
    if (w < 1e-13) break;
    const turn = axisAngle([(omega[0] * s) / w, (omega[1] * s) / w, (omega[2] * s) / w], w);
    const next = multiplyQuaternions(turn, q);
    const n = Math.sqrt(
      next[0] * next[0] + next[1] * next[1] + next[2] * next[2] + next[3] * next[3],
    );
    q[0] = next[0] / n;
    q[1] = next[1] / n;
    q[2] = next[2] / n;
    q[3] = next[3] / n;
  }
  return rotationOf(q);
}

interface ResolvedHandle {
  readonly vertices: readonly number[];
  readonly rotation: Rotation;
  readonly target: (p: Tuple3) => Tuple3;
  readonly maxMove: number;
}

function resolveHandle(
  mesh: EditMesh,
  handle: ArapHandle,
  index: number,
): Result<ResolvedHandle, ModelingError> {
  if (typeof handle !== 'object' || handle === null) {
    return invalid('each handle is { selector, translate?, to?, rotate? }', { handle: index });
  }
  const vertices = selectorVertices(mesh, handle.selector, `handles[${index}].selector`);
  if (!vertices.ok) {
    const cause = vertices.error;
    return err(
      modelingError(cause.code, cause.expected, { ...cause.detail, handle: index }, cause.hint),
    );
  }
  if (handle.translate === undefined && handle.to === undefined && handle.rotate === undefined) {
    return invalid('each handle sets translate, to or rotate (pin holds vertices in place)', {
      handle: index,
    });
  }
  if (handle.translate !== undefined && handle.to !== undefined) {
    return invalid('a handle sets translate or to, not both', { handle: index });
  }
  const centroid: Tuple3 = [0, 0, 0];
  for (const v of vertices.value) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++)
      centroid[k] = (centroid[k] as number) + (p[k] as number) / vertices.value.length;
  }
  let rotation = IDENTITY;
  let origin = centroid;
  if (handle.rotate !== undefined) {
    const axis = finiteTuple('rotate.axis', handle.rotate?.axis);
    if (!axis.ok) return axis;
    const norm = length(axis.value);
    if (!(norm > 0))
      return invalid('rotate.axis is a non-zero vector', { handle: index, axis: axis.value });
    const angle = requireFinite('rotate.angle', handle.rotate.angle);
    if (!angle.ok) return angle;
    if (handle.rotate.origin !== undefined) {
      const o = finiteTuple('rotate.origin', handle.rotate.origin);
      if (!o.ok) return o;
      origin = o.value;
    }
    const unit: Tuple3 = [axis.value[0] / norm, axis.value[1] / norm, axis.value[2] / norm];
    rotation = rotationOf(axisAngle(unit, (angle.value * Math.PI) / 180));
  }
  let shift: Tuple3 = [0, 0, 0];
  if (handle.translate !== undefined) {
    const t = finiteTuple('translate', handle.translate);
    if (!t.ok) return t;
    shift = t.value;
  }
  const turned = (p: Tuple3): Tuple3 => {
    const r = apply(rotation, sub(p, origin));
    return [origin[0] + r[0], origin[1] + r[1], origin[2] + r[2]];
  };
  if (handle.to !== undefined) {
    const to = finiteTuple('to', handle.to);
    if (!to.ok) return to;
    shift = sub(to.value, turned(centroid));
  }
  const target = (p: Tuple3): Tuple3 => {
    const q = turned(p);
    return [q[0] + shift[0], q[1] + shift[1], q[2] + shift[2]];
  };
  let maxMove = 0;
  for (const v of vertices.value) {
    const p = mesh.position(v);
    maxMove = Math.max(maxMove, length(sub(target(p), p)));
  }
  return ok({ vertices: vertices.value, rotation, target, maxMove });
}

/**
 * As-rigid-as-possible deformation of the selected region:
 * handles move rigidly to their targets, pinned and unselected vertices stay, and the
 * free vertices alternate a local step (the best rotation of each vertex's cotangent-
 * weighted one-ring) with a global step (the Laplacian system, assembled once and
 * solved per coordinate by a Jacobi-PCG solve.sparse job warm-started from the last
 * shape). The report lists the ARAP energy after each local step.
 */
export function arap(
  mesh: EditMesh,
  vertices: readonly number[],
  options: ArapOptions,
  context: SolveContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const op = 'arap';
  if (typeof options !== 'object' || options === null) return invalid('options is an object', {});
  if (!Array.isArray(options.handles) || options.handles.length === 0) {
    return invalid('handles lists at least one handle', { handles: options.handles });
  }
  const iterations = checkIterations(options.iterations, 10, 200);
  if (!iterations.ok) return iterations;
  const solver = checkSolver(options.solver);
  if (!solver.ok) return solver;
  const region = new Set(vertices);
  const owner = new Map<number, number>();
  const handles: ResolvedHandle[] = [];
  for (const [index, handle] of options.handles.entries()) {
    const resolved = resolveHandle(mesh, handle, index);
    if (!resolved.ok) return resolved;
    for (const v of resolved.value.vertices) {
      if (!region.has(v)) {
        return invalid('handle vertices lie in the deformed selection', {
          handle: index,
          vertex: v,
        });
      }
      const other = owner.get(v);
      if (other !== undefined) {
        return invalid('handles do not share vertices', { handles: [other, index], vertex: v });
      }
      owner.set(v, index);
    }
    handles.push(resolved.value);
  }
  const pins = pinnedVertices(mesh, options.pin ?? []);
  if (!pins.ok) return pins;
  for (const v of pins.value.selected) {
    if (owner.has(v)) {
      return invalid('pin selections and handles do not share vertices', {
        handle: owner.get(v),
        vertex: v,
      });
    }
  }
  const maxHandleMove = maxOf(handles.map((h) => h.maxMove));
  if (maxHandleMove <= context.tolerance) {
    return err(
      modelingError(
        'model-op-no-effect',
        'arap moves at least one handle farther than the tolerance',
        { maxHandleMove, tolerance: context.tolerance },
        'give a handle a translate, to or rotate that moves it',
      ),
    );
  }
  const free = vertices.filter(
    (v) => !owner.has(v) && !pins.value.rules.has(v) && !pins.value.selected.has(v),
  );
  if (free.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        'arap has at least one free vertex (selected, not a handle, not pinned)',
        { selected: vertices.length, handles: owner.size },
        'select a region larger than the handles and pins',
      ),
    );
  }
  const freeSet = new Set(free);
  const row = new Map(free.map((v, i) => [v, i] as const));
  const rest = (v: number) => mesh.position(v);
  const stencil = cotanStencil(mesh, freeSet, rest, op);
  if (!stencil.ok) return stencil;
  const { edges, neighbours } = stencil.value;
  // Every connected part of the free vertices must touch a fixed vertex, or its system is singular.
  const seen = new Set<number>();
  for (const start of free) {
    if (seen.has(start)) continue;
    let anchored = false;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      for (const { j } of neighbours.get(v) ?? []) {
        if (!freeSet.has(j)) anchored = true;
        else if (!seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    if (!anchored) {
      return err(
        modelingError(
          'model-precondition',
          'every connected part of the deformed region touches a handle, a pin or an unselected vertex',
          { vertex: start, position: mesh.position(start) },
          'add a handle or a pin on that part, or leave it out of the selection',
        ),
      );
    }
  }
  const current = new Map<number, Tuple3>();
  for (const v of neighbours.keys()) current.set(v, mesh.position(v));
  for (const v of vertices) if (!current.has(v)) current.set(v, mesh.position(v));
  for (const h of handles) for (const v of h.vertices) current.set(v, h.target(mesh.position(v)));
  const position = (v: number) => current.get(v) as Tuple3;
  const system = new TripletList(free.length, free.length);
  for (const [i, v] of free.entries()) {
    let diagonal = 0;
    for (const { j, w } of neighbours.get(v) ?? []) {
      diagonal += w;
      const c = row.get(j);
      if (c !== undefined) system.add(i, c, -w);
    }
    system.add(i, i, diagonal);
  }
  const matrix = system.toCsr();
  const csr = encodeCsr(matrix);
  const quaternions = new Map<number, Quaternion>();
  const rotations = new Map<number, Rotation>();
  const localStep = (): number => {
    for (const [v, list] of neighbours) {
      const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const p = rest(v);
      const x = position(v);
      for (const { j, w } of list) {
        const e = sub(p, rest(j));
        const d = sub(x, position(j));
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++)
            a[3 * r + c] = (a[3 * r + c] as number) + w * (d[r] as number) * (e[c] as number);
        }
      }
      let q = quaternions.get(v);
      if (q === undefined) {
        q = [1, 0, 0, 0];
        quaternions.set(v, q);
      }
      rotations.set(v, extractRotation(a, q));
    }
    let energy = 0;
    for (const { a, b, w } of edges) {
      const e = sub(rest(a), rest(b));
      const d = sub(position(a), position(b));
      for (const r of [rotations.get(a), rotations.get(b)] as Rotation[]) {
        const diff = sub(d, apply(r, e));
        energy += w * dot(diff, diff);
      }
    }
    return energy;
  };
  const energies = [localStep()];
  let solverIterations = 0;
  let maxResidual = 0;
  for (let it = 0; it < iterations.value; it++) {
    const rhs = AXES.map(() => new Float64Array(free.length));
    for (const [i, v] of free.entries()) {
      const p = rest(v);
      const ri = rotations.get(v) as Rotation;
      for (const { j, w } of neighbours.get(v) ?? []) {
        const rj = rotations.get(j) as Rotation;
        const e = sub(p, rest(j));
        const a = apply(ri, e);
        const b = apply(rj, e);
        const fixed = row.has(j) ? undefined : position(j);
        for (let k = 0; k < 3; k++) {
          const r = rhs[k] as Float64Array;
          r[i] =
            (r[i] as number) +
            (w / 2) * ((a[k] as number) + (b[k] as number)) +
            (fixed === undefined ? 0 : w * (fixed[k] as number));
        }
      }
    }
    const next = free.map((v) => [...position(v)] as Tuple3);
    for (let k = 0; k < 3; k++) {
      const initial = Float64Array.from(free, (v) => position(v)[k] as number);
      const solved = solveColumn(
        csr,
        rhs[k] as Float64Array,
        initial,
        'pcg-jacobi',
        context,
        solver.value,
        {
          iteration: it + 1,
          coordinate: AXES[k],
        },
      );
      if (!solved.ok) return solved;
      solverIterations += solved.value.iterations;
      maxResidual = Math.max(maxResidual, solved.value.residual);
      for (let i = 0; i < free.length; i++) (next[i] as Tuple3)[k] = solved.value.x[i] as number;
    }
    for (const [i, v] of free.entries()) current.set(v, next[i] as Tuple3);
    energies.push(localStep());
  }
  const handleRotation = new Map<number, Rotation>();
  for (const h of handles) for (const v of h.vertices) handleRotation.set(v, h.rotation);
  const moved = [...free, ...owner.keys()].sort((a, b) => a - b);
  const stretch = (() => {
    let worst = 0;
    let sum = 0;
    for (const { a, b } of edges) {
      const l0 = length(sub(rest(a), rest(b)));
      const l1 = length(sub(position(a), position(b)));
      const s = Math.abs(l1 - l0) / l0;
      sum += s;
      worst = Math.max(worst, s);
    }
    return { maxEdgeStrain: worst, meanEdgeStrain: sum / Math.max(1, edges.length) };
  })();
  return applyDeformation(
    mesh,
    op,
    moved,
    {
      kind: 'positions',
      position,
      orient: (f, normal) => {
        for (const v of mesh.faceVertices(f)) {
          const r = rotations.get(v) ?? handleRotation.get(v);
          if (r !== undefined) return apply(r, normal);
        }
        return normal;
      },
    },
    context.tolerance,
    diagnostics,
    () => ({
      iterations: iterations.value,
      energies,
      energyReduction:
        (energies[0] as number) > 0 ? 1 - (energies.at(-1) as number) / (energies[0] as number) : 0,
      handles: handles.map((h, index) => ({
        handle: index,
        vertices: h.vertices.length,
        maxMove: h.maxMove,
      })),
      free: free.length,
      pinned: vertices.length - free.length - owner.size,
      system: {
        rows: matrix.rows,
        nnz: matrix.values.length,
        assembled: 1,
        solves: 3 * iterations.value,
      },
      solverIterations,
      maxResidual,
      clampedWeights: stencil.value.clamped,
      ...stretch,
    }),
  );
}
