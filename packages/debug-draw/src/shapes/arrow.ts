// @forgeax/engine-debug-draw -- arrow shape geometry (solo round 20260713-222551)
//
// Pure geometry decomposition: an arrow = 1 body segment (start->end) + 4 arrowhead
// segments from `end` back toward 4 canonical tip vectors, rotated so local +X aligns
// with the arrow's direction. Mirrors Bevy `bevy_gizmos::arrows` ArrowBuilder::drop.
// No staging / GPU concerns; consumed by the DebugDraw class.

import type { Vec3Like } from '@forgeax/engine-math';
import { quat, vec3 } from '@forgeax/engine-math';

// The 4 arrowhead tip directions in the arrow's local frame (arrow points toward +X),
// matching Bevy's tips array. Normalized when scaled to tipLength.
const TIP_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 1, 0],
  [-1, 0, 1],
  [-1, -1, 0],
  [-1, 0, -1],
];

// Plain Vec3Like (not a branded Vec3) — `quat.fromUnitVectors` accepts Vec3Like, so no
// cross-boundary brand cast is needed (brand-cast lint: casts live only in math factories).
const UNIT_X: Vec3Like = [1, 0, 0];

/**
 * Line-segment vertices for an arrow from `start` to `end`.
 * Returns 10 vertices = 5 segments (1 body + 4 arrowhead), each a [x,y,z] pair
 * consumed pairwise by the line-list renderer.
 *
 * `tipLength` defaults to `|end - start| / 10` (Bevy's default arrowhead length).
 * A degenerate (zero-length) arrow emits only the body segment (no orientable head).
 */
export function arrowVertices(
  start: Vec3Like,
  end: Vec3Like,
  tipLength?: number,
): [number, number, number][] {
  const sx = start[0] as number;
  const sy = start[1] as number;
  const sz = start[2] as number;
  const ex = end[0] as number;
  const ey = end[1] as number;
  const ez = end[2] as number;

  const verts: [number, number, number][] = [
    [sx, sy, sz],
    [ex, ey, ez],
  ];

  const dir = vec3.create();
  vec3.set(dir, ex - sx, ey - sy, ez - sz);
  const len = vec3.length(dir);
  if (len < 1e-6) return verts; // degenerate: no orientable head

  const headLen = tipLength ?? len / 10;
  vec3.normalize(dir, dir);

  // Rotate the local-frame tip vectors so +X faces the arrow direction.
  const rot = quat.fromUnitVectors(quat.create(), UNIT_X, dir);
  const tipLocal = vec3.create();
  const tipWorld = vec3.create();
  for (const [tx, ty, tz] of TIP_DIRS) {
    vec3.set(tipLocal, tx, ty, tz);
    vec3.normalize(tipLocal, tipLocal);
    vec3.scale(tipLocal, tipLocal, headLen);
    quat.transformVec3(tipWorld, rot, tipLocal);
    // Head segment: from the arrow tip (end) back out to the rotated tip vector.
    verts.push([ex, ey, ez]);
    verts.push([
      ex + (tipWorld[0] as number),
      ey + (tipWorld[1] as number),
      ez + (tipWorld[2] as number),
    ]);
  }
  return verts;
}
