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
import { GlyphText } from '../components/glyph-text';
import { Tilemap } from '../components/tilemap';
export type GlobalTransformChangeQuery = Query<readonly [typeof GlobalTransform]>;

// Retained geometry consumes these component changes. Camera, lighting and
// environment facts are freshly extracted by deriveFramePlan on every draw;
// their edits must not recreate unrelated geometry or its submission history.
export const RENDERABLE_SOURCE_COMPONENTS = [
  ChildOf,
  Terrain,
  GlyphText,
  Tilemap,
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
  // runtime. Resolve the World-owned Skin token so the
  // retained projection observes the exact components the consumer registered,
  // even when module identity differs across those bundles.
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  const renderableComponents = RENDERABLE_SOURCE_COMPONENTS.map((component) =>
    component === Skin ? skin : component,
  );
  const components = [...renderableComponents, ...additional];
  const projection = createStateProjection(world, components, [
    ...components,
    Transform,
    GlobalTransform,
  ]);
  const entities = new Map<number, EntityHandle>();
  const batch = projection.read();
  for (const index of batch.indices) {
    const entity = projection.entity(index);
    if (entity !== undefined) {
      entities.set(index, entity);
    }
  }
  return {
    projection,
    entities,
    batch,
    renderableComponents,
  };
}

export function isRenderableMember(world: World, entity: number): boolean {
  return (
    (world.hasComponent(entity as EntityHandle, Tilemap) ||
      world.hasComponent(entity as EntityHandle, GlyphText) ||
      world.hasComponent(entity as EntityHandle, Terrain) ||
      world.hasComponent(entity as EntityHandle, MeshRenderer)) &&
    world.hasComponent(entity as EntityHandle, Transform) &&
    (world.hasComponent(entity as EntityHandle, Tilemap) ||
      world.hasComponent(entity as EntityHandle, GlyphText) ||
      world.hasComponent(entity as EntityHandle, Terrain) ||
      world.hasComponent(entity as EntityHandle, MeshFilter))
  );
}
