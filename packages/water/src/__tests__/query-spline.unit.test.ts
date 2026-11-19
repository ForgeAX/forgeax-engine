import { describe, expect, it } from 'vitest';
import type { Vec3, WaterBodyAsset } from '../contracts.js';
import {
  nearestPreparedWaterSplineKey,
  prepareWaterQuerySpline,
  type WaterQuerySplinePreparation,
} from '../query-spline.js';
import { requireWaterValue } from '../required-value.js';

const point = (
  inputKey: number,
  positionM: Vec3,
  interpolationMode: 'linear' | 'curve-custom-tangent',
) => ({
  inputKey,
  positionM,
  interpolationMode,
  arriveTangentM: [8, 0, -16] as const,
  leaveTangentM: [8, 0, 16] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 3,
  velocityMPerSec: 0,
  audioIntensity: 0,
});

function originalLinearNearestKey(
  preparation: WaterQuerySplinePreparation,
  positionM: Vec3,
): number {
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

describe('admitted spline nearest-key preparation', () => {
  it.each([
    [0, 0, 0],
    [1e9, -2e9, 3e9],
    [-1e12, 1e12, -1e12],
  ] as const)('keeps the analytic curved midpoint at translated local origin %j', (x, y, z) => {
    const spline: WaterBodyAsset['spline'] = {
      closed: false,
      points: [
        point(0, [x, y, z], 'curve-custom-tangent'),
        point(1, [x + 8, y, z], 'curve-custom-tangent'),
      ],
    };
    // x(t)=8t and z(t)=16t(1-t); [4,3] has its unique minimum at t=1/2.
    expect(nearestPreparedWaterSplineKey(prepareWaterQuerySpline(spline), [x + 4, y, z + 3])).toBe(
      0.5,
    );
  });

  it.each([
    [0, 0, 0],
    [1e9, -2e9, 3e9],
    [-1e12, 1e12, -1e12],
  ] as const)('keeps closed last-edge keys and first equal minimum at translated local origin %j', (x, y, z) => {
    const spline: WaterBodyAsset['spline'] = {
      closed: true,
      points: [
        point(0, [x, y, z], 'linear'),
        point(1, [x + 8, y, z], 'linear'),
        point(2, [x + 8, y, z + 8], 'linear'),
        point(3, [x, y, z + 8], 'linear'),
      ],
    };
    const prepared = prepareWaterQuerySpline(spline);
    expect(nearestPreparedWaterSplineKey(prepared, [x - 1, y, z + 4])).toBe(3.5);
    expect(nearestPreparedWaterSplineKey(prepared, [x + 4, y, z + 4])).toBe(0.5);
  });

  it('keeps the zero-length fallback and first equal-distance linear key', () => {
    const spline: WaterBodyAsset['spline'] = {
      closed: false,
      points: [
        point(0, [0, 0, 0], 'linear'),
        point(1, [0, 0, 0], 'linear'),
        point(2, [10, 0, 0], 'linear'),
      ],
    };
    const prepared = prepareWaterQuerySpline(spline);
    expect(nearestPreparedWaterSplineKey(prepared, [0, 0, 1])).toBe(0);
    expect(nearestPreparedWaterSplineKey(prepared, [10, 0, 0])).toBe(2);
  });

  it('matches the original linear oracle for ties, degeneracy, large coordinates and key seams', () => {
    const fixtures: readonly {
      readonly spline: WaterBodyAsset['spline'];
      readonly queries: readonly Vec3[];
    }[] = [
      {
        spline: {
          closed: false,
          points: [
            point(0.125, [0, 0, 0], 'linear'),
            point(0.75, [0, 0, 0], 'linear'),
            point(2.5, [10, 0, 0], 'linear'),
            point(3.125, [10, 0, 10], 'linear'),
          ],
        },
        queries: [
          [0, 0, 1],
          [10, 0, 0],
          [5, 0, 1],
          [10, 0, 5],
        ],
      },
      {
        spline: {
          closed: true,
          points: [
            point(0.25, [1e9, -2e9, 3e9], 'linear'),
            point(0.75, [1e9 + 8, -2e9, 3e9], 'linear'),
            point(1.25, [1e9 + 8, -2e9, 3e9 + 8], 'linear'),
            point(1.75, [1e9, -2e9, 3e9 + 8], 'linear'),
          ],
        },
        queries: [
          [1e9 - 1, -2e9, 3e9 + 4],
          [1e9 + 4, -2e9, 3e9 + 4],
          [1e9 + 4, -2e9, 3e9],
          [1e9, -2e9, 3e9],
        ],
      },
      {
        spline: {
          closed: false,
          points: [
            point(7.25, [-1e12, 1e12, -1e12], 'linear'),
            point(7.75, [-1e12, 1e12, -1e12], 'linear'),
          ],
        },
        queries: [
          [-1e12, 1e12, -1e12],
          [-1e12 + 4, 1e12, -1e12 + 2],
        ],
      },
    ];
    for (const { spline, queries } of fixtures) {
      const prepared = prepareWaterQuerySpline(spline);
      for (const query of queries)
        expect(nearestPreparedWaterSplineKey(prepared, query)).toBe(
          originalLinearNearestKey(prepared, query),
        );
    }
  });

  it('evaluates all prepared linear vectors without assuming higher terms are zero', () => {
    const prepared = {
      points: [{ inputKey: 0 }],
      segments: [
        {
          inputKey: 0,
          keyDelta: 1,
          linear: true,
          vectors: [
            [0, 0, 0],
            [10, 0, 0],
            [100, 0, 0],
            [0, 0, 0],
          ],
          distanceDerivative: [],
        },
        {
          inputKey: 1,
          keyDelta: 1,
          linear: true,
          vectors: [
            [0, 0, 1],
            [10, 0, 0],
            [0, 0, 0],
            [100, 0, 0],
          ],
          distanceDerivative: [],
        },
        {
          inputKey: 2,
          keyDelta: 1,
          linear: true,
          vectors: [
            [0, 0, 2],
            [10, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
          distanceDerivative: [],
        },
      ],
    } as unknown as WaterQuerySplinePreparation;
    expect(nearestPreparedWaterSplineKey(prepared, [5, 0, 0])).toBe(2.5);
  });
});
