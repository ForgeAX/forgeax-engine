import {
  AssetError,
  err,
  ok,
  type Result,
  type WaterSplineMetadataDefaults,
} from '@forgeax/engine-types';
import type { WaterBodyAsset } from './contracts.js';
import { requireWaterValue } from './required-value.js';

export type WaterSplinePoint = WaterBodyAsset['spline']['points'][number];
export type WaterSplineInterpolationMode = NonNullable<WaterSplinePoint['interpolationMode']>;
type WaterQuat = NonNullable<WaterSplinePoint['rotationQuat']>;
export type WaterSplineMetadataField = keyof WaterSplineMetadataDefaults;
export type WaterSplinePointInput = Omit<
  Partial<WaterSplinePoint>,
  'positionM' | 'arriveTangentM' | 'leaveTangentM' | 'up'
> &
  Pick<WaterSplinePoint, 'positionM' | 'arriveTangentM' | 'leaveTangentM' | 'up'>;

// Legacy schema 2.0 spline payloads did not record curve defaults.
export const WATER_SPLINE_METADATA_DEFAULTS: WaterSplineMetadataDefaults = Object.freeze({
  widthM: 20.48,
  depthM: 1.5,
  velocityMPerSec: 1.28,
  audioIntensity: 1,
});

const metadataFields: readonly WaterSplineMetadataField[] = [
  'widthM',
  'depthM',
  'velocityMPerSec',
  'audioIntensity',
];
const nearlyEqualTolerance = (field: WaterSplineMetadataField) =>
  field === 'audioIntensity' ? 1e-4 : 1e-6;
const nearlyEqual = (a: number, b: number, field: WaterSplineMetadataField) =>
  Math.abs(a - b) <= nearlyEqualTolerance(field);
const invalid = (expected: string, detail: unknown): Result<never, AssetError> =>
  err(
    new AssetError({
      code: 'asset-parse-failed',
      expected,
      hint: 'repair the spline edit request and try again',
      detail: { field: 'spline', got: detail },
    }),
  );
const stable = (a: number, b: number, t: number) => a * (1 - t) + b * t;

function splineMode(
  point: WaterSplinePoint,
  interpolationVersion?: WaterBodyAsset['spline']['interpolationVersion'],
): WaterSplineInterpolationMode {
  return (
    point.interpolationMode ??
    (interpolationVersion === 'ue-water-spline/1' ? 'curve' : 'curve-custom-tangent')
  );
}

function isCurveMode(mode: WaterSplineInterpolationMode): boolean {
  return mode === 'curve' || mode === 'curve-clamped' || mode === 'curve-custom-tangent';
}

function quaternionLog(value: WaterQuat): WaterQuat {
  const magnitude = Math.hypot(...value);
  if (magnitude < 1e-12) return [0, 0, 0, 0];
  const x = value[0] / magnitude,
    y = value[1] / magnitude,
    z = value[2] / magnitude,
    w = Math.max(-1, Math.min(1, value[3] / magnitude));
  const angle = Math.acos(w),
    vectorLength = Math.hypot(x, y, z);
  if (vectorLength < 1e-12) return [0, 0, 0, 0];
  const scale = angle / vectorLength;
  return [x * scale, y * scale, z * scale, 0];
}

function quaternionExp(value: WaterQuat): WaterQuat {
  const angle = Math.hypot(value[0], value[1], value[2]);
  if (angle < 1e-12) return [0, 0, 0, 1];
  const scale = Math.sin(angle) / angle;
  return [value[0] * scale, value[1] * scale, value[2] * scale, Math.cos(angle)];
}

function quaternionMultiply(a: WaterQuat, b: WaterQuat): WaterQuat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quaternionNormalize(value: WaterQuat): WaterQuat {
  const magnitude = Math.hypot(...value);
  return magnitude > 1e-12
    ? (value.map((component) => component / magnitude) as unknown as WaterQuat)
    : [0, 0, 0, 1];
}

function quaternionSlerpShortest(a: WaterQuat, b: WaterQuat, t: number): WaterQuat {
  const rawCosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = rawCosine >= 0 ? 1 : -1;
  const cosine = rawCosine * sign;
  let scaleA = 1 - t,
    scaleB = t * sign;
  if (cosine < 0.9999) {
    const angle = Math.acos(cosine),
      inverseSin = 1 / Math.sin(angle);
    scaleA = Math.sin((1 - t) * angle) * inverseSin;
    scaleB = Math.sin(t * angle) * inverseSin * sign;
  }
  return ([0, 1, 2, 3] as const).map(
    (index) => a[index] * scaleA + b[index] * scaleB,
  ) as unknown as WaterQuat;
}

function quaternionSlerpFullPath(a: WaterQuat, b: WaterQuat, t: number): WaterQuat {
  const cosine = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  const angle = Math.acos(cosine);
  if (Math.abs(angle) < 1e-4) return a;
  const inverseSin = 1 / Math.sin(angle);
  const scaleA = Math.sin((1 - t) * angle) * inverseSin;
  const scaleB = Math.sin(t * angle) * inverseSin;
  return ([0, 1, 2, 3] as const).map(
    (index) => a[index] * scaleA + b[index] * scaleB,
  ) as unknown as WaterQuat;
}

function autoQuaternionTangent(
  previous: WaterQuat,
  current: WaterQuat,
  next: WaterQuat,
): WaterQuat {
  const normSquared = current.reduce((sum, value) => sum + value * value, 0);
  const inverse: WaterQuat = [
    -current[0] / normSquared,
    -current[1] / normSquared,
    -current[2] / normSquared,
    current[3] / normSquared,
  ];
  const first = quaternionLog(quaternionMultiply(inverse, previous));
  const second = quaternionLog(quaternionMultiply(inverse, next));
  const control = quaternionExp([
    -0.5 * (first[0] + second[0]),
    -0.5 * (first[1] + second[1]),
    -0.5 * (first[2] + second[2]),
    0,
  ]);
  return quaternionMultiply(current, control);
}

export function interpolateWaterSplineRotation(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
  t: number,
): WaterQuat | undefined {
  if (!a.rotationQuat || !b.rotationQuat) return undefined;
  const first = quaternionSlerpShortest(a.rotationQuat, b.rotationQuat, t);
  if (a.interpolationMode === 'linear' || !a.leaveRotationQuat || !b.arriveRotationQuat) {
    return quaternionNormalize(first);
  }
  const second = quaternionSlerpFullPath(a.leaveRotationQuat, b.arriveRotationQuat, t);
  return quaternionNormalize(quaternionSlerpFullPath(first, second, 2 * t * (1 - t)));
}

function clampedAutoTangent(
  previous: number,
  previousTime: number,
  current: number,
  currentTime: number,
  next: number,
  nextTime: number,
): number {
  const span = Math.max(1e-4, nextTime - previousTime);
  const previousSpan = Math.max(1e-4, currentTime - previousTime);
  const nextSpan = Math.max(1e-4, nextTime - currentTime);
  const before = current - previous;
  const after = next - current;
  if ((before >= 0 && after <= 0) || (before <= 0 && after >= 0)) return 0;
  const overall = next - previous;
  const previousSlope = before / previousSpan;
  const nextSlope = after / nextSpan;
  const overallSlope = overall / span;
  const alpha = before / overall;
  const lower = 0.333;
  const upper = 1 - lower;
  let clamped = overallSlope;
  if (overall > 0) {
    if (alpha < lower)
      clamped = Math.min(
        clamped,
        overallSlope + (previousSlope - overallSlope) * (1 - alpha / lower),
      );
    if (alpha > upper)
      clamped = Math.min(
        clamped,
        overallSlope + (nextSlope - overallSlope) * ((alpha - upper) / lower),
      );
  } else {
    if (alpha < lower)
      clamped = Math.max(
        clamped,
        overallSlope + (previousSlope - overallSlope) * (1 - alpha / lower),
      );
    if (alpha > upper)
      clamped = Math.max(
        clamped,
        overallSlope + (nextSlope - overallSlope) * ((alpha - upper) / lower),
      );
  }
  return clamped;
}

/** Version 1 defaults to UE Water's Curve mode; unversioned legacy Packs retain their authored Hermite tangents. */
export function resolveWaterSplinePoints(
  spline: WaterBodyAsset['spline'],
): readonly WaterSplinePoint[] {
  const points = spline.points;
  if (points.length < 2) return points;
  const closed = spline.closed;
  const step =
    points.length > 1
      ? requireWaterValue(points[1]).inputKey - requireWaterValue(points[0]).inputKey
      : 1;
  const linearResolved = points.map((point, index) => {
    if (splineMode(point, spline.interpolationVersion) !== 'linear') return point;
    const previous = requireWaterValue(
      points[index > 0 ? index - 1 : closed ? points.length - 1 : index],
    );
    const next = requireWaterValue(
      points[index + 1 < points.length ? index + 1 : closed ? 0 : index],
    );
    const leave = next.positionM.map(
      (value, axis) => value - requireWaterValue(point.positionM[axis]),
    ) as [number, number, number];
    const arrive = isCurveMode(splineMode(previous, spline.interpolationVersion))
      ? leave
      : (point.positionM.map(
          (value, axis) => value - requireWaterValue(previous.positionM[axis]),
        ) as [number, number, number]);
    return { ...point, arriveTangentM: arrive, leaveTangentM: leave };
  });
  const positionResolved = points.map((point, index) => {
    const mode = splineMode(point, spline.interpolationVersion);
    if (mode !== 'curve' && mode !== 'curve-clamped')
      return requireWaterValue(linearResolved[index]);
    const previousIndex = index > 0 ? index - 1 : closed ? points.length - 1 : index;
    const nextIndex = index + 1 < points.length ? index + 1 : closed ? 0 : index;
    const previous = requireWaterValue(points[previousIndex]),
      next = requireWaterValue(points[nextIndex]);
    const previousTime =
      index > 0 ? previous.inputKey : closed ? point.inputKey - step : point.inputKey;
    const nextTime =
      index + 1 < points.length ? next.inputKey : closed ? point.inputKey + step : point.inputKey;
    let arriveTangentM: [number, number, number];
    if (!isCurveMode(splineMode(previous, spline.interpolationVersion))) {
      arriveTangentM = Array.from(
        requireWaterValue(linearResolved[previousIndex]).arriveTangentM,
      ) as [number, number, number];
    } else {
      arriveTangentM = ([0, 1, 2] as const).map((axis) =>
        mode === 'curve-clamped'
          ? clampedAutoTangent(
              previous.positionM[axis],
              previousTime,
              point.positionM[axis],
              point.inputKey,
              next.positionM[axis],
              nextTime,
            )
          : (next.positionM[axis] - previous.positionM[axis]) /
            Math.max(1e-4, nextTime - previousTime),
      ) as [number, number, number];
    }
    return {
      ...point,
      arriveTangentM,
      leaveTangentM: Array.from(arriveTangentM) as [number, number, number],
    };
  });
  if (
    spline.interpolationVersion !== 'ue-water-spline/1' ||
    points.some((point) => !point.rotationQuat)
  )
    return positionResolved;
  return positionResolved.map((point, index) => {
    const mode = splineMode(point, spline.interpolationVersion);
    if (mode === 'linear')
      return point.rotationQuat === undefined
        ? point
        : {
            ...point,
            arriveRotationQuat: point.rotationQuat,
            leaveRotationQuat: point.rotationQuat,
          };
    if (mode === 'curve-custom-tangent') return point;
    const previous = requireWaterValue(
      points[index > 0 ? index - 1 : closed ? points.length - 1 : index],
    );
    const next = requireWaterValue(
      points[index + 1 < points.length ? index + 1 : closed ? 0 : index],
    );
    const previousMode = splineMode(previous, spline.interpolationVersion);
    const tangent = !isCurveMode(previousMode)
      ? (requireWaterValue(
          linearResolved[index > 0 ? index - 1 : closed ? points.length - 1 : index],
        ).leaveRotationQuat ?? requireWaterValue(previous.rotationQuat))
      : autoQuaternionTangent(
          requireWaterValue(previous.rotationQuat),
          requireWaterValue(point.rotationQuat),
          requireWaterValue(next.rotationQuat),
        );
    return { ...point, arriveRotationQuat: tangent, leaveRotationQuat: tangent };
  });
}

function interpolateSplinePosition(
  previous: WaterSplinePoint,
  current: WaterSplinePoint,
  t: number,
  keyDelta: number,
  linear = previous.interpolationMode === 'linear',
): { positionM: readonly [number, number, number]; tangentM: readonly [number, number, number] } {
  if (linear) {
    const tangentM = ([0, 1, 2] as const).map(
      (axis) => (current.positionM[axis] - previous.positionM[axis]) / keyDelta,
    ) as [number, number, number];
    const positionM = ([0, 1, 2] as const).map(
      (axis) => previous.positionM[axis] + (current.positionM[axis] - previous.positionM[axis]) * t,
    ) as [number, number, number];
    return { positionM, tangentM };
  }
  const positionM = ([0, 1, 2] as const).map((axis) => {
    const p0 = previous.positionM[axis],
      p1 = current.positionM[axis],
      m0 = previous.leaveTangentM[axis] * keyDelta,
      m1 = current.arriveTangentM[axis] * keyDelta;
    return (
      (2 * t ** 3 - 3 * t ** 2 + 1) * p0 +
      (t ** 3 - 2 * t ** 2 + t) * m0 +
      (-2 * t ** 3 + 3 * t ** 2) * p1 +
      (t ** 3 - t ** 2) * m1
    );
  }) as [number, number, number];
  const tangentM = ([0, 1, 2] as const).map((axis) => {
    const p0 = previous.positionM[axis],
      p1 = current.positionM[axis];
    return (
      (6 * t ** 2 - 6 * t) * p0 +
      (3 * t ** 2 - 4 * t + 1) * previous.leaveTangentM[axis] * keyDelta +
      (-6 * t ** 2 + 6 * t) * p1 +
      (3 * t ** 2 - 2 * t) * current.arriveTangentM[axis] * keyDelta
    );
  }) as [number, number, number];
  return { positionM, tangentM };
}

export function resolveWaterSplineMetadataDefaults(
  defaults?: Partial<WaterSplineMetadataDefaults>,
): WaterSplineMetadataDefaults {
  return Object.freeze({ ...WATER_SPLINE_METADATA_DEFAULTS, ...defaults });
}

export function fixupWaterSpline(
  points: readonly WaterSplinePointInput[],
  defaults?: Partial<WaterSplineMetadataDefaults>,
): readonly WaterSplinePoint[] {
  const resolved = resolveWaterSplineMetadataDefaults(defaults);
  return Object.freeze(
    points.map((point, inputKey) => {
      const metadata = Object.fromEntries(
        metadataFields.map((field) => [field, point[field] ?? resolved[field]]),
      );
      metadata.widthM = Math.max(metadata.widthM as number, 1e-6);
      metadata.depthM = Math.max(metadata.depthM as number, 1e-6);
      return Object.freeze({ ...point, ...metadata, inputKey }) as WaterSplinePoint;
    }),
  );
}

function validateSplineInsertion(
  points: readonly WaterSplinePoint[],
  index: number,
  t: number,
): Result<void, AssetError> {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > points.length ||
    !Number.isFinite(t) ||
    t < 0 ||
    t > 1 ||
    points.length < 2
  )
    return invalid('valid insertion index, t in [0,1], and at least two points', {
      index,
      t,
      count: points.length,
    });
  if (points.some((point, pointIndex) => point.inputKey !== pointIndex))
    return invalid(
      'spline points with strictly increasing sequential input keys before insertion',
      points.map((point) => point.inputKey),
    );
  return ok(undefined);
}

export function insertWaterSplinePoint(
  points: readonly WaterSplinePoint[],
  index: number,
  t: number,
  closed = false,
  defaults?: Partial<WaterSplineMetadataDefaults>,
): Result<readonly WaterSplinePoint[], AssetError> {
  const admission = validateSplineInsertion(points, index, t);
  if (!admission.ok) return admission;
  const resolved = resolveWaterSplineMetadataDefaults(defaults);
  if (index === points.length) {
    const last = requireWaterValue(points.at(-1));
    return ok(fixupWaterSpline([...points, { ...last, inputKey: index }], resolved));
  }
  const prevIndex = index === 0 && closed ? points.length - 1 : index - 1;
  const current = requireWaterValue(points[index]),
    previous = prevIndex >= 0 ? points[prevIndex] : undefined;
  const keyDelta = previous
    ? index === 0 && closed
      ? current.inputKey + points.length - previous.inputKey
      : current.inputKey - previous.inputKey
    : 0;
  const interpolated = previous
    ? interpolateSplinePosition(previous, current, t, keyDelta)
    : undefined;
  const metadata = Object.fromEntries(
    metadataFields.map((field) => [
      field,
      previous ? stable(previous[field], current[field], t) : resolved[field],
    ]),
  );
  const point = Object.freeze({
    ...current,
    inputKey: index,
    positionM: interpolated?.positionM ?? current.positionM,
    arriveTangentM: interpolated
      ? (interpolated.tangentM.map((value) => value * t) as [number, number, number])
      : current.arriveTangentM,
    leaveTangentM: interpolated
      ? (interpolated.tangentM.map((value) => value * (1 - t)) as [number, number, number])
      : current.leaveTangentM,
    ...metadata,
  });
  if (!previous)
    return ok(
      fixupWaterSpline([...points.slice(0, index), point, ...points.slice(index)], resolved),
    );
  const rescaledPrevious = Object.freeze({
    ...previous,
    leaveTangentM: previous.leaveTangentM.map((value) => value * keyDelta * t) as [
      number,
      number,
      number,
    ],
  });
  const rescaledCurrent = Object.freeze({
    ...current,
    arriveTangentM: current.arriveTangentM.map((value) => value * keyDelta * (1 - t)) as [
      number,
      number,
      number,
    ],
  });
  if (index === 0 && closed)
    return ok(
      fixupWaterSpline(
        [point, rescaledCurrent, ...points.slice(1, prevIndex), rescaledPrevious],
        resolved,
      ),
    );
  return ok(
    fixupWaterSpline(
      [
        ...points.slice(0, prevIndex),
        rescaledPrevious,
        point,
        rescaledCurrent,
        ...points.slice(index + 1),
      ],
      resolved,
    ),
  );
}

/** Inserts into a versioned UE spline by sampling its effective curve, then lets auto modes recompute after insertion. */
export function insertWaterSplinePointInSpline(
  spline: WaterBodyAsset['spline'],
  index: number,
  t: number,
  defaults?: Partial<WaterSplineMetadataDefaults>,
): Result<readonly WaterSplinePoint[], AssetError> {
  if (spline.interpolationVersion !== 'ue-water-spline/1')
    return insertWaterSplinePoint(spline.points, index, t, spline.closed, defaults);
  const admission = validateSplineInsertion(spline.points, index, t);
  if (!admission.ok) return admission;
  const resolvedDefaults = resolveWaterSplineMetadataDefaults(defaults);
  const previousIndex = index === 0 && spline.closed ? spline.points.length - 1 : index - 1;
  const mode =
    previousIndex >= 0
      ? (requireWaterValue(spline.points[previousIndex]).interpolationMode ?? 'curve')
      : (requireWaterValue(spline.points[index]).interpolationMode ?? 'curve');
  if (index === spline.points.length)
    return insertWaterSplinePoint(spline.points, index, t, spline.closed, resolvedDefaults);
  const resolvedPoints = resolveWaterSplinePoints(spline);
  const current = requireWaterValue(resolvedPoints[index]),
    previous = previousIndex >= 0 ? resolvedPoints[previousIndex] : undefined;
  const keyDelta = previous
    ? index === 0 && spline.closed
      ? current.inputKey + spline.points.length - previous.inputKey
      : current.inputKey - previous.inputKey
    : 0;
  const interpolated = previous
    ? interpolateSplinePosition(previous, current, t, keyDelta, mode === 'linear')
    : undefined;
  const metadata = Object.fromEntries(
    metadataFields.map((field) => [
      field,
      previous ? stable(previous[field], current[field], t) : resolvedDefaults[field],
    ]),
  );
  const rotationQuat = previous
    ? interpolateWaterSplineRotation(previous, current, t)
    : current.rotationQuat;
  const up = rotationQuat
    ? ([
        2 * (rotationQuat[0] * rotationQuat[1] - rotationQuat[3] * rotationQuat[2]),
        1 - 2 * (rotationQuat[0] ** 2 + rotationQuat[2] ** 2),
        2 * (rotationQuat[1] * rotationQuat[2] + rotationQuat[3] * rotationQuat[0]),
      ] as const)
    : current.up;
  let insertedBase: readonly WaterSplinePoint[];
  if (previous && mode === 'curve-custom-tangent') {
    const split = insertWaterSplinePoint(resolvedPoints, index, t, spline.closed, resolvedDefaults);
    if (!split.ok) return split;
    insertedBase = split.value;
  } else {
    insertedBase = [...spline.points.slice(0, index), current, ...spline.points.slice(index)];
  }
  const withSampledOrientation = insertedBase.map((point, pointIndex) =>
    pointIndex === index
      ? {
          ...point,
          interpolationMode: mode,
          ...(interpolated
            ? {
                positionM: interpolated.positionM,
                ...(mode === 'curve-custom-tangent'
                  ? {}
                  : {
                      arriveTangentM: interpolated.tangentM,
                      leaveTangentM: interpolated.tangentM,
                    }),
              }
            : {}),
          ...(rotationQuat
            ? { rotationQuat, arriveRotationQuat: rotationQuat, leaveRotationQuat: rotationQuat }
            : {}),
          up,
          ...metadata,
        }
      : point,
  );
  return ok(fixupWaterSpline(withSampledOrientation, resolvedDefaults));
}

export function deleteWaterSplinePoint(
  points: readonly WaterSplinePoint[],
  index: number,
  closed = false,
): Result<readonly WaterSplinePoint[], AssetError> {
  const minimum = closed ? 3 : 2;
  if (!Number.isInteger(index) || index < 0 || index >= points.length || points.length <= minimum)
    return invalid(`valid point index and at least ${minimum} remaining points`, {
      index,
      count: points.length,
    });
  return ok(fixupWaterSpline([...points.slice(0, index), ...points.slice(index + 1)]));
}

export function duplicateWaterSplinePoint(
  points: readonly WaterSplinePoint[],
  index: number,
): Result<readonly WaterSplinePoint[], AssetError> {
  if (!Number.isInteger(index) || index < 0 || index >= points.length)
    return invalid('valid point index', { index, count: points.length });
  return ok(
    fixupWaterSpline([
      ...points.slice(0, index),
      { ...requireWaterValue(points[index]) },
      ...points.slice(index),
    ]),
  );
}

/** Duplicate a point while retaining the spline's versioned UE interpolation contract. */
export function duplicateWaterSplinePointInSpline(
  spline: WaterBodyAsset['spline'],
  index: number,
): Result<readonly WaterSplinePoint[], AssetError> {
  if (
    spline.interpolationVersion === 'ue-water-spline/1' &&
    spline.points.some((point) => !point.rotationQuat)
  ) {
    return invalid(
      'ue-water-spline/1 points with canonical rotation quaternions before duplication',
      spline.points.map((point) => point.inputKey),
    );
  }
  return duplicateWaterSplinePoint(spline.points, index);
}

/** Mirrors UE PropagateDefaultValue: only points still carrying the old curve default move. */
export function propagateWaterSplineDefaultValue(
  points: readonly WaterSplinePoint[],
  field: WaterSplineMetadataField,
  oldDefault: number,
  newDefault: number,
): readonly WaterSplinePoint[] {
  if (
    !Number.isFinite(oldDefault) ||
    !Number.isFinite(newDefault) ||
    nearlyEqual(oldDefault, newDefault, field)
  )
    return points;
  return Object.freeze(
    points.map((point) =>
      Object.freeze({
        ...point,
        [field]: nearlyEqual(point[field], oldDefault, field) ? newDefault : point[field],
      }),
    ),
  );
}

export function migrateLegacyWaterSplineMetadataDefaults(
  spline: WaterBodyAsset['spline'],
  legacySchema: '2.0.0',
): WaterBodyAsset['spline'] {
  void legacySchema;
  const defaults = resolveWaterSplineMetadataDefaults(spline.metadataDefaults);
  const points = spline.points.map((point) =>
    Object.freeze({
      ...point,
      widthM: nearlyEqual(point.widthM, 0.008, 'widthM')
        ? defaults.widthM
        : Math.max(point.widthM, 1e-6),
      depthM: nearlyEqual(point.depthM, 0, 'depthM')
        ? defaults.depthM
        : Math.max(point.depthM, 1e-6),
    }),
  );
  return Object.freeze({ ...spline, points: Object.freeze(points), metadataDefaults: defaults });
}
