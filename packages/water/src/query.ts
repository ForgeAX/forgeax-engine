import { err, ok } from '@forgeax/engine-types';
import { interpolateWaterSplineRotation, resolveWaterSplinePoints } from './body-spline.js';
import type {
  Vec3,
  WaterBakedQueryGrid,
  WaterBodySnapshot,
  WaterError,
  WaterOperationObserver,
  WaterQueryField,
  WaterQueryInput,
  WaterQueryResult,
  WaterTerrainQuerySample,
} from './contracts.js';
import { WaterQueryFlags } from './contracts.js';
export type WaterQueryBodySnapshot = Pick<
  WaterBodySnapshot,
  | 'guid'
  | 'sceneGeneration'
  | 'asset'
  | 'worldMatrixM'
  | 'binding'
  | 'dependencies'
  | 'exclusionVolumes'
>;

import { beginWaterOperation, endWaterOperation } from './operation-observation.js';
import {
  closingWaterSplinePoint,
  nearestPreparedWaterSplineKey,
  type WaterQuerySplinePreparation,
  waterSplinePolynomialRoots,
} from './query-spline.js';
import { requireWaterValue } from './required-value.js';
import {
  evaluateGerstnerWavesCpuFull,
  evaluateGerstnerWavesCpuSimple,
  prepareWaterBodyWaves,
  type WaterBodyWavePreparation,
  waterWaveDepthAttenuation,
} from './waves.js';

type SplineSample = {
  readonly key: number;
  readonly positionM: Vec3;
  readonly tangentM: Vec3;
  readonly up: Vec3;
  readonly depthM: number;
  readonly velocityMPerSec: number;
};
const FALLBACK_OCEAN_DEPTH_M = 30;
function queryError(
  code: WaterError['code'],
  expected: string,
  hint: string,
  detail?: unknown,
): WaterError {
  return { code, expected, hint, ...(detail === undefined ? {} : { detail }) };
}
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
function transformPoint(m: readonly number[], p: Vec3): Vec3 {
  return [
    requireWaterValue(m[0]) * p[0] +
      requireWaterValue(m[4]) * p[1] +
      requireWaterValue(m[8]) * p[2] +
      requireWaterValue(m[12]),
    requireWaterValue(m[1]) * p[0] +
      requireWaterValue(m[5]) * p[1] +
      requireWaterValue(m[9]) * p[2] +
      requireWaterValue(m[13]),
    requireWaterValue(m[2]) * p[0] +
      requireWaterValue(m[6]) * p[1] +
      requireWaterValue(m[10]) * p[2] +
      requireWaterValue(m[14]),
  ];
}
function transformNormal(m: readonly number[], v: Vec3): Vec3 {
  const a = requireWaterValue(m[0]),
    b = requireWaterValue(m[4]),
    c = requireWaterValue(m[8]),
    d = requireWaterValue(m[1]),
    e = requireWaterValue(m[5]),
    f = requireWaterValue(m[9]),
    g = requireWaterValue(m[2]),
    h = requireWaterValue(m[6]),
    i = requireWaterValue(m[10]);
  const A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (Math.abs(determinant) < 1e-12) return normalize(v);
  const inverseTranspose: Vec3 = [
    A * v[0] + B * v[1] + C * v[2],
    (c * h - b * i) * v[0] + (a * i - c * g) * v[1] + (c * d - a * f) * v[2],
    (b * f - c * e) * v[0] + (b * g - a * h) * v[1] + (a * e - b * d) * v[2],
  ];
  return normalize([
    inverseTranspose[0] / determinant,
    inverseTranspose[1] / determinant,
    inverseTranspose[2] / determinant,
  ]);
}
function evaluateSegment(
  a: ReturnType<typeof resolveWaterSplinePoints>[number],
  b: ReturnType<typeof resolveWaterSplinePoints>[number],
  key: number,
): SplineSample {
  const keyDelta = b.inputKey - a.inputKey;
  const t = keyDelta > 0 ? Math.max(0, Math.min(1, (key - a.inputKey) / keyDelta)) : 0;
  const linear = a.interpolationMode === 'linear';
  const positionAt = (axis: 0 | 1 | 2) => {
    const p0 = requireWaterValue(a.positionM[axis]),
      p1 = requireWaterValue(b.positionM[axis]);
    if (linear) return p0 + (p1 - p0) * t;
    const m0 = requireWaterValue(a.leaveTangentM[axis]) * keyDelta,
      m1 = requireWaterValue(b.arriveTangentM[axis]) * keyDelta;
    return (
      (2 * t ** 3 - 3 * t ** 2 + 1) * p0 +
      (t ** 3 - 2 * t ** 2 + t) * m0 +
      (-2 * t ** 3 + 3 * t ** 2) * p1 +
      (t ** 3 - t ** 2) * m1
    );
  };
  const position: Vec3 = [positionAt(0), positionAt(1), positionAt(2)];
  const tangentAt = (axis: 0 | 1 | 2) => {
    const p0 = requireWaterValue(a.positionM[axis]),
      p1 = requireWaterValue(b.positionM[axis]);
    if (linear) return (p1 - p0) / Math.max(keyDelta, 1e-8);
    return (
      ((6 * t ** 2 - 6 * t) * p0 +
        (3 * t ** 2 - 4 * t + 1) * requireWaterValue(a.leaveTangentM[axis]) * keyDelta +
        (-6 * t ** 2 + 6 * t) * p1 +
        (3 * t ** 2 - 2 * t) * requireWaterValue(b.arriveTangentM[axis]) * keyDelta) /
      Math.max(keyDelta, 1e-8)
    );
  };
  const tangent: Vec3 = [tangentAt(0), tangentAt(1), tangentAt(2)];
  const metadata = (field: 'depthM' | 'velocityMPerSec') => a[field] + (b[field] - a[field]) * t;
  const rotation = interpolateWaterSplineRotation(a, b, t);
  const up = rotation
    ? ([
        2 * (rotation[0] * rotation[1] - rotation[3] * rotation[2]),
        1 - 2 * (rotation[0] ** 2 + rotation[2] ** 2),
        2 * (rotation[1] * rotation[2] + rotation[3] * rotation[0]),
      ] satisfies Vec3)
    : normalize([
        a.up[0] + (b.up[0] - a.up[0]) * t,
        a.up[1] + (b.up[1] - a.up[1]) * t,
        a.up[2] + (b.up[2] - a.up[2]) * t,
      ]);
  return {
    key,
    positionM: position,
    tangentM: tangent,
    up,
    depthM: metadata('depthM'),
    velocityMPerSec: metadata('velocityMPerSec'),
  };
}
function splineAtKey(
  snapshot: WaterQueryBodySnapshot,
  key: number,
  preparation?: WaterQuerySplinePreparation,
): SplineSample | undefined {
  const points = preparation?.points ?? resolveWaterSplinePoints(snapshot.asset.spline);
  if (points.length === 0) return undefined;
  const step =
    points.length > 1
      ? requireWaterValue(points[1]).inputKey - requireWaterValue(points[0]).inputKey || 1
      : 0;
  const minKey = requireWaterValue(points[0]).inputKey;
  const maxKey =
    requireWaterValue(points.at(-1)).inputKey +
    (snapshot.asset.spline.closed && points.length > 1 ? step : 0);
  if (key < minKey || key > maxKey) return undefined;
  if (points.length === 1) {
    const point = requireWaterValue(points[0]);
    return {
      key,
      positionM: point.positionM,
      tangentM: point.leaveTangentM,
      up: point.up,
      depthM: point.depthM,
      velocityMPerSec: point.velocityMPerSec,
    };
  }
  if (snapshot.asset.spline.closed && key >= requireWaterValue(points.at(-1)).inputKey)
    return evaluateSegment(
      requireWaterValue(points.at(-1)),
      closingWaterSplinePoint(points, step),
      key <= requireWaterValue(points.at(-1)).inputKey + step
        ? key
        : requireWaterValue(points.at(-1)).inputKey + step,
    );
  if (key === requireWaterValue(points[0]).inputKey)
    return evaluateSegment(requireWaterValue(points[0]), requireWaterValue(points[1]), key);
  if (key === requireWaterValue(points.at(-1)).inputKey)
    return evaluateSegment(requireWaterValue(points.at(-2)), requireWaterValue(points.at(-1)), key);
  const index = points.findIndex(
    (_, i) => i + 1 < points.length && key <= requireWaterValue(points[i + 1]).inputKey,
  );
  return index < 0
    ? undefined
    : evaluateSegment(requireWaterValue(points[index]), requireWaterValue(points[index + 1]), key);
}
function inverseTransformPoint(m: readonly number[], p: Vec3): Vec3 {
  const a = requireWaterValue(m[0]),
    b = requireWaterValue(m[4]),
    c = requireWaterValue(m[8]),
    d = requireWaterValue(m[1]),
    e = requireWaterValue(m[5]),
    f = requireWaterValue(m[9]),
    g = requireWaterValue(m[2]),
    h = requireWaterValue(m[6]),
    i = requireWaterValue(m[10]);
  const A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (Math.abs(determinant) < 1e-12) return p;
  const relative: Vec3 = [
    p[0] - requireWaterValue(m[12]),
    p[1] - requireWaterValue(m[13]),
    p[2] - requireWaterValue(m[14]),
  ];
  const cross = (u: Vec3, v: Vec3): Vec3 => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const c0: Vec3 = [a, d, g],
    c1: Vec3 = [b, e, h],
    c2: Vec3 = [c, f, i];
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return [
    dot(relative, cross(c1, c2)) / determinant,
    dot(relative, cross(c2, c0)) / determinant,
    dot(relative, cross(c0, c1)) / determinant,
  ];
}
function nearestSplineKey(
  snapshot: WaterQueryBodySnapshot,
  positionM: Vec3,
  preparation?: WaterQuerySplinePreparation,
): number {
  if (preparation !== undefined)
    return nearestPreparedWaterSplineKey(
      preparation,
      inverseTransformPoint(snapshot.worldMatrixM, positionM),
    );
  const points = resolveWaterSplinePoints(snapshot.asset.spline);
  if (points.length < 2) return points[0]?.inputKey ?? 0;
  const localPosition = inverseTransformPoint(snapshot.worldMatrixM, positionM);
  const segmentCount = snapshot.asset.spline.closed ? points.length : points.length - 1;
  const step = requireWaterValue(points[1]).inputKey - requireWaterValue(points[0]).inputKey || 1;
  let bestKey = requireWaterValue(points[0]).inputKey,
    bestDistance = Number.POSITIVE_INFINITY;
  for (let segment = 0; segment < segmentCount; segment++) {
    const a = requireWaterValue(points[segment]),
      b =
        segment + 1 < points.length
          ? requireWaterValue(points[segment + 1])
          : closingWaterSplinePoint(points, step);
    const delta = b.inputKey - a.inputKey;
    const vectors =
      a.interpolationMode === 'linear'
        ? [
            a.positionM.map((value, axis) => value - requireWaterValue(localPosition[axis])),
            a.leaveTangentM.map(
              (_, axis) =>
                requireWaterValue(b.positionM[axis]) - requireWaterValue(a.positionM[axis]),
            ),
            [0, 0, 0],
            [0, 0, 0],
          ]
        : [
            a.positionM.map((value, axis) => value - requireWaterValue(localPosition[axis])),
            a.leaveTangentM.map((value) => value * delta),
            [0, 1, 2].map(
              (axis) =>
                -3 *
                  (requireWaterValue(a.positionM[axis]) - requireWaterValue(localPosition[axis])) -
                2 * requireWaterValue(a.leaveTangentM[axis]) * delta -
                requireWaterValue(b.arriveTangentM[axis]) * delta +
                3 * (requireWaterValue(b.positionM[axis]) - requireWaterValue(localPosition[axis])),
            ),
            [0, 1, 2].map(
              (axis) =>
                2 *
                  (requireWaterValue(a.positionM[axis]) - requireWaterValue(localPosition[axis])) +
                requireWaterValue(a.leaveTangentM[axis]) * delta +
                requireWaterValue(b.arriveTangentM[axis]) * delta -
                2 * (requireWaterValue(b.positionM[axis]) - requireWaterValue(localPosition[axis])),
            ),
          ];
    const distanceAt = (t: number) => {
      const point = [0, 1, 2].map(
        (axis) =>
          requireWaterValue(requireWaterValue(vectors[0])[axis]) +
          requireWaterValue(requireWaterValue(vectors[1])[axis]) * t +
          requireWaterValue(requireWaterValue(vectors[2])[axis]) * t ** 2 +
          requireWaterValue(requireWaterValue(vectors[3])[axis]) * t ** 3,
      );
      return (
        requireWaterValue(point[0]) ** 2 +
        requireWaterValue(point[1]) ** 2 +
        requireWaterValue(point[2]) ** 2
      );
    };
    let candidates = [0, 1];
    if (a.interpolationMode !== 'linear') {
      const coefficients = Array.from({ length: 6 }, (_, degree) => {
        let value = 0;
        for (let axis = 0; axis < 3; axis++)
          for (let left = 0; left < 4; left++)
            for (let right = 1; right < 4; right++) {
              if (left + right - 1 === degree)
                value +=
                  requireWaterValue(requireWaterValue(vectors[left])[axis]) *
                  right *
                  requireWaterValue(requireWaterValue(vectors[right])[axis]);
            }
        return value;
      });
      candidates.push(...waterSplinePolynomialRoots(coefficients));
    } else {
      const direction = requireWaterValue(vectors[1]);
      const denominator = direction.reduce((sum, value) => sum + value * value, 0);
      const t =
        denominator > 0
          ? Math.max(
              0,
              Math.min(
                1,
                -requireWaterValue(vectors[0]).reduce(
                  (sum, value, axis) => sum + value * requireWaterValue(direction[axis]),
                  0,
                ) / denominator,
              ),
            )
          : 0;
      candidates = [0, 1, t];
    }
    for (const t of candidates) {
      const distance = distanceAt(t);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = a.inputKey + delta * t;
      }
    }
  }
  return bestKey;
}

/** Current accepted world spline geometry for the synchronous River force owner. */
export function waterSplineSample(
  snapshot: WaterQueryBodySnapshot,
  positionM: Vec3,
): Readonly<{ key: number; positionM: Vec3; tangent: Vec3; speedMps: number }> | undefined {
  const key = nearestSplineKey(snapshot, positionM);
  const sample = splineAtKey(snapshot, key);
  if (!sample) return undefined;
  const origin = transformPoint(snapshot.worldMatrixM, [0, 0, 0]);
  const tangent = transformPoint(snapshot.worldMatrixM, sample.tangentM);
  return Object.freeze({
    key,
    positionM: transformPoint(snapshot.worldMatrixM, sample.positionM),
    tangent: normalize([tangent[0] - origin[0], tangent[1] - origin[1], tangent[2] - origin[2]]),
    speedMps: sample.velocityMPerSec,
  });
}
function pointInExclusion(
  position: Vec3,
  volume: WaterBodySnapshot['exclusionVolumes'][number],
): boolean {
  const m = volume.worldMatrixM;
  const c0: Vec3 = [requireWaterValue(m[0]), requireWaterValue(m[1]), requireWaterValue(m[2])],
    c1: Vec3 = [requireWaterValue(m[4]), requireWaterValue(m[5]), requireWaterValue(m[6])],
    c2: Vec3 = [requireWaterValue(m[8]), requireWaterValue(m[9]), requireWaterValue(m[10])];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = dot(c0, cross(c1, c2));
  if (Math.abs(determinant) < 1e-12) return false;
  const relative: Vec3 = [
    position[0] - requireWaterValue(m[12]),
    position[1] - requireWaterValue(m[13]),
    position[2] - requireWaterValue(m[14]),
  ];
  const local: Vec3 = [
    dot(relative, cross(c1, c2)) / determinant,
    dot(relative, cross(c2, c0)) / determinant,
    dot(relative, cross(c0, c1)) / determinant,
  ];
  return local.every(
    (value, axis) =>
      Math.abs(value - requireWaterValue(volume.centerM[axis])) <=
      requireWaterValue(volume.halfExtentsM[axis]) + 1e-8,
  );
}
function immutableQueryFields(fields: Set<WaterQueryField>): ReadonlySet<WaterQueryField> {
  let view: ReadonlySet<WaterQueryField>;
  view = Object.freeze({
    get size() {
      return fields.size;
    },
    has: (field: WaterQueryField) => fields.has(field),
    entries: () => fields.entries(),
    keys: () => fields.keys(),
    values: () => fields.values(),
    [Symbol.iterator]: () => fields[Symbol.iterator](),
    forEach: (
      callback: (
        value: WaterQueryField,
        value2: WaterQueryField,
        set: ReadonlySet<WaterQueryField>,
      ) => void,
      thisArg?: unknown,
    ) => {
      fields.forEach((field) => {
        callback.call(thisArg, field, field, view);
      });
    },
  });
  return view;
}
export function waterQueryNeedsTerrain(
  snapshot: WaterBodySnapshot | undefined,
  input: WaterQueryInput,
): boolean {
  return preparedWaterQueryNeedsTerrain(snapshot, input);
}

/** Internal Admitted Body route. */
export function preparedWaterQueryNeedsTerrain(
  snapshot: WaterQueryBodySnapshot | undefined,
  input: WaterQueryInput,
  preparation?: WaterBodyWavePreparation,
): boolean {
  if (!snapshot || (snapshot.asset.type !== 'lake' && snapshot.asset.type !== 'ocean'))
    return false;
  const F = WaterQueryFlags;
  const flags = input.flags;
  if (input.baked?.enabled && input.baked.componentValid && input.baked.dataValid) return false;
  if ((flags & (F.ComputeDepth | F.ComputeImmersionDepth)) !== 0) return true;
  const companions = F.ComputeLocation | F.ComputeNormal | F.ComputeDepth | F.ComputeImmersionDepth;
  if (
    (flags & F.IncludeWaves) === 0 ||
    (flags & companions) === 0 ||
    ((flags & F.SimpleWaves) !== 0 && (flags & F.IncludeWaves) === 0) ||
    !snapshot.asset.waveSetGuid
  )
    return false;
  return (preparation ?? prepareWaterBodyWaves(snapshot)).cooked?.ok === true;
}
function isQueryableBakedGrid(grid: WaterBakedQueryGrid): boolean {
  return !(
    !grid ||
    typeof grid !== 'object' ||
    Array.isArray(grid) ||
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width < 3 ||
    grid.height < 3 ||
    !Number.isFinite(grid.originY) ||
    !Array.isArray(grid.originXZ) ||
    grid.originXZ.length !== 2 ||
    !Array.from(grid.originXZ).every(Number.isFinite) ||
    !Array.isArray(grid.spacingXZ) ||
    grid.spacingXZ.length !== 2 ||
    !Array.from(grid.spacingXZ).every((value) => Number.isFinite(value) && value > 0) ||
    !(grid.samples instanceof Float32Array) ||
    grid.samples.length !== grid.width * grid.height * 4
  );
}

function sampleBaked(
  grid: WaterBakedQueryGrid,
  x: number,
  z: number,
):
  | {
      height: number;
      depth: number;
      vx: number;
      vz: number;
    }
  | undefined {
  if (!isQueryableBakedGrid(grid)) return undefined;
  const fx = (x - grid.originXZ[0]) / grid.spacingXZ[0],
    fz = (z - grid.originXZ[1]) / grid.spacingXZ[1];
  if (!(fx > 0 && fx < grid.width - 1 && fz > 0 && fz < grid.height - 1))
    return { height: 0, depth: 0, vx: 0, vz: 0 };
  const x0 = Math.floor(fx),
    z0 = Math.floor(fz),
    tx = fx - x0,
    tz = fz - z0;
  const read = (ix: number, iz: number, channel: number) =>
    requireWaterValue(grid.samples[(iz * grid.width + ix) * 4 + channel]);
  const interpolate = (channel: number) => {
    const a0 = read(x0, z0, channel),
      a1 = read(x0 + 1, z0, channel);
    const b0 = read(x0, z0 + 1, channel),
      b1 = read(x0 + 1, z0 + 1, channel);
    if (![a0, a1, b0, b1].every(Number.isFinite)) return undefined;
    const a = a0 * (1 - tx) + a1 * tx;
    const b = b0 * (1 - tx) + b1 * tx;
    return a * (1 - tz) + b * tz;
  };
  const values = [interpolate(0), interpolate(1), interpolate(2), interpolate(3)];
  if (values.some((value) => value === undefined)) return undefined;
  return {
    height: requireWaterValue(values[0]),
    depth: requireWaterValue(values[1]),
    vx: requireWaterValue(values[2]),
    vz: requireWaterValue(values[3]),
  };
}
export function queryWaterBodySnapshot(
  snapshot: WaterQueryBodySnapshot | undefined,
  input: WaterQueryInput,
  terrainSample?: WaterTerrainQuerySample,
  mode: 'synchronous' | 'solver-safe' = 'synchronous',
  observe?: WaterOperationObserver,
): import('@forgeax/engine-types').Result<WaterQueryResult, WaterError> {
  return queryPreparedWaterBodySnapshot(
    snapshot,
    input,
    terrainSample,
    mode,
    undefined,
    undefined,
    observe,
  );
}

/** Internal Admitted Body route. */
export function queryPreparedWaterBodySnapshot(
  snapshot: WaterQueryBodySnapshot | undefined,
  input: WaterQueryInput,
  terrainSample?: WaterTerrainQuerySample,
  mode: 'synchronous' | 'solver-safe' = 'synchronous',
  preparation?: WaterBodyWavePreparation,
  splinePreparation?: WaterQuerySplinePreparation,
  observe?: WaterOperationObserver,
): import('@forgeax/engine-types').Result<WaterQueryResult, WaterError> {
  if (!snapshot)
    return err(
      queryError(
        'body-unregistered',
        'a mounted, registered WaterBody instance',
        'mount the requested Scene WaterBody before querying it',
      ),
    );
  const validateQueryInput = () => {
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.positionM) ||
      input.positionM.length !== 3 ||
      !Array.from(input.positionM).every(Number.isFinite)
    )
      return err(
        queryError(
          'invalid-query-flags',
          'a three-component finite Water query position and complete query input',
          'repair the query inputs before requesting a WaterBody sample',
        ),
      );
    if (
      input.expectedBodyGeneration !== undefined &&
      input.expectedBodyGeneration !== snapshot.sceneGeneration
    )
      return err(
        queryError(
          'stale-generation',
          'the requested WaterBody generation matches the accepted Scene snapshot',
          'retry against the current body snapshot',
          { expected: input.expectedBodyGeneration, actual: snapshot.sceneGeneration },
        ),
      );
    if (
      ![...input.positionM, input.timeSeconds, input.flags].every(Number.isFinite) ||
      !Number.isSafeInteger(input.flags) ||
      input.flags < 0 ||
      (input.flags & ~0xff) !== 0 ||
      (input.splineKey !== undefined && !Number.isFinite(input.splineKey))
    )
      return err(
        queryError(
          'invalid-query-flags',
          'finite position/time/key and only Water query flag bits 0..7',
          'repair the query inputs before requesting a WaterBody sample',
          { flags: input.flags, splineKey: input.splineKey },
        ),
      );
    const validateTerrainGeneration = () => {
      if (
        terrainSample &&
        (!Number.isFinite(terrainSample.heightM) ||
          !terrainSample.providerGuid ||
          !Number.isSafeInteger(terrainSample.providerVersion) ||
          !Number.isSafeInteger(terrainSample.zoneGeneration) ||
          !Number.isSafeInteger(terrainSample.groundGeneration) ||
          snapshot.binding.kind !== 'bound' ||
          terrainSample.zoneGeneration !== snapshot.binding.zoneGeneration)
      )
        return err(
          queryError(
            'stale-generation',
            'the Terrain sample belongs to the Body current bound Zone generation',
            'discard the stale provider sample and retry the query against the current Zone ground snapshot',
            { terrainSample, binding: snapshot.binding },
          ),
        );

      return undefined;
    };
    return validateTerrainGeneration();
  };
  const validateQueryInputFailure = validateQueryInput();
  if (validateQueryInputFailure !== undefined) return validateQueryInputFailure;
  const F = WaterQueryFlags;
  let flags = input.flags;
  const has = (flag: number) => (flags & flag) !== 0;
  const admitQueryFlags = () => {
    if ((has(F.ComputeDepth) || has(F.ComputeImmersionDepth)) && !has(F.ComputeLocation))
      flags |= F.ComputeLocation;
    if (
      has(F.IncludeWaves) &&
      !(
        has(F.ComputeLocation) ||
        has(F.ComputeNormal) ||
        has(F.ComputeDepth) ||
        has(F.ComputeImmersionDepth)
      )
    )
      return err(
        queryError(
          'invalid-query-flags',
          'IncludeWaves accompanies location, normal, depth, or immersion',
          'add a query field flag before requesting waves',
        ),
      );
    if (has(F.SimpleWaves) && !has(F.IncludeWaves))
      return err(
        queryError(
          'invalid-query-flags',
          'SimpleWaves accompanies IncludeWaves',
          'request IncludeWaves with SimpleWaves',
        ),
      );
    return undefined;
  };
  const admitQueryFlagsFailure = admitQueryFlags();
  if (admitQueryFlagsFailure !== undefined) return admitQueryFlagsFailure;
  const resolveWaveAdmission = () => {
    const asset = snapshot.asset;
    let prepared: WaterBodyWavePreparation;
    if (preparation !== undefined) prepared = preparation;
    else {
      const scope = beginWaterOperation(observe, 'water/query/wave-preparation');
      try {
        prepared = prepareWaterBodyWaves(snapshot);
      } finally {
        endWaterOperation(scope);
      }
    }
    const waveDependency = prepared.dependency;
    const cookedWaves = prepared.cooked;
    const waveSupportedType =
      mode === 'solver-safe'
        ? asset.type === 'lake' || asset.type === 'ocean'
        : asset.type !== 'river';
    const supportsWaves = waveSupportedType && cookedWaves?.ok === true;
    if (has(F.IncludeWaves) && supportsWaves) flags |= F.ComputeLocation | F.ComputeDepth;
    const excluded =
      mode === 'synchronous' &&
      !has(F.IgnoreExclusionVolumes) &&
      snapshot.exclusionVolumes.some((volume) => pointInExclusion(input.positionM, volume));
    const admitWaveDependency = () => {
      if (
        !excluded &&
        waveSupportedType &&
        asset.waveSetGuid &&
        waveDependency?.status === 'valid' &&
        !cookedWaves?.ok &&
        has(F.IncludeWaves)
      )
        return err(
          queryError(
            'query-data-unavailable',
            'the specified body WaveSet has a valid cooked CPU wave closure',
            'refresh the body dependency snapshot and repair the WaveSet before querying waves',
            { waveSetGuid: asset.waveSetGuid },
          ),
        );
      if (
        !excluded &&
        waveSupportedType &&
        has(F.IncludeWaves) &&
        asset.waveSetGuid &&
        waveDependency?.status !== 'valid'
      )
        return err(
          queryError(
            'query-data-unavailable',
            'the specified Body WaveSet dependency is admitted and available',
            'refresh the body dependency snapshot before querying waves',
            { waveSetGuid: asset.waveSetGuid, status: waveDependency?.status ?? 'missing' },
          ),
        );
      return undefined;
    };
    const admitWaveDependencyFailure = admitWaveDependency();
    if (admitWaveDependencyFailure !== undefined) return admitWaveDependencyFailure;

    return ok({ asset, waveSupportedType, supportsWaves, excluded, cookedWaves });
  };
  const resolveWaveAdmissionResult = resolveWaveAdmission();
  if (!resolveWaveAdmissionResult.ok) return resolveWaveAdmissionResult;
  const { asset, supportsWaves, excluded, cookedWaves } = resolveWaveAdmissionResult.value;
  const valid = new Set<WaterQueryField>();
  const requested = (flag: number) => (flags & flag) !== 0;
  const wants = {
    location: requested(F.ComputeLocation),
    normal: requested(F.ComputeNormal),
    depth: requested(F.ComputeDepth),
    immersion: requested(F.ComputeImmersionDepth),
    velocity: requested(F.ComputeVelocity),
    waves: requested(F.IncludeWaves),
  };
  const bakedEnabled =
    mode === 'synchronous' &&
    input.baked?.enabled &&
    input.baked.componentValid &&
    input.baked.dataValid;
  const resolveBaseSurface = () => {
    let spline: SplineSample | undefined;
    let splineKey = input.splineKey;
    const flatBasePoint = transformPoint(snapshot.worldMatrixM, [
      0,
      asset.baseHeightM + (asset.type === 'ocean' ? (asset.heightOffsetM ?? 0) : 0),
      0,
    ]);
    const resolveRequestedSpline = () => {
      const needsSplineSample = (): boolean => {
        const nonFlatSplineSample =
          (asset.type === 'river' || asset.type === 'custom') &&
          (wants.normal || wants.depth || (!excluded && (wants.location || wants.velocity)));
        const lakeFallbackSplineSample =
          asset.type === 'lake' &&
          wants.depth &&
          !bakedEnabled &&
          (terrainSample === undefined || flatBasePoint[1] < terrainSample.heightM);
        const flatVelocitySplineSample =
          !excluded && wants.velocity && asset.spline.points.length > 0;
        const requiresSplineSample =
          nonFlatSplineSample || lakeFallbackSplineSample || flatVelocitySplineSample;

        return requiresSplineSample;
      };
      const requiresSplineSample = needsSplineSample();
      if (requiresSplineSample && asset.spline.points.length === 0)
        return err(
          queryError(
            'null-spline-metadata',
            'the specified Body has registered spline metadata for this query path',
            'repair the source spline metadata before querying this Body',
          ),
        );
      if (asset.spline.points.length && requiresSplineSample) {
        const scope = beginWaterOperation(observe, 'water/query/spline-evaluation');
        try {
          splineKey ??= nearestSplineKey(snapshot, input.positionM, splinePreparation);
          spline = splineAtKey(snapshot, splineKey, splinePreparation);
        } finally {
          endWaterOperation(scope);
        }
        if (!spline)
          return err(
            queryError(
              'query-data-unavailable',
              'the supplied spline input key selects a valid spline segment',
              'pass a valid key for this Body; query never relocates an explicit key',
              { splineKey },
            ),
          );
      }
      return undefined;
    };
    const resolveRequestedSplineFailure = resolveRequestedSpline();
    if (resolveRequestedSplineFailure !== undefined) return resolveRequestedSplineFailure;
    const basePoint =
      asset.type === 'river' || asset.type === 'custom'
        ? transformPoint(snapshot.worldMatrixM, spline?.positionM ?? [0, asset.baseHeightM, 0])
        : flatBasePoint;
    const planeY = basePoint[1];
    const depth = 0;
    let source: WaterQueryResult['source'] = 'plane';
    const normal =
      mode === 'solver-safe' && asset.type !== 'river' && asset.type !== 'custom'
        ? ([0, 1, 0] satisfies Vec3)
        : asset.type === 'lake' || asset.type === 'ocean'
          ? transformNormal(snapshot.worldMatrixM, [0, 1, 0])
          : transformNormal(snapshot.worldMatrixM, spline?.up ?? [0, 1, 0]);
    let velocity: Vec3 = [0, 0, 0];
    if (spline) {
      const tangent = transformPoint(snapshot.worldMatrixM, spline.tangentM);
      const origin = transformPoint(snapshot.worldMatrixM, [0, 0, 0]);
      const splineVelocity = spline.velocityMPerSec;
      const direction = normalize([
        tangent[0] - origin[0],
        tangent[1] - origin[1],
        tangent[2] - origin[2],
      ]);
      velocity = [
        direction[0] * splineVelocity,
        direction[1] * splineVelocity,
        direction[2] * splineVelocity,
      ];
      if (asset.type === 'river' || asset.type === 'custom') source = 'spline';
    }

    return ok({
      splineKey,
      planeY,
      depth,
      source: source as WaterQueryResult['source'],
      normal,
      velocity,
      spline,
    });
  };
  const resolveBaseSurfaceResult = resolveBaseSurface();
  if (!resolveBaseSurfaceResult.ok) return resolveBaseSurfaceResult;
  let { splineKey, planeY, depth, source, normal, velocity, spline } =
    resolveBaseSurfaceResult.value;
  const resolvePlaneDepth = (): void => {
    if (wants.depth) {
      if (asset.type === 'lake' || asset.type === 'ocean') {
        const terrain = terrainSample?.heightM;
        if (terrain !== undefined && Number.isFinite(terrain) && planeY - terrain >= 0) {
          depth = planeY - terrain;
          source = 'terrain';
        } else {
          depth =
            asset.type === 'lake'
              ? (spline?.depthM ?? 0)
              : (input.oceanFallbackDepthM ?? FALLBACK_OCEAN_DEPTH_M);
          source = asset.type === 'lake' ? 'spline' : 'plane';
        }
      } else depth = spline?.depthM ?? 0;
      depth = Math.max(0, depth);
    }
  };
  resolvePlaneDepth();
  let bakedSample: ReturnType<typeof sampleBaked>;
  const applyBakedFields = () => {
    if (bakedEnabled && input.baked !== undefined) {
      bakedSample = sampleBaked(input.baked.grid, input.positionM[0], input.positionM[2]);
      if (!bakedSample)
        return err(
          queryError(
            'query-data-unavailable',
            'baked query grid has finite spacing and a width*height RGBA sample payload',
            'repair the baked water query grid before using it',
          ),
        );
      if (wants.depth) {
        depth = bakedSample.depth;
        source = 'baked';
      }
      if (wants.velocity) {
        velocity = [bakedSample.vx, 0, bakedSample.vz];
        source = 'baked';
      }
      if (asset.type !== 'lake' && asset.type !== 'ocean' && wants.location) {
        planeY = input.baked.grid.originY + bakedSample.height;
        source = 'baked';
      }
      if (asset.type !== 'lake' && asset.type !== 'ocean' && wants.normal) {
        const right =
          sampleBaked(
            input.baked.grid,
            input.positionM[0] + input.baked.grid.spacingXZ[0],
            input.positionM[2],
          )?.height ?? bakedSample.height;
        const up =
          sampleBaked(
            input.baked.grid,
            input.positionM[0],
            input.positionM[2] + input.baked.grid.spacingXZ[1],
          )?.height ?? bakedSample.height;
        normal = normalize([
          -(right - bakedSample.height) / input.baked.grid.spacingXZ[0],
          1,
          -(up - bakedSample.height) / input.baked.grid.spacingXZ[1],
        ]);
        source = 'baked';
      }
    }
    return undefined;
  };
  const applyBakedFieldsFailure = applyBakedFields();
  if (applyBakedFieldsFailure !== undefined) return applyBakedFieldsFailure;
  const planeLocation: Vec3 = [
    input.positionM[0],
    excluded ? input.positionM[1] : planeY,
    input.positionM[2],
  ];
  let waveNormal: Vec3 = normal;
  const planeNormal = normal;
  let waveInfo = wants.waves
    ? {
        timeSeconds: excluded || !supportsWaves ? 0 : input.timeSeconds,
        heightM: 0,
        maxHeightM: 0,
        attenuation: 1,
        normalYUp: excluded || !supportsWaves ? ([0, 1, 0] satisfies Vec3) : waveNormal,
      }
    : undefined;
  let surfaceY = planeLocation[1];
  const applyWaveFields = (): void => {
    if (!excluded && wants.waves && supportsWaves && cookedWaves?.ok) {
      const belowOceanTerrain =
        asset.type === 'ocean' && terrainSample !== undefined && planeY < terrainSample.heightM;
      const attenuation = belowOceanTerrain
        ? 0
        : waterWaveDepthAttenuation(depth, cookedWaves.value.depthMaskM);
      const waveInput = {
        waves: cookedWaves.value.waves,
        positionXZ: [input.positionM[0], input.positionM[2]] as const,
        timeSeconds: input.timeSeconds,
        depthM: depth,
        depthMaskM: cookedWaves.value.depthMaskM,
      };
      let full: ReturnType<typeof evaluateGerstnerWavesCpuFull> | undefined;
      let waveHeight: number;
      const scope = beginWaterOperation(observe, 'water/query/wave-evaluation');
      try {
        full = has(F.SimpleWaves) ? undefined : evaluateGerstnerWavesCpuFull(waveInput);
        waveHeight = belowOceanTerrain
          ? 0
          : has(F.SimpleWaves)
            ? evaluateGerstnerWavesCpuSimple(waveInput)
            : requireWaterValue(full).displacementM[1];
      } finally {
        endWaterOperation(scope);
      }
      surfaceY += waveHeight;
      if (full)
        waveNormal = [
          normal[0] + (full.normalYUp[0] - normal[0]) * attenuation,
          normal[1] + (full.normalYUp[1] - normal[1]) * attenuation,
          normal[2] + (full.normalYUp[2] - normal[2]) * attenuation,
        ];
      if (wants.normal && !has(F.SimpleWaves)) normal = waveNormal;
      if (wants.depth) depth += waveHeight;
      if (waveInfo)
        waveInfo = {
          timeSeconds: input.timeSeconds,
          heightM: waveHeight,
          maxHeightM: cookedWaves.value.maxWaveHeightM * attenuation,
          attenuation,
          normalYUp: waveNormal,
        };
    }
  };
  applyWaveFields();
  const surface: Vec3 = [input.positionM[0], surfaceY, input.positionM[2]];
  const immersion = excluded ? 0 : surfaceY - input.positionM[1];
  const publishRequestedFields = (): void => {
    if (wants.location) valid.add('location');
    if (wants.normal) valid.add('normal');
    if (wants.depth) valid.add('depth');
    if (wants.immersion) valid.add('immersion');
    if (wants.velocity) valid.add('velocity');
    if (wants.waves) valid.add('waves');
    if (excluded) {
      source = 'exclusion';
      velocity = [0, 0, 0];
      if (wants.normal && wants.waves && supportsWaves) normal = [0, 1, 0];
    }
  };
  publishRequestedFields();
  const immutableValid = immutableQueryFields(valid);
  const publishQueryResult = (): WaterQueryResult => {
    const result: WaterQueryResult = Object.freeze({
      bodyGuid: snapshot.guid,
      bodyGeneration: snapshot.sceneGeneration,
      adjustedFlags: flags,
      valid: immutableValid,
      ...(wants.location ? { locationM: planeLocation, surfaceM: surface } : {}),
      ...(wants.normal ? { normalYUp: normal, planeNormalYUp: planeNormal } : {}),
      ...(wants.depth ? { depthM: depth } : {}),
      ...(wants.immersion ? { immersionM: immersion } : {}),
      ...(wants.velocity ? { velocityMPerSec: velocity } : {}),
      ...(splineKey === undefined ? {} : { splineKey }),
      excluded,
      source,
      ...(terrainSample ? { terrainSample } : {}),
      ...(waveInfo ? { waveInfo: Object.freeze(waveInfo) } : {}),
    });
    return result;
  };
  return ok(publishQueryResult());
}
