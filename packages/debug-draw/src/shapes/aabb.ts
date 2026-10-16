// @forgeax/engine-debug-draw -- aabb shape geometry (M3 / w20)
//
// Pure geometry decomposition: 12 edges (24 vertices) from 8 corners.
// No staging / GPU concerns; consumed by DebugDraw class.

import type { Vec3 } from '@forgeax/engine-math';

function a(v: { readonly [index: number]: number }, i: number): number {
  return v[i] as number;
}

/** 24 vertices forming a wireframe axis-aligned bounding box (12 edges). */
export function aabbVertices(min: Vec3, max: Vec3): [number, number, number][] {
  const mnx = a(min, 0);
  const mny = a(min, 1);
  const mnz = a(min, 2);
  const mxx = a(max, 0);
  const mxy = a(max, 1);
  const mxz = a(max, 2);

  // 8 corners: x in {mnx, mxx}, y in {mny, mxy}, z in {mnz, mxz}
  const c: [number, number, number][] = [
    [mnx, mny, mnz], // 0
    [mxx, mny, mnz], // 1
    [mnx, mxy, mnz], // 2
    [mxx, mxy, mnz], // 3
    [mnx, mny, mxz], // 4
    [mxx, mny, mxz], // 5
    [mnx, mxy, mxz], // 6
    [mxx, mxy, mxz], // 7
  ];

  // 12 edges
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [4, 5],
    [4, 6],
    [5, 7],
    [6, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const result: [number, number, number][] = [];
  for (const [ai, bi] of edges) {
    const ac = c[ai] as [number, number, number];
    const bc = c[bi] as [number, number, number];
    result.push([ac[0], ac[1], ac[2]]);
    result.push([bc[0], bc[1], bc[2]]);
  }
  return result;
}
