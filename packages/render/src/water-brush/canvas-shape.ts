import { mat4, vec3 } from '@forgeax/engine-math';
import type { WaterBrushIslandActor, WaterSplineSourcePoint } from '@forgeax/engine-types';
import { createWaterSplineDistanceSampler } from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { waterBrushWorldPointToTerrainLocal } from './height-codec.js';

export type WaterBrushCanvasTriangle = Readonly<{
  /** Canvas vertex color order: A red, C green, B blue. */
  vertices: readonly [WaterSplineSourcePoint, WaterSplineSourcePoint, WaterSplineSourcePoint];
  /** Terrain-local XZ position converted to Canvas UV with a +0.5 offset. */
  canvasLocalXZ: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  splineDistancesM: readonly [number, number, number];
}>;

function worldPosition(
  point: WaterSplineSourcePoint,
  matrix: readonly number[],
): readonly [number, number, number] {
  const world = mat4.transformPoint(vec3.create(), matrix, point.positionM);
  return [requireWaterValue(world[0]), requireWaterValue(world[1]), requireWaterValue(world[2])];
}

/** Build spline fan triangles and their Terrain-local Canvas positions. */
export function buildWaterBrushCanvasShapeTriangles(
  spline: WaterBrushIslandActor['spline'],
  worldMatrixM: readonly number[],
  canvasSegmentSizeM: number,
  terrainWorldMatrixM: readonly number[],
): readonly WaterBrushCanvasTriangle[] {
  if (
    worldMatrixM.length !== 16 ||
    worldMatrixM.some((value) => !Number.isFinite(value)) ||
    terrainWorldMatrixM.length !== 16 ||
    terrainWorldMatrixM.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(canvasSegmentSizeM) ||
    canvasSegmentSizeM <= 0 ||
    spline.points.length < 2
  )
    throw new RangeError(
      'Water Brush Canvas capture requires finite actor and Terrain poses, positive segment size and at least two spline points',
    );
  const canvasPosition = (point: WaterSplineSourcePoint): readonly [number, number] => {
    const world = worldPosition(point, worldMatrixM);
    const local = waterBrushWorldPointToTerrainLocal(terrainWorldMatrixM, world);
    return [local[0] + 0.5, local[2] + 0.5];
  };
  const sampler = createWaterSplineDistanceSampler(spline, worldMatrixM);
  const splineLengthM = sampler.lengthM;
  if (!(splineLengthM > 0)) return Object.freeze([]);
  const truncatedSegments = Math.trunc(splineLengthM / canvasSegmentSizeM);
  return Object.freeze(
    Array.from({ length: truncatedSegments }, (_, index) => {
      const distanceB = (index + 1) * canvasSegmentSizeM;
      const distanceC = (index + 2) * canvasSegmentSizeM;
      const vertices = [
        sampler.sampleAtDistanceM(0),
        sampler.sampleAtDistanceM(distanceC),
        sampler.sampleAtDistanceM(distanceB),
      ] as const;
      return Object.freeze({
        vertices: Object.freeze(vertices) as readonly [
          WaterSplineSourcePoint,
          WaterSplineSourcePoint,
          WaterSplineSourcePoint,
        ],
        canvasLocalXZ: Object.freeze(
          vertices.map(canvasPosition),
        ) as unknown as WaterBrushCanvasTriangle['canvasLocalXZ'],
        splineDistancesM: Object.freeze([0, distanceC, distanceB]) as readonly [
          number,
          number,
          number,
        ],
      });
    }),
  );
}
