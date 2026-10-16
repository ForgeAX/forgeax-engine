// @forgeax/engine-debug-draw -- sphere shape geometry (M3 / w21)
//
// Pure geometry decomposition: 3 orthogonal great-circle rings
// (XY, XZ, YZ planes). Each ring has `segments` segments producing
// 2 vertices each. Default segments=16 gives 96 vertices (3 * 2 * 16).
// No staging / GPU concerns; consumed by DebugDraw class.

import type { Vec3 } from '@forgeax/engine-math';

function a(v: { readonly [index: number]: number }, i: number): number {
  return v[i] as number;
}

/**
 * Generate vertices for a wireframe sphere.
 * Returns 3 * 2 * segments vertices (pairs forming line segments).
 */
export function sphereVertices(
  center: Vec3,
  radius: number,
  segments: number,
): [number, number, number][] {
  const cx = a(center, 0);
  const cy = a(center, 1);
  const cz = a(center, 2);
  const step = (2 * Math.PI) / segments;

  const result: [number, number, number][] = [];

  for (let plane = 0; plane < 3; plane++) {
    for (let i = 0; i < segments; i++) {
      const angle0 = i * step;
      const angle1 = (i + 1) % segments;

      let p0x: number;
      let p0y: number;
      let p0z: number;
      let p1x: number;
      let p1y: number;
      let p1z: number;

      if (plane === 0) {
        // XY plane
        p0x = cx + radius * Math.cos(angle0);
        p0y = cy + radius * Math.sin(angle0);
        p0z = cz;
        p1x = cx + radius * Math.cos(angle1);
        p1y = cy + radius * Math.sin(angle1);
        p1z = cz;
      } else if (plane === 1) {
        // XZ plane
        p0x = cx + radius * Math.cos(angle0);
        p0y = cy;
        p0z = cz + radius * Math.sin(angle0);
        p1x = cx + radius * Math.cos(angle1);
        p1y = cy;
        p1z = cz + radius * Math.sin(angle1);
      } else {
        // YZ plane
        p0x = cx;
        p0y = cy + radius * Math.cos(angle0);
        p0z = cz + radius * Math.sin(angle0);
        p1x = cx;
        p1y = cy + radius * Math.cos(angle1);
        p1z = cz + radius * Math.sin(angle1);
      }

      result.push([p0x, p0y, p0z]);
      result.push([p1x, p1y, p1z]);
    }
  }

  return result;
}
