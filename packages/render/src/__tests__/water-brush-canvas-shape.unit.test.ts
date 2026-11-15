import type { WaterBrushIslandActor } from '@forgeax/engine-types';
import { createWaterSplineDistanceSampler } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { buildWaterBrushCanvasShapeTriangles } from '../water-brush/canvas-shape.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const point = (
  inputKey: number,
  positionM: readonly [number, number, number],
  tangent: readonly [number, number, number],
) => ({
  inputKey,
  positionM,
  arriveTangentM: tangent,
  leaveTangentM: tangent,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 1,
  depthM: 1,
  velocityMPerSec: 0,
  audioIntensity: 0,
});

function spline(
  points: ReturnType<typeof point>[],
  closed = false,
): WaterBrushIslandActor['spline'] {
  return { closed, points };
}

it('uses UE fixed A and C/B order with truncated segment count and open endpoint clamping', () => {
  const source = spline([point(0, [0, 0, 0], [10, 0, 0]), point(1, [25, 0, 0], [10, 0, 0])]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
  const triangles = buildWaterBrushCanvasShapeTriangles(source, identity, 10, identity);
  expect(triangles).toHaveLength(2);
  expect(triangles.map(({ splineDistancesM }) => splineDistancesM)).toEqual([
    [0, 20, 10],
    [0, 30, 20],
  ]);
  const sampler = createWaterSplineDistanceSampler(source);
  const canvas = (distance: number) => {
    const [x, , z] = sampler.sampleAtDistanceM(distance).positionM;
    return [x + 0.5, z + 0.5];
  };
  const rounded = (position: readonly number[]) =>
    position.map((value) => Math.round(value * 1e5) / 1e5);
  expect(requiredFixtureValue(triangles[0]).canvasLocalXZ.map(rounded)).toEqual(
    [0, 20, 10].map(canvas).map(rounded),
  );
  expect(requiredFixtureValue(triangles[1]).canvasLocalXZ.map(rounded)).toEqual(
    [0, 30, 20].map(canvas).map(rounded),
  );
});

it('samples curved spline distances from the UE reparameterization table in world scale', () => {
  const source = spline([point(0, [0, 0, 0], [0, 0, 20]), point(1, [10, 0, 0], [0, 0, -20])]);
  const matrix = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1] as const;
  const sampler = createWaterSplineDistanceSampler(source, matrix);
  const segmentSizeM = sampler.lengthM / 3;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
  const triangles = buildWaterBrushCanvasShapeTriangles(source, matrix, segmentSizeM, identity);
  expect(triangles).toHaveLength(3);
  const [x, , z] = sampler.sampleAtDistanceM(segmentSizeM * 3).positionM;
  expect(requiredFixtureValue(triangles[1]).canvasLocalXZ[1]).toEqual([x * 2 + 0.5, z + 0.5]);
  expect(requiredFixtureValue(triangles[2]).canvasLocalXZ[2]).toEqual([x * 2 + 0.5, z + 0.5]);
});

it('selects the correct interval on an unequal-length three-segment distance table', () => {
  const source = spline([
    { ...point(0, [0, 0, 0], [10, 0, 0]), interpolationMode: 'linear' },
    { ...point(1, [10, 0, 0], [10, 0, 0]), interpolationMode: 'linear' },
    { ...point(2, [30, 0, 0], [20, 0, 0]), interpolationMode: 'linear' },
    { ...point(3, [35, 0, 0], [5, 0, 0]), interpolationMode: 'linear' },
  ]);
  const sampler = createWaterSplineDistanceSampler(source);
  expect(sampler.lengthM).toBeCloseTo(35, 5);
  expect(sampler.sampleAtDistanceM(10.0001).positionM[0]).toBeCloseTo(10.0001, 5);
  expect(sampler.sampleAtDistanceM(25).positionM[0]).toBeCloseTo(25, 5);
  expect(sampler.sampleAtDistanceM(29.9999).positionM[0]).toBeCloseTo(29.9999, 5);
});

it('transforms Canvas vertices through rotated and scaled actor and Terrain matrices', () => {
  const source = spline([point(0, [1, 0, 0], [1, 0, 0]), point(1, [2, 0, 0], [1, 0, 0])]);
  const actor = [0, 0, -2, 0, 0, 1, 0, 0, 3, 0, 0, 0, 10, 4, -2, 1] as const;
  const terrain = [0, 0, -1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 9, 0, -2, 1] as const;
  const triangles = buildWaterBrushCanvasShapeTriangles(source, actor, 1.5, terrain);
  expect(triangles).toHaveLength(1);
  expect(requiredFixtureValue(triangles[0]).canvasLocalXZ[0]).toEqual([2.5, 1.5]);
});
