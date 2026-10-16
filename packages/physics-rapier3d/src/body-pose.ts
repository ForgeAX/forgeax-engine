import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { ChildOf, GlobalTransform } from '@forgeax/engine-scene';
import type { RigidBody } from '../pkg/rapier.mjs';

/** Convert a physics world position to the entity's authored local Transform. */
export function localPositionForWorld3D(
  world: World,
  entity: EntityHandle,
  target: { readonly x: number; readonly y: number; readonly z: number },
): Vec3 {
  const local = vec3.create(target.x, target.y, target.z);
  if (!world.hasComponent(entity, ChildOf)) return local;
  const child = world.get(entity, ChildOf).unwrap();
  const parent = world.get(child.parent as EntityHandle, GlobalTransform).unwrap().world;
  const inverse = mat4.create();
  mat4.invert(inverse, parent);
  mat4.transformPoint(local, inverse, local);
  return local;
}

/** Keep attached collider query poses aligned with an immediate body translation. */
export function translateAttachedColliders3D(
  body: RigidBody,
  delta: { readonly x: number; readonly y: number; readonly z: number },
): void {
  for (let index = 0; index < body.numColliders(); index++) {
    const attached = body.collider(index);
    const position = attached.translation();
    attached.setTranslation({
      x: position.x + delta.x,
      y: position.y + delta.y,
      z: position.z + delta.z,
    });
  }
}
