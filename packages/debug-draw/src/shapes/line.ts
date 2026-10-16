// @forgeax/engine-debug-draw -- line shape geometry (M3 / w20)
//
// Pure geometry decomposition: 1 segment = 2 vertices.
// No staging / GPU concerns; consumed by DebugDraw class.

import type { Vec3 } from '@forgeax/engine-math';

/** 2 vertices forming a line segment from `a` to `b`. */
export function lineVertices(a: Vec3, b: Vec3): [number, number, number][] {
  return [
    [a[0] as number, a[1] as number, a[2] as number],
    [b[0] as number, b[1] as number, b[2] as number],
  ];
}
