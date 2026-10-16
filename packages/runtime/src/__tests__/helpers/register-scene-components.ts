import type { Component, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, GlobalTransform, Transform } from '@forgeax/engine-scene';

/** Register the scene vocabulary explicitly for an isolated test World. */
export function registerSceneComponents(world: World, extras: readonly Component[] = []): void {
  for (const component of [
    SceneInstance,
    ChildOf,
    Children,
    Transform,
    GlobalTransform,
    ...extras,
  ]) {
    world.components.register(component).unwrap();
  }
}
