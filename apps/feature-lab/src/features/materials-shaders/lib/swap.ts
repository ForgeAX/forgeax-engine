import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { MeshRenderer } from '@forgeax/engine/render';

type Ref = ReturnType<World['allocSharedRef']>;

/** Returns a toggle that assigns `on` or `off` as the entity's only material. */
export function materialToggle(
  world: World,
  entity: EntityHandle,
  on: Ref,
  off: Ref,
): (enabled: boolean) => void {
  return (enabled) => {
    world.set(entity, MeshRenderer, { materials: [enabled ? on : off] } as never);
  };
}
