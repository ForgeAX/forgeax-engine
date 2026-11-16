import { bench, describe } from 'vitest';
import type { Vec3, WaterBodyAsset } from '../src/contracts.js';
import { nearestPreparedWaterSplineKey, prepareWaterQuerySpline } from '../src/query-spline.js';
import { requireWaterValue } from '../src/required-value.js';

const PROBE_COUNT = 88;
const SEGMENT_COUNT = 32;
const SAMPLE_COUNT = 30;
const point = (inputKey: number, positionM: Vec3) => ({
  inputKey,
  positionM,
  interpolationMode: 'linear' as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 3,
  velocityMPerSec: 0,
  audioIntensity: 0,
});

const spline: WaterBodyAsset['spline'] = {
  closed: true,
  points: Array.from({ length: SEGMENT_COUNT }, (_, index) => {
    const angle = (index / SEGMENT_COUNT) * Math.PI * 2;
    return point(index * 0.75 + 0.125, [
      Math.cos(angle) * 100,
      Math.sin(angle * 3) * 2,
      Math.sin(angle) * 100,
    ]);
  }),
};
const preparation = prepareWaterQuerySpline(spline);
const probes: readonly Vec3[] = Array.from({ length: PROBE_COUNT }, (_, index) => {
  const angle = (index / PROBE_COUNT) * Math.PI * 2;
  const radius = 94 + (index % 7) * 2;
  return [Math.cos(angle) * radius, ((index % 9) - 4) * 0.35, Math.sin(angle) * radius];
});

function originalLinearNearestKey(positionM: Vec3): number {
  let bestKey = preparation.points[0]?.inputKey ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of preparation.segments) {
    const [origin, first, second, third] = segment.vectors;
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
  }
  return bestKey;
}

function completeNearestOwner(operation: (positionM: Vec3) => number): number {
  let checksum = 0;
  for (const probe of probes) checksum += operation(probe);
  return checksum;
}

let sink = 0;
describe('Water linear nearest-query owner (88 probes × 32 closed segments)', () => {
  bench(
    'original generic linear kernel',
    () => {
      sink = completeNearestOwner(originalLinearNearestKey);
    },
    { iterations: SAMPLE_COUNT },
  );
  bench(
    'prepared scalar linear kernel',
    () => {
      sink = completeNearestOwner((positionM) =>
        nearestPreparedWaterSplineKey(preparation, positionM),
      );
    },
    { iterations: SAMPLE_COUNT },
  );
});

void sink;
