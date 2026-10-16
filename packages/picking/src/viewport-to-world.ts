import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { ray } from '@forgeax/engine-math';
import { computeScreenRay } from './pick-core';

/**
 * Unproject a viewport pixel into a world-space ray.
 *
 * `screenX`/`screenY` use the canvas convention: top-left origin, y down.
 * The caller must run `propagateTransforms(world)` for the current frame first.
 * A camera without a resolvable Transform returns `undefined`; a missing
 * Camera component throws the package's structured `PickError`.
 */
export function viewportToWorld(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): ray.Ray | undefined {
  return computeScreenRay(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)
    ?.ray;
}
