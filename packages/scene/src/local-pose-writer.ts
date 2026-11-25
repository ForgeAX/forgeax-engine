import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createEntityLookup } from '@forgeax/engine-ecs/internal';
import { Transform } from './components/transform';

/** Transfer a published local TRS to its actual component columns. The projection
 * retains source precision separately; ECS stores float32 and emits one row change. */
export function createLocalPoseWriter(world: World) {
  const lookup = createEntityLookup(
    world,
    [Transform],
    [
      [0, 'pos'],
      [0, 'quat'],
      [0, 'scale'],
    ],
  );
  return (entity: EntityHandle, lanes: ArrayLike<number>, offset: number): void => {
    // Read and round before locating a destination. An authored getter can move or
    // retire the entity, call this writer again, or supply an aliased source.
    const px = Math.fround(lanes[offset] as number);
    const py = Math.fround(lanes[offset + 1] as number);
    const pz = Math.fround(lanes[offset + 2] as number);
    const qx = Math.fround(lanes[offset + 3] as number);
    const qy = Math.fround(lanes[offset + 4] as number);
    const qz = Math.fround(lanes[offset + 5] as number);
    const qw = Math.fround(lanes[offset + 6] as number);
    const sx = Math.fround(lanes[offset + 7] as number);
    const sy = Math.fround(lanes[offset + 8] as number);
    const sz = Math.fround(lanes[offset + 9] as number);
    if (world.execution.health === 'healthy' && lookup.get(entity)) {
      const fields = lookup.columns.fields;
      const position = fields[0],
        rotation = fields[1],
        scale = fields[2];
      if (position && rotation && scale) {
        const index = lookup.row;
        const vectorOffset = index * 3;
        const quaternionOffset = index * 4;
        const p = position.view;
        const q = rotation.view;
        const s = scale.view;
        const translated =
          !Object.is(p[vectorOffset], px) ||
          !Object.is(p[vectorOffset + 1], py) ||
          !Object.is(p[vectorOffset + 2], pz);
        const rotated =
          !Object.is(q[quaternionOffset], qx) ||
          !Object.is(q[quaternionOffset + 1], qy) ||
          !Object.is(q[quaternionOffset + 2], qz) ||
          !Object.is(q[quaternionOffset + 3], qw);
        const scaled =
          !Object.is(s[vectorOffset], sx) ||
          !Object.is(s[vectorOffset + 1], sy) ||
          !Object.is(s[vectorOffset + 2], sz);
        if (translated || rotated || scaled) {
          // Reserve the row change before modifying any column.
          lookup.markChanged(0);
          if (translated) {
            p[vectorOffset] = px;
            p[vectorOffset + 1] = py;
            p[vectorOffset + 2] = pz;
          }
          if (rotated) {
            q[quaternionOffset] = qx;
            q[quaternionOffset + 1] = qy;
            q[quaternionOffset + 2] = qz;
            q[quaternionOffset + 3] = qw;
          }
          if (scaled) {
            s[vectorOffset] = sx;
            s[vectorOffset + 1] = sy;
            s[vectorOffset + 2] = sz;
          }
        }
        return;
      }
    }
    // Use normal World errors for stale entities, missing components and poisoned Worlds.
    world
      .set(entity, Transform, {
        pos: Float32Array.of(px, py, pz),
        quat: Float32Array.of(qx, qy, qz, qw),
        scale: Float32Array.of(sx, sy, sz),
      })
      .unwrap();
  };
}
