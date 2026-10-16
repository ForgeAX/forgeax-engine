import type { World } from '@forgeax/engine-ecs';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

/**
 * Ensure the neutral camera used only by hosts that have no game bootstrap.
 * An authored scene camera wins; a resolved game owns its camera policy and
 * must not call this helper.
 */
export function ensureFallbackCamera(
  world: World,
  aspect = 1,
): ReturnType<World['spawn']> | undefined {
  const cameras = world.query({ with: [Camera] }).unwrap();
  if (!cameras[Symbol.iterator]().next().done) return undefined;
  return world.spawn(
    { component: Transform, data: { pos: [0, 0.6, 5] } },
    { component: Camera, data: perspective({ fov: Math.PI / 3, aspect, far: 1000 }) },
  );
}
