import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import { cross, dot, length, sub } from './geom';
import {
  checkSurface,
  type NurbsSurface,
  type SurfaceFoot,
  surfaceDerivatives,
  surfaceDomain,
  surfaceLocator,
  surfacePoint,
} from './nurbs';
import type { Issue } from './report';

/** Target geometry compared against the measured NURBS patches. */
export type DeviationTarget =
  | { readonly points: readonly Tuple3[] }
  | {
      readonly mesh: { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> };
    }
  | { readonly surfaces: readonly NurbsSurface[] };

/** Sampling density, pass tolerance and absolute-distance bands for a deviation report. */
export interface DeviationOptions {
  /** Maximum permitted deviation in meters (default 1e-4). */
  readonly tolerance?: number;
  /** Samples per surface parameter direction (default 24). */
  readonly samples?: number;
  /** Increasing non-negative absolute-distance limits in meters. */
  readonly bands?: readonly number[];
}

/** Closed findings emitted by a deviation report. */
export type DeviationCode = 'deviation-exceeded' | 'nothing-checked';

interface DeviationPlace {
  readonly point: Tuple3;
  readonly onSurface: Tuple3;
  readonly patch: number;
  readonly u: number;
  readonly v: number;
  readonly distance: number;
}

/** Summary statistics for one direction of a deviation measurement. */
export interface DeviationSide {
  readonly count: number;
  /** Largest unsigned deviation in meters. */
  readonly max: number;
  /** Mean unsigned deviation in meters. */
  readonly mean: number;
  /** Root-mean-square unsigned deviation in meters. */
  readonly rms: number;
  /** 95th percentile unsigned deviation in meters. */
  readonly p95: number;
  /** Smallest and largest signed distances along the measured patch normal. */
  readonly signed: readonly [number, number];
  readonly worst: DeviationPlace;
  /** Fractions of samples at or below each absolute-distance limit. */
  readonly bands: readonly { readonly limit: number; readonly share: number }[];
}

/** Bidirectional sampled deviation and its tolerance findings. */
export interface DeviationReport {
  readonly pass: boolean;
  readonly tolerance: number;
  readonly toSurfaces: DeviationSide;
  readonly toTarget?: DeviationSide;
  readonly issues: readonly Issue<DeviationCode>[];
}

interface Measurement {
  readonly magnitude: number;
  readonly signed: number;
  readonly place: DeviationPlace;
}

interface ClosestSurface {
  readonly point: Tuple3;
  readonly normal: Tuple3 | undefined;
  readonly distance: number;
  readonly patch: number;
  readonly u: number;
  readonly v: number;
}

/** One measured patch prepared for many closest-point queries. */
interface Patch {
  readonly surface: NurbsSurface;
  readonly closest: (point: Tuple3) => SurfaceFoot;
  /** Bounds of the control net; the patch lies inside its hull (weights are positive). */
  readonly min: Tuple3;
  readonly max: Tuple3;
}

interface Triangle {
  readonly a: Tuple3;
  readonly b: Tuple3;
  readonly c: Tuple3;
  readonly min: Tuple3;
  readonly max: Tuple3;
  readonly center: Tuple3;
  readonly index: number;
}

interface TriangleNode {
  readonly min: Tuple3;
  readonly max: Tuple3;
  readonly left?: TriangleNode;
  readonly right?: TriangleNode;
  readonly triangles?: readonly Triangle[];
}

interface PreparedTarget {
  readonly kind: 'points' | 'mesh' | 'surfaces';
  readonly points: readonly Tuple3[];
  readonly surfaces: readonly NurbsSurface[];
  readonly triangles: readonly Triangle[];
}

function invalid(expected: string, detail: Record<string, unknown> = {}) {
  return err(modelingError('model-invalid-argument', expected, detail));
}

function finiteTuple(value: unknown): value is Tuple3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
  );
}

function safeCheckSurface(surface: unknown): Result<NurbsSurface, ModelingError> {
  if (typeof surface !== 'object' || surface === null)
    return invalid('surface is a valid NURBS patch');
  try {
    return checkSurface(surface as NurbsSurface);
  } catch {
    return invalid('surface is a valid NURBS patch');
  }
}

function checkedSurfaces(
  value: unknown,
  name: string,
): Result<readonly NurbsSurface[], ModelingError> {
  if (!Array.isArray(value)) return invalid(`${name} is an array of valid NURBS patches`);
  for (const [index, surface] of value.entries()) {
    const checked = safeCheckSurface(surface);
    if (!checked.ok)
      return err({
        ...checked.error,
        detail: { ...checked.error.detail, surface: name, index },
      });
  }
  return ok(value as readonly NurbsSurface[]);
}

function pointAt(positions: readonly number[], index: number): Tuple3 {
  return [
    positions[3 * index] as number,
    positions[3 * index + 1] as number,
    positions[3 * index + 2] as number,
  ];
}

function triangleFor(a: Tuple3, b: Tuple3, c: Tuple3, index: number): Triangle {
  const min: Tuple3 = [
    Math.min(a[0], b[0], c[0]),
    Math.min(a[1], b[1], c[1]),
    Math.min(a[2], b[2], c[2]),
  ];
  const max: Tuple3 = [
    Math.max(a[0], b[0], c[0]),
    Math.max(a[1], b[1], c[1]),
    Math.max(a[2], b[2], c[2]),
  ];
  return {
    a,
    b,
    c,
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    index,
  };
}

function prepareTarget(target: unknown): Result<PreparedTarget, ModelingError> {
  if (typeof target !== 'object' || target === null)
    return invalid('target has exactly one of points, mesh or surfaces');
  const input = target as Record<string, unknown>;
  const kinds = ['points', 'mesh', 'surfaces'].filter((kind) => kind in input);
  if (kinds.length !== 1) return invalid('target has exactly one of points, mesh or surfaces');
  const kind = kinds[0];
  if (kind === 'points') {
    if (!Array.isArray(input.points)) return invalid('target points are finite [x, y, z] tuples');
    const points: Tuple3[] = [];
    for (const [index, point] of input.points.entries()) {
      if (!finiteTuple(point))
        return invalid('target points are finite [x, y, z] tuples', { index, point });
      points.push([point[0], point[1], point[2]]);
    }
    return ok({ kind, points, surfaces: [], triangles: [] });
  }
  if (kind === 'surfaces') {
    const surfaces = checkedSurfaces(input.surfaces, 'target surfaces');
    if (!surfaces.ok) return surfaces;
    return ok({ kind, points: [], surfaces: surfaces.value, triangles: [] });
  }

  const mesh = input.mesh;
  if (typeof mesh !== 'object' || mesh === null)
    return invalid('target mesh has finite positions and triangle indices');
  const positions = (mesh as { positions?: unknown }).positions;
  const indices = (mesh as { indices?: unknown }).indices;
  const isArrayLike = (value: unknown): value is ArrayLike<number> =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { length?: unknown }).length === 'number' &&
    Number.isInteger((value as { length: number }).length) &&
    (value as { length: number }).length >= 0;
  if (!isArrayLike(positions) || positions.length % 3 !== 0)
    return invalid('mesh positions are finite triples', {
      length: isArrayLike(positions) ? positions.length : undefined,
    });
  if (!isArrayLike(indices) || indices.length % 3 !== 0)
    return invalid('mesh indices contain complete triangles', {
      length: isArrayLike(indices) ? indices.length : undefined,
    });
  const values = Array.from({ length: positions.length }, (_, index) => positions[index] as number);
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)))
    return invalid('mesh positions are finite triples');
  const vertexCount = positions.length / 3;
  const indexValues: number[] = [];
  for (let index = 0; index < indices.length; index++) {
    const value = indices[index] as number;
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount)
      return invalid('mesh indices are integers within the position array', {
        at: index,
        index: value,
        vertexCount,
      });
    indexValues.push(value);
  }
  const triangles: Triangle[] = [];
  for (let index = 0; index < indexValues.length; index += 3) {
    triangles.push(
      triangleFor(
        pointAt(values, indexValues[index] as number),
        pointAt(values, indexValues[index + 1] as number),
        pointAt(values, indexValues[index + 2] as number),
        index / 3,
      ),
    );
  }
  const points = Array.from({ length: vertexCount }, (_, index) => pointAt(values, index));
  return ok({ kind: 'mesh', points, surfaces: [], triangles });
}

function squaredDistance(a: Tuple3, b: Tuple3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

function pointBoxDistanceSquared(point: Tuple3, min: Tuple3, max: Tuple3): number {
  let distanceSquared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const coordinate = point[axis] as number;
    const delta =
      coordinate < (min[axis] as number)
        ? (min[axis] as number) - coordinate
        : coordinate > (max[axis] as number)
          ? coordinate - (max[axis] as number)
          : 0;
    distanceSquared += delta * delta;
  }
  return distanceSquared;
}

function buildTriangleTree(triangles: readonly Triangle[]): TriangleNode | undefined {
  if (triangles.length === 0) return undefined;
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  const centerMin: Tuple3 = [Infinity, Infinity, Infinity];
  const centerMax: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] as number, triangle.min[axis] as number);
      max[axis] = Math.max(max[axis] as number, triangle.max[axis] as number);
      centerMin[axis] = Math.min(centerMin[axis] as number, triangle.center[axis] as number);
      centerMax[axis] = Math.max(centerMax[axis] as number, triangle.center[axis] as number);
    }
  }
  if (triangles.length <= 8) return { min, max, triangles };
  let axis = 0;
  for (let candidate = 1; candidate < 3; candidate++)
    if (
      (centerMax[candidate] as number) - (centerMin[candidate] as number) >
      (centerMax[axis] as number) - (centerMin[axis] as number)
    )
      axis = candidate;
  const ordered = [...triangles].sort(
    (a, b) => (a.center[axis] as number) - (b.center[axis] as number) || a.index - b.index,
  );
  const middle = Math.floor(ordered.length / 2);
  return {
    min,
    max,
    left: buildTriangleTree(ordered.slice(0, middle)) as TriangleNode,
    right: buildTriangleTree(ordered.slice(middle)) as TriangleNode,
  };
}

function closestOnSegment(point: Tuple3, a: Tuple3, b: Tuple3): Tuple3 {
  const ab = sub(b, a);
  const denominator = dot(ab, ab);
  if (denominator === 0) return a;
  const ap = sub(point, a);
  const t = Math.min(1, Math.max(0, dot(ap, ab) / denominator));
  return [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
}

function closestOnTriangle(point: Tuple3, a: Tuple3, b: Tuple3, c: Tuple3): Tuple3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const normal = cross(ab, ac);
  if (dot(normal, normal) === 0) {
    const candidates = [
      closestOnSegment(point, a, b),
      closestOnSegment(point, b, c),
      closestOnSegment(point, c, a),
    ];
    let closest = candidates[0] as Tuple3;
    let best = squaredDistance(point, closest);
    for (let index = 1; index < candidates.length; index++) {
      const candidate = candidates[index] as Tuple3;
      const distance = squaredDistance(point, candidate);
      if (distance < best) {
        closest = candidate;
        best = distance;
      }
    }
    return closest;
  }
  const ap = sub(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }
  const cp = sub(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    const bc = sub(c, b);
    return [b[0] + w * bc[0], b[1] + w * bc[1], b[2] + w * bc[2]];
  }
  const denominator = va + vb + vc;
  const v = vb / denominator;
  const w = vc / denominator;
  return [a[0] + v * ab[0] + w * ac[0], a[1] + v * ab[1] + w * ac[1], a[2] + v * ab[2] + w * ac[2]];
}

function closestOnMesh(
  point: Tuple3,
  root: TriangleNode | undefined,
): { point: Tuple3; distance: number } | undefined {
  if (root === undefined) return undefined;
  let bestPoint: Tuple3 | undefined;
  let bestSquared = Infinity;
  const visit = (node: TriangleNode) => {
    if (pointBoxDistanceSquared(point, node.min, node.max) >= bestSquared) return;
    if (node.triangles !== undefined) {
      for (const triangle of node.triangles) {
        const candidate = closestOnTriangle(point, triangle.a, triangle.b, triangle.c);
        const distance = squaredDistance(point, candidate);
        if (distance < bestSquared) {
          bestSquared = distance;
          bestPoint = candidate;
        }
      }
      return;
    }
    const left = node.left;
    const right = node.right;
    if (left === undefined || right === undefined) return;
    if (
      pointBoxDistanceSquared(point, left.min, left.max) <=
      pointBoxDistanceSquared(point, right.min, right.max)
    ) {
      visit(left);
      visit(right);
    } else {
      visit(right);
      visit(left);
    }
  };
  visit(root);
  return bestPoint === undefined
    ? undefined
    : { point: bestPoint, distance: Math.sqrt(bestSquared) };
}

function normalFromDerivatives(derivatives: Tuple3[][]): Tuple3 | undefined {
  const su = (derivatives[1] as Tuple3[])[0] as Tuple3;
  const sv = (derivatives[0] as Tuple3[])[1] as Tuple3;
  const product = cross(su, sv);
  const magnitude = length(product);
  return magnitude > 0 && Number.isFinite(magnitude)
    ? [product[0] / magnitude, product[1] / magnitude, product[2] / magnitude]
    : undefined;
}

function signedDistance(
  point: Tuple3,
  foot: Tuple3,
  distance: number,
  normal: Tuple3 | undefined,
): number {
  if (distance === 0 || normal === undefined) return distance;
  return (dot(sub(point, foot), normal) < 0 ? -1 : 1) * distance;
}

function patchOf(surface: NurbsSurface): Patch {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const row of surface.points) {
    for (const point of row) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis] as number, point[axis] as number);
        max[axis] = Math.max(max[axis] as number, point[axis] as number);
      }
    }
  }
  return { surface, closest: surfaceLocator(surface), min, max };
}

/** The locator's foot point, then damped Gauss-Newton steps that only ever shorten the distance. */
function closestOnPatch(patch: Patch, point: Tuple3): Omit<ClosestSurface, 'patch'> {
  const { surface } = patch;
  const initial = patch.closest(point);
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  let u = initial.u;
  let v = initial.v;
  let foot = initial.point;
  let bestSquared = squaredDistance(point, foot);
  for (let iteration = 0; iteration < 40; iteration++) {
    const derivatives = surfaceDerivatives(surface, u, v, 1);
    const su = (derivatives[1] as Tuple3[])[0] as Tuple3;
    const sv = (derivatives[0] as Tuple3[])[1] as Tuple3;
    const residual = sub(foot, point);
    const a = dot(su, su);
    const b = dot(su, sv);
    const c = dot(sv, sv);
    const determinant = a * c - b * b;
    if (!(determinant > 0) || !Number.isFinite(determinant)) break;
    const ru = dot(su, residual);
    const rv = dot(sv, residual);
    const du = (c * ru - b * rv) / determinant;
    const dv = (a * rv - b * ru) / determinant;
    // The locator has converged: the step is below the parameter resolution.
    if (Math.abs(du) <= 1e-13 * (u1 - u0) && Math.abs(dv) <= 1e-13 * (v1 - v0)) break;
    let accepted = false;
    for (let scale = 1; scale >= 1 / 1024; scale /= 2) {
      const candidateU = Math.min(u1, Math.max(u0, u - scale * du));
      const candidateV = Math.min(v1, Math.max(v0, v - scale * dv));
      if (candidateU === u && candidateV === v) continue;
      const candidate = surfacePoint(surface, candidateU, candidateV);
      const candidateSquared = squaredDistance(point, candidate);
      if (candidateSquared < bestSquared) {
        u = candidateU;
        v = candidateV;
        foot = candidate;
        bestSquared = candidateSquared;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  const derivatives = surfaceDerivatives(surface, u, v, 1);
  return {
    point: foot,
    normal: normalFromDerivatives(derivatives),
    distance: Math.sqrt(bestSquared),
    u,
    v,
  };
}

/** The nearest patch; a patch whose control-net bounds are no closer than the best foot is skipped. */
function closestOnPatches(patches: readonly Patch[], point: Tuple3): ClosestSurface | undefined {
  let best: ClosestSurface | undefined;
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index] as Patch;
    if (
      best !== undefined &&
      pointBoxDistanceSquared(point, patch.min, patch.max) >= best.distance * best.distance
    )
      continue;
    const hit = closestOnPatch(patch, point);
    if (best === undefined || hit.distance < best.distance) best = { ...hit, patch: index };
  }
  return best;
}

function surfaceSamples(
  surfaces: readonly NurbsSurface[],
  samples: number,
): { point: Tuple3; patch: number; u: number; v: number; normal: Tuple3 | undefined }[] {
  const output: {
    point: Tuple3;
    patch: number;
    u: number;
    v: number;
    normal: Tuple3 | undefined;
  }[] = [];
  for (let patch = 0; patch < surfaces.length; patch++) {
    const surface = surfaces[patch] as NurbsSurface;
    const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
    for (let i = 0; i < samples; i++) {
      const u = u0 + ((u1 - u0) * i) / (samples - 1);
      for (let j = 0; j < samples; j++) {
        const v = v0 + ((v1 - v0) * j) / (samples - 1);
        const derivatives = surfaceDerivatives(surface, u, v, 1);
        output.push({
          point: (derivatives[0] as Tuple3[])[0] as Tuple3,
          patch,
          u,
          v,
          normal: normalFromDerivatives(derivatives),
        });
      }
    }
  }
  return output;
}

function sideOf(
  measurements: readonly Measurement[],
  bandLimits: readonly number[],
): DeviationSide {
  if (measurements.length === 0) {
    return {
      count: 0,
      max: 0,
      mean: 0,
      rms: 0,
      p95: 0,
      signed: [0, 0],
      worst: { point: [0, 0, 0], onSurface: [0, 0, 0], patch: -1, u: 0, v: 0, distance: 0 },
      bands: bandLimits.map((limit) => ({ limit, share: 0 })),
    };
  }
  let sum = 0;
  let squares = 0;
  let low = Infinity;
  let high = -Infinity;
  let worst = measurements[0] as Measurement;
  for (const measurement of measurements) {
    sum += measurement.magnitude;
    squares += measurement.magnitude * measurement.magnitude;
    low = Math.min(low, measurement.signed);
    high = Math.max(high, measurement.signed);
    if (measurement.magnitude > worst.magnitude) worst = measurement;
  }
  const sorted = measurements.map((measurement) => measurement.magnitude).sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] as number;
  return {
    count: measurements.length,
    max,
    mean: sum / measurements.length,
    rms: Math.sqrt(squares / measurements.length),
    p95: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number,
    signed: [low, high],
    worst: worst.place,
    bands: bandLimits.map((limit) => ({
      limit,
      share:
        measurements.filter((measurement) => measurement.magnitude <= limit).length /
        measurements.length,
    })),
  };
}

function record(
  point: Tuple3,
  foot: Tuple3,
  normal: Tuple3 | undefined,
  distance: number,
  patch: number,
  u: number,
  v: number,
): Measurement {
  const signed = signedDistance(point, foot, distance, normal);
  return {
    magnitude: distance,
    signed,
    place: { point, onSurface: foot, patch, u, v, distance: signed },
  };
}

/** Compare target samples with NURBS patches and, for meshes/surfaces, sample the reverse direction too. */
export function surfaceDeviation(
  surfaces: readonly NurbsSurface[],
  target: DeviationTarget,
  options: DeviationOptions = {},
): Result<DeviationReport, ModelingError> {
  const checked = checkedSurfaces(surfaces, 'surfaces');
  if (!checked.ok) return checked;
  if (typeof options !== 'object' || options === null)
    return invalid('options are a valid deviation-options object');
  const tolerance = options.tolerance ?? 1e-4;
  if (!(typeof tolerance === 'number' && Number.isFinite(tolerance) && tolerance > 0))
    return invalid('tolerance is finite and positive', { tolerance });
  const samples = options.samples ?? 24;
  if (!Number.isInteger(samples) || samples < 2)
    return invalid('samples is an integer >= 2', { samples });
  const bands = options.bands ?? [tolerance / 4, tolerance / 2, tolerance, 2 * tolerance];
  if (
    !Array.isArray(bands) ||
    bands.some((band) => typeof band !== 'number' || !Number.isFinite(band) || band < 0) ||
    bands.some((band, index) => index > 0 && band < (bands[index - 1] as number))
  )
    return invalid('bands are finite, non-negative and increasing', { bands });
  const prepared = prepareTarget(target);
  if (!prepared.ok) return prepared;
  const targetData = prepared.value;
  const inputSurfaces = checked.value;
  const inputPatches = inputSurfaces.map(patchOf);
  const bandLimits = bands as readonly number[];
  const toSurfaces: Measurement[] = [];
  const targetSamples =
    targetData.kind === 'surfaces'
      ? surfaceSamples(targetData.surfaces, samples).map(({ point }) => point)
      : targetData.kind === 'mesh'
        ? [
            ...targetData.points,
            ...targetData.triangles.map(
              (triangle): Tuple3 => [
                (triangle.a[0] + triangle.b[0] + triangle.c[0]) / 3,
                (triangle.a[1] + triangle.b[1] + triangle.c[1]) / 3,
                (triangle.a[2] + triangle.b[2] + triangle.c[2]) / 3,
              ],
            ),
          ]
        : targetData.points;
  for (const point of targetSamples) {
    const hit = closestOnPatches(inputPatches, point);
    if (hit !== undefined)
      toSurfaces.push(record(point, hit.point, hit.normal, hit.distance, hit.patch, hit.u, hit.v));
  }

  let toTargetMeasurements: Measurement[] | undefined;
  if (targetData.kind === 'mesh' && targetData.triangles.length > 0) {
    const tree = buildTriangleTree(targetData.triangles);
    toTargetMeasurements = [];
    for (const sample of surfaceSamples(inputSurfaces, samples)) {
      const hit = closestOnMesh(sample.point, tree);
      if (hit !== undefined)
        toTargetMeasurements.push(
          record(
            sample.point,
            hit.point,
            sample.normal,
            hit.distance,
            sample.patch,
            sample.u,
            sample.v,
          ),
        );
    }
  } else if (targetData.kind === 'surfaces' && targetData.surfaces.length > 0) {
    toTargetMeasurements = [];
    const targetPatches = targetData.surfaces.map(patchOf);
    for (const sample of surfaceSamples(inputSurfaces, samples)) {
      const hit = closestOnPatches(targetPatches, sample.point);
      if (hit !== undefined)
        toTargetMeasurements.push(
          record(sample.point, hit.point, hit.normal, hit.distance, hit.patch, hit.u, hit.v),
        );
    }
  }

  const forward = sideOf(toSurfaces, bandLimits);
  const reverse =
    toTargetMeasurements === undefined ? undefined : sideOf(toTargetMeasurements, bandLimits);
  const measured = [forward, ...(reverse === undefined ? [] : [reverse])].filter(
    (side) => side.count > 0,
  );
  const pass = measured.length > 0 && measured.every((side) => side.max <= tolerance);
  const issues: Issue<DeviationCode>[] = [];
  const addExceeded = (side: 'toSurfaces' | 'toTarget', value: DeviationSide) => {
    if (value.count > 0 && value.max > tolerance)
      issues.push({
        code: 'deviation-exceeded',
        severity: 'warn',
        detail: {
          side,
          max: value.max,
          tolerance,
          point: value.worst.point,
          patch: value.worst.patch,
          u: value.worst.u,
          v: value.worst.v,
        },
      });
  };
  addExceeded('toSurfaces', forward);
  if (reverse !== undefined) addExceeded('toTarget', reverse);
  if (measured.length === 0)
    issues.push({
      code: 'nothing-checked',
      severity: 'warn',
      detail: { subject: '', reason: 'no NURBS patches or target samples to compare' },
    });
  return ok({
    pass,
    tolerance,
    toSurfaces: forward,
    ...(reverse === undefined ? {} : { toTarget: reverse }),
    issues,
  });
}
