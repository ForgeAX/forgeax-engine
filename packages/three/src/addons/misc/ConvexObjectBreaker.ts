import { ConvexObjectBreaker as OriginalConvexObjectBreaker } from 'three/examples/jsm/misc/ConvexObjectBreaker.js';
import type { Mesh, Plane, Vector3 } from 'three/src/Three.Core.js';
export interface CutByPlaneOutput {
  object1: Mesh | null;
  object2: Mesh | null;
}
export interface ConvexObjectBreaker {
  prepareBreakableObject(
    object: Mesh,
    mass: number,
    velocity: Vector3,
    angularVelocity: Vector3,
    breakable: boolean,
  ): void;
  subdivideByImpact(
    object: Mesh,
    pointOfImpact: Vector3,
    normal: Vector3,
    maxRadialIterations: number,
    maxRandomIterations: number,
  ): Mesh[];
  cutByPlane(object: Mesh, plane: Plane, output: CutByPlaneOutput): 0 | 1 | 2;
}
export const ConvexObjectBreaker = OriginalConvexObjectBreaker as unknown as Omit<
  typeof OriginalConvexObjectBreaker,
  'prototype'
> & {
  new (minSizeForBreak?: number, smallDelta?: number): ConvexObjectBreaker;
  readonly prototype: ConvexObjectBreaker;
};
