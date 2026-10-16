import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { SceneEntityRef } from '@forgeax/engine-types';
import { sceneEntity, sceneEntityAddressFromKey } from './binding.js';
import { worldGetSceneInstanceState } from './scene-instances.js';

/**
 * @internal Reverse keyed-binding lookup for diagnostics. Prefers the outermost
 * instance (no parent `instanceKey`), whose address spans nested instances.
 * Returns undefined for entities that no SceneInstance binds.
 */
export function worldSceneEntityRefOf(
  world: World,
  entity: EntityHandle,
): SceneEntityRef | undefined {
  const component = world.components.resolve('SceneInstance');
  if (component === undefined) return undefined;
  const query = world.query({ read: [component] });
  if (!query.ok) return undefined;
  let nested: SceneEntityRef | undefined;
  for (const row of query.value) {
    const resolved = worldGetSceneInstanceState(world, row.entity);
    if (!resolved.ok) continue;
    const state = resolved.value;
    for (const [key, bound] of state.bindings) {
      if (bound !== entity) continue;
      const ref = sceneEntity(state.sceneSourceKey ?? '', sceneEntityAddressFromKey(key));
      if (state.instanceKey === undefined) return ref;
      nested ??= ref;
    }
  }
  return nested;
}
