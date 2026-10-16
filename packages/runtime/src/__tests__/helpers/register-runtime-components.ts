import type { Component, World } from '@forgeax/engine-ecs';
import { VideoPlayer } from '@forgeax/engine-graphics-extras';
import {
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  PostProcessParams,
  SceneInstance,
  SkyboxBackground,
  Skylight,
  SortKey,
  SpotLight,
  Visibility,
} from '@forgeax/engine-render';
import {
  SpriteAnimation,
  SpriteInstances,
  SpriteRegionOverride,
  TileLayer,
  Tilemap,
} from '@forgeax/engine-render/authoring';
import {
  ChildOf,
  Children,
  GlobalTransform,
  MorphWeights,
  Name,
  Transform,
} from '@forgeax/engine-scene';

const RUNTIME_COMPONENTS: readonly Component[] = [
  Camera,
  ChildOf,
  Children,
  DirectionalLight,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  MorphWeights,
  Name,
  PointLight,
  PointLightShadow,
  PostProcessParams,
  SceneInstance,
  Skylight,
  SkyboxBackground,
  SortKey,
  SpotLight,
  SpriteAnimation,
  SpriteInstances,
  SpriteRegionOverride,
  TileLayer,
  Tilemap,
  Transform,
  GlobalTransform,
  VideoPlayer,
  Visibility,
];

/** Install the broad render/scene vocabulary for isolated runtime test worlds. */
export function registerRuntimeComponents(
  world: Pick<World, 'components'>,
  extras: readonly Component[] = [],
): void {
  for (const component of [...RUNTIME_COMPONENTS, ...extras]) {
    const existing = world.components.resolve(component.name);
    if (existing === component) continue;
    if (existing !== undefined) {
      throw new Error(`component name conflict: ${component.name}`);
    }
    world.components.register(component).unwrap();
  }
}
