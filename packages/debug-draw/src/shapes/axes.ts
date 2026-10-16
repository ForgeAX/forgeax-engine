// @forgeax/engine-debug-draw -- axes gizmo geometry (solo round 20260713-222551)
//
// Draws a transform's local coordinate frame as three arrows (X / Y / Z), matching
// Bevy `gizmos.axes(transform, base_length)`. Each axis endpoint is
// `translation + base_length * column_i` of the world matrix — i.e. Bevy's
// `transform.transform_point(base_length * Vec3::AXIS)` (the world-space direction the
// local axis points, scale included). Colors follow the universal convention:
// X = red, Y = green, Z = blue. No staging / GPU concerns; consumed by the DebugDraw class.

import type { Mat4, Vec3Like } from '@forgeax/engine-math';
import { arrowVertices } from './arrow';

/** X=red, Y=green, Z=blue RGBA (Bevy's axes convention). */
export const AXES_COLORS: readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
] = [
  [1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, 0, 1, 1],
];

/**
 * The three axis arrows for a world transform, as `{ vertices, color }` per axis
 * (X, Y, Z). The caller (DebugDraw.axes) pushes each with its color. `worldMat` is a
 * 16-float column-major mat4; the arrows originate at its translation (col 3) and point
 * `length` along its local X / Y / Z (columns 0 / 1 / 2, scale included, matching Bevy).
 */
export function axesArrowSets(
  worldMat: Mat4,
  length: number,
): { vertices: [number, number, number][]; color: readonly [number, number, number, number] }[] {
  const m = worldMat as unknown as ArrayLike<number>;
  const ox = m[12] as number;
  const oy = m[13] as number;
  const oz = m[14] as number;
  // Plain Vec3Like tuples (not branded Vec3) — arrowVertices accepts Vec3Like, so no
  // cross-boundary brand cast is needed (brand-cast lint: casts live only in math factories).
  const origin: Vec3Like = [ox, oy, oz];

  // Columns 0/1/2 are the local X/Y/Z basis in world space (rotation * scale).
  const cols: ReadonlyArray<readonly [number, number, number]> = [
    [m[0] as number, m[1] as number, m[2] as number],
    [m[4] as number, m[5] as number, m[6] as number],
    [m[8] as number, m[9] as number, m[10] as number],
  ];

  const sets: {
    vertices: [number, number, number][];
    color: readonly [number, number, number, number];
  }[] = [];
  for (let i = 0; i < 3; i++) {
    const c = cols[i] as readonly [number, number, number];
    const color = AXES_COLORS[i] as readonly [number, number, number, number];
    const end: Vec3Like = [ox + c[0] * length, oy + c[1] * length, oz + c[2] * length];
    sets.push({ vertices: arrowVertices(origin, end), color });
  }
  return sets;
}
