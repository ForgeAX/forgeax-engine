import { RuntimeMaterialValue, RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import type { Component, EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { ChildOf, GlobalTransform, Mobility, MorphWeights, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { Terrain } from '@forgeax/engine-terrain';
import {
  Instances,
  Layer,
  Lines,
  MeshFilter,
  MeshRenderer,
  Points,
  ShadowParticipation,
  SortKey,
  SpriteInstances,
  SpriteRegionOverride,
  Visibility,
} from '../components';
export type GlobalTransformChangeQuery = Query<readonly [typeof GlobalTransform]>;

// Retained geometry consumes these component changes. Camera, lighting and
// environment facts are freshly extracted by deriveFramePlan on every draw;
// their edits must not recreate unrelated geometry or its submission history.
export const RENDERABLE_SOURCE_COMPONENTS = [
  ChildOf,
  Terrain,
  MeshFilter,
  MeshRenderer,
  Instances,
  SpriteInstances,
  SpriteRegionOverride,
  Skin,
  Layer,
  Visibility,
  MorphWeights,
  Points,
  Lines,
  SortKey,
  Mobility,
  ShadowParticipation,
] as const;
export function createGlobalTransformChangeQuery(world: World): GlobalTransformChangeQuery {
  const result = world.query({ read: [GlobalTransform], changed: [GlobalTransform] });
  if (!result.ok) throw result.error;
  const query = result.value as GlobalTransformChangeQuery;
  for (const _span of query.spans().unwrap()) {
    // The full rebuild consumed these values; establish the observation baseline.
  }
  return query;
}

export function createRenderSourceState(world: World, additional: readonly Component[] = []) {
  // Numerical poses already have one span reader. Keep their table membership
  // in this projection, without scanning their changed rows a second time.
  // Execution bootstrap modules are separately bundled from the static Worker
  // runtime. Resolve the World-owned Skin and runtime-content tokens so the
  // retained projection observes the exact components the consumer registered,
  // even when module identity differs across those bundles.
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  const runtimeMaterialValue =
    (world.components.resolve(RuntimeMaterialValue.name) as
      | typeof RuntimeMaterialValue
      | undefined) ?? RuntimeMaterialValue;
  const runtimeMeshVertices =
    (world.components.resolve(RuntimeMeshVertices.name) as
      | typeof RuntimeMeshVertices
      | undefined) ?? RuntimeMeshVertices;
  const renderableComponents = RENDERABLE_SOURCE_COMPONENTS.map((component) =>
    component === Skin ? skin : component,
  );
  const components = [
    ...renderableComponents,
    runtimeMaterialValue,
    runtimeMeshVertices,
    ...additional,
  ];
  const projection = createStateProjection(world, components, [
    ...components,
    Transform,
    GlobalTransform,
  ]);
  const entities = new Map<number, EntityHandle>();
  const contentHandles = new Map<number, readonly number[]>();
  const batch = projection.read();
  for (const index of batch.indices) {
    const entity = projection.entity(index);
    if (entity !== undefined) {
      entities.set(index, entity);
      const handles: number[] = [];
      const material = world.hasComponent(entity, runtimeMaterialValue)
        ? world.get(entity, runtimeMaterialValue)
        : undefined;
      const mesh = world.hasComponent(entity, runtimeMeshVertices)
        ? world.get(entity, runtimeMeshVertices)
        : undefined;
      if (material?.ok) handles.push(Number(material.value.asset));
      if (mesh?.ok) handles.push(Number(mesh.value.asset));
      if (handles.length > 0) contentHandles.set(index, handles);
    }
  }
  return {
    projection,
    entities,
    contentHandles,
    batch,
    renderableComponents,
    runtimeMaterialValue,
    runtimeMeshVertices,
  };
}

export function isRenderableMember(world: World, entity: number): boolean {
  return (
    (world.hasComponent(entity as EntityHandle, Terrain) ||
      world.hasComponent(entity as EntityHandle, MeshRenderer)) &&
    world.hasComponent(entity as EntityHandle, Transform) &&
    (world.hasComponent(entity as EntityHandle, Terrain) ||
      world.hasComponent(entity as EntityHandle, MeshFilter))
  );
}
