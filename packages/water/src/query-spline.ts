import { resolveWaterSplinePoints, type WaterSplinePoint } from './body-spline.js';
import type { Vec3, WaterBodyAsset } from './contracts.js';
import { requireWaterValue } from './required-value.js';

type SplineQuerySegment = Readonly<{
  inputKey: number;
  keyDelta: number;
  linear: boolean;
  vectors: readonly [Vec3, Vec3, Vec3, Vec3];
  distanceDerivative: readonly number[];
}>;

export type WaterQuerySplinePreparation = Readonly<{
  points: readonly WaterSplinePoint[];
  segments: readonly SplineQuerySegment[];
}>;

export function closingWaterSplinePoint(points: readonly WaterSplinePoint[], step: number) {
  return {
    ...requireWaterValue(points[0]),
    inputKey: requireWaterValue(points.at(-1)).inputKey + step,
  };
}

/** Retained only with an admitted Body; borrowed snapshots use their live spline path. */
export function prepareWaterQuerySpline(
  spline: WaterBodyAsset['spline'],
): WaterQuerySplinePreparation {
  const points = resolveWaterSplinePoints(spline);
  const segments: SplineQuerySegment[] = [];
  const step =
    points.length < 2
      ? 1
      : requireWaterValue(points[1]).inputKey - requireWaterValue(points[0]).inputKey || 1;
  const count = points.length < 2 ? 0 : spline.closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index++) {
    const a = requireWaterValue(points[index]);
    const b =
      index + 1 < points.length
        ? requireWaterValue(points[index + 1])
        : closingWaterSplinePoint(points, step);
    const keyDelta = b.inputKey - a.inputKey;
    const linear = a.interpolationMode === 'linear';
    const vectors = [
      a.positionM,
      [0, 1, 2].map((axis) =>
        linear
          ? requireWaterValue(b.positionM[axis]) - requireWaterValue(a.positionM[axis])
          : requireWaterValue(a.leaveTangentM[axis]) * keyDelta,
      ),
      [0, 1, 2].map((axis) =>
        linear
          ? 0
          : 3 * (requireWaterValue(b.positionM[axis]) - requireWaterValue(a.positionM[axis])) -
            2 * requireWaterValue(a.leaveTangentM[axis]) * keyDelta -
            requireWaterValue(b.arriveTangentM[axis]) * keyDelta,
      ),
      [0, 1, 2].map((axis) =>
        linear
          ? 0
          : -2 * (requireWaterValue(b.positionM[axis]) - requireWaterValue(a.positionM[axis])) +
            requireWaterValue(a.leaveTangentM[axis]) * keyDelta +
            requireWaterValue(b.arriveTangentM[axis]) * keyDelta,
      ),
    ] as unknown as readonly [Vec3, Vec3, Vec3, Vec3];
    const distanceDerivative = Array.from({ length: 6 }, (_, degree) => {
      let value = 0;
      for (let axis = 0; axis < 3; axis++)
        for (let left = 1; left < 4; left++)
          for (let right = 1; right < 4; right++)
            if (left + right - 1 === degree)
              value +=
                requireWaterValue(requireWaterValue(vectors[left])[axis]) *
                right *
                requireWaterValue(requireWaterValue(vectors[right])[axis]);
      return value;
    });
    segments.push({
      inputKey: a.inputKey,
      keyDelta,
      linear,
      vectors,
      distanceDerivative,
    });
  }
  return { points, segments };
}

function polynomialValue(coefficients: readonly number[], x: number): number {
  let value = 0;
  for (let index = coefficients.length - 1; index >= 0; index--)
    value = value * x + requireWaterValue(coefficients[index]);
  return value;
}

export function waterSplinePolynomialRoots(coefficients: readonly number[]): number[] {
  let degree = coefficients.length - 1;
  while (degree > 0 && Math.abs(requireWaterValue(coefficients[degree])) < 1e-14) degree--;
  if (degree === 0) return [];
  if (degree === 1) {
    const root = -requireWaterValue(coefficients[0]) / requireWaterValue(coefficients[1]);
    return root > 0 && root < 1 ? [root] : [];
  }
  const derivative = Array.from(
    { length: degree },
    (_, index) => requireWaterValue(coefficients[index + 1]) * (index + 1),
  );
  const cuts = [0, ...waterSplinePolynomialRoots(derivative), 1];
  const roots: number[] = [];
  const addRoot = (root: number) => {
    if (root > 0 && root < 1 && !roots.some((existing) => Math.abs(existing - root) < 1e-9))
      roots.push(root);
  };
  const scale =
    coefficients.slice(0, degree + 1).reduce((sum, value) => sum + Math.abs(value), 0) || 1;
  for (const cut of cuts.slice(1, -1))
    if (Math.abs(polynomialValue(coefficients, cut)) <= scale * 1e-12) addRoot(cut);
  for (let index = 0; index + 1 < cuts.length; index++) {
    let low = requireWaterValue(cuts[index]),
      high = requireWaterValue(cuts[index + 1]);
    let lowValue = polynomialValue(coefficients, low),
      highValue = polynomialValue(coefficients, high);
    if (lowValue === 0 || highValue === 0 || Math.sign(lowValue) === Math.sign(highValue)) continue;
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (low + high) * 0.5;
      const middleValue = polynomialValue(coefficients, middle);
      if (middleValue === 0) {
        low = middle;
        high = middle;
        break;
      }
      if (Math.sign(middleValue) === Math.sign(lowValue)) {
        low = middle;
        lowValue = middleValue;
      } else {
        high = middle;
        highValue = middleValue;
      }
    }
    addRoot((low + high) * 0.5);
  }
  return roots.sort((a, b) => a - b);
}

export function nearestPreparedWaterSplineKey(
  preparation: WaterQuerySplinePreparation,
  positionM: Vec3,
): number {
  let bestKey = preparation.points[0]?.inputKey ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of preparation.segments) {
    const [origin, first, second, third] = segment.vectors;
    if (segment.linear) {
      // Prepared linear segments own literal zero higher-order terms. Preserve the
      // general evaluation below for borrowed or synthetic preparations that only
      // carry the linear flag but contain other coefficients.
      const hasLiteralLinearTerms = (): boolean =>
        second[0] === 0 &&
        second[1] === 0 &&
        second[2] === 0 &&
        third[0] === 0 &&
        third[1] === 0 &&
        third[2] === 0;
      if (hasLiteralLinearTerms()) {
        const denominator = first[0] ** 2 + first[1] ** 2 + first[2] ** 2;
        const numerator =
          (origin[0] - positionM[0]) * first[0] +
          (origin[1] - positionM[1]) * first[1] +
          (origin[2] - positionM[2]) * first[2];
        const projected = denominator > 0 ? Math.max(0, Math.min(1, -numerator / denominator)) : 0;
        const offsetX = requireWaterValue(origin[0]) - requireWaterValue(positionM[0]);
        const offsetY = requireWaterValue(origin[1]) - requireWaterValue(positionM[1]);
        const offsetZ = requireWaterValue(origin[2]) - requireWaterValue(positionM[2]);
        const directionX = requireWaterValue(first[0]);
        const directionY = requireWaterValue(first[1]);
        const directionZ = requireWaterValue(first[2]);
        for (let candidateIndex = 0; candidateIndex < 3; candidateIndex++) {
          const t = candidateIndex === 0 ? 0 : candidateIndex === 1 ? 1 : projected;
          const x = offsetX + directionX * t;
          const y = offsetY + directionY * t;
          const z = offsetZ + directionZ * t;
          let distance = 0;
          distance += x * x;
          distance += y * y;
          distance += z * z;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestKey = segment.inputKey + segment.keyDelta * t;
          }
        }
        continue;
      }
      const denominator = first[0] ** 2 + first[1] ** 2 + first[2] ** 2;
      const numerator =
        (origin[0] - positionM[0]) * first[0] +
        (origin[1] - positionM[1]) * first[1] +
        (origin[2] - positionM[2]) * first[2];
      const projected = denominator > 0 ? Math.max(0, Math.min(1, -numerator / denominator)) : 0;
      for (let candidateIndex = 0; candidateIndex < 3; candidateIndex++) {
        const t = candidateIndex === 0 ? 0 : candidateIndex === 1 ? 1 : projected;
        let distance = 0;
        for (let axis = 0; axis < 3; axis++) {
          const coordinate =
            requireWaterValue(origin[axis]) -
            requireWaterValue(positionM[axis]) +
            requireWaterValue(first[axis]) * t +
            requireWaterValue(second[axis]) * t ** 2 +
            requireWaterValue(third[axis]) * t ** 3;
          distance += coordinate * coordinate;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          bestKey = segment.inputKey + segment.keyDelta * t;
        }
      }
      continue;
    }

    const candidates = [0, 1];
    const coefficients = Array.from(segment.distanceDerivative);
    for (let degree = 0; degree < 3; degree++) {
      const vector = requireWaterValue(segment.vectors[degree + 1]);
      const relative =
        (origin[0] - positionM[0]) * vector[0] +
        (origin[1] - positionM[1]) * vector[1] +
        (origin[2] - positionM[2]) * vector[2];
      coefficients[degree] = requireWaterValue(coefficients[degree]) + (degree + 1) * relative;
    }
    candidates.push(...waterSplinePolynomialRoots(coefficients));
    for (const t of candidates) {
      let distance = 0;
      for (let axis = 0; axis < 3; axis++) {
        const coordinate =
          requireWaterValue(origin[axis]) -
          requireWaterValue(positionM[axis]) +
          requireWaterValue(first[axis]) * t +
          requireWaterValue(second[axis]) * t ** 2 +
          requireWaterValue(third[axis]) * t ** 3;
        distance += coordinate * coordinate;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = segment.inputKey + segment.keyDelta * t;
      }
    }
  }
  return bestKey;
}
