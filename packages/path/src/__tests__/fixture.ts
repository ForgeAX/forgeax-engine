import type { PathDefinition } from '../index';
export function definition(points = [0, 0, 0, 0, 0, 10]): PathDefinition {
  return {
    points: Float32Array.from(points),
    closed: false,
    parameterization: 1,
    subdivisions: 2048,
    up: Float32Array.from([0, 1, 0]),
  };
}
