import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, type Vec3Like } from '@forgeax/engine-math';
import { ok, type Result } from '@forgeax/engine-types';
import { Transform } from './components/transform';

const WORLD_UP: Vec3Like = [0, 1, 0];
const pose = new Float32Array(7);
const rotation = quat.create();

/**
 * Place `entity` at `eye` and aim its -Z at `target` (three.js `position.copy` +
 * `lookAt`). Writes Transform only when the stored f32 pose differs, so a camera
 * calling it every frame publishes a change only when it actually moves.
 * Returns whether it wrote.
 *
 * @example
 * ```ts
 * setTransformLookAt(world, camera, eye, look).unwrap();
 * ```
 */
export function setTransformLookAt(
  world: World,
  entity: EntityHandle,
  eye: Vec3Like,
  target: Vec3Like,
  up: Vec3Like = WORLD_UP,
): Result<boolean, EcsError> {
  const current = world.get(entity, Transform);
  if (!current.ok) return current;
  quat.fromLookAt(rotation, eye, target, up);
  pose.set(eye, 0);
  pose.set(rotation, 3);
  const { pos, quat: stored } = current.value;
  if (
    pos[0] === pose[0] &&
    pos[1] === pose[1] &&
    pos[2] === pose[2] &&
    stored[0] === pose[3] &&
    stored[1] === pose[4] &&
    stored[2] === pose[5] &&
    stored[3] === pose[6]
  )
    return ok(false);
  const written = world.set(entity, Transform, {
    pos: pose.subarray(0, 3),
    quat: pose.subarray(3, 7),
  });
  return written.ok ? ok(true) : written;
}
