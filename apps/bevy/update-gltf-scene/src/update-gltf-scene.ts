import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { Children, Transform } from '@forgeax/engine-scene';

/** Marker on the synthetic root that owns the instantiated glTF scene. */
export const MovedScene = defineComponent('MovedScene', {});

/** Return every live descendant in Children order, excluding the scene root. */
export function sceneDescendants(world: World, root: EntityHandle): EntityHandle[] {
  const descendants: EntityHandle[] = [];
  const visit = (parent: EntityHandle): void => {
    const children = world.get(parent, Children);
    if (!children.ok) return;
    for (const child of children.value.entities) {
      const handle = child as EntityHandle;
      descendants.push(handle);
      visit(handle);
    }
  };
  visit(root);
  return descendants;
}

/**
 * Move all descendants of each marked scene root, matching Bevy's
 * `children.iter_descendants` update system. The scene hierarchy remains owned
 * by ChildOf/Children; only each descendant's local Transform is updated.
 */
export function stepUpdateGltfScene(world: World, elapsed: number): void {
  const roots = world.query({ with: [MovedScene] }).unwrap();
  for (const row of roots) {
      const root = row.entity;
      let offset = 0;
      for (const descendant of sceneDescendants(world, root)) {
        const transform = world.get(descendant, Transform);
        if (transform.ok) {
          world.set(descendant, Transform, {
            pos: [
              (offset * Math.sin(elapsed)) / 20,
              0,
              Math.cos(elapsed) / 20,
            ],
          });
        }
        offset += 0.5;
      }
  }
}
