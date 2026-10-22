import type { Component, EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { createStateProjection, type StateProjectionBatch } from '@forgeax/engine-ecs/projection';
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
export interface RenderSourceEntity {
  readonly entity: EntityHandle;
  /** Accepted presence only, needed because ECS value ticks omit removed components. */
  readonly hierarchyPresence: number;
}

const EMPTY_SOURCE_ROWS: readonly (RenderSourceEntity | undefined)[] = Object.freeze([]);

function sourceEntity(
  world: World,
  entity: EntityHandle,
  previous?: RenderSourceEntity,
): RenderSourceEntity {
  const hierarchyPresence =
    (world.hasComponent(entity, ChildOf) ? 1 : 0) |
    (world.hasComponent(entity, Visibility) ? 2 : 0);
  return previous?.entity === entity && previous.hierarchyPresence === hierarchyPresence
    ? previous
    : { entity, hierarchyPresence };
}

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
  const entities = new Map<number, RenderSourceEntity>();
  const batch = projection.read();
  for (const index of batch.indices) {
    const entity = projection.entity(index);
    if (entity !== undefined) {
      entities.set(index, sourceEntity(world, entity));
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

/** Capture only the known source changes, before producer callbacks or acceptance. */
export function captureRenderSourceEntities(
  world: World,
  source: ReturnType<typeof createRenderSourceState>,
  batch: StateProjectionBatch,
): readonly (RenderSourceEntity | undefined)[] {
  if (batch.indices.length === 0) return EMPTY_SOURCE_ROWS;
  const rows: (RenderSourceEntity | undefined)[] = [];
  for (const index of batch.indices) {
    const entity = source.projection.entity(index);
    rows.push(
      entity === undefined ? undefined : sourceEntity(world, entity, source.entities.get(index)),
    );
  }
  return rows;
}

export function renderSourceHierarchyChanged(
  source: ReturnType<typeof createRenderSourceState>,
  index: number,
  current: RenderSourceEntity,
): boolean {
  const previous = source.entities.get(index);
  return (
    previous?.entity !== current.entity ||
    previous.hierarchyPresence !== current.hierarchyPresence ||
    source.projection.changed(current.entity, ChildOf) ||
    source.projection.changed(current.entity, Visibility)
  );
}

/** The caller accepts its source candidate first. Discard never advances these observations. */
export function acceptRenderSourceEntities(
  source: ReturnType<typeof createRenderSourceState>,
  indices: readonly number[],
  rows: readonly (RenderSourceEntity | undefined)[],
): void {
  if (rows.length !== indices.length)
    throw new Error('Source observation extent does not match its accepted candidate');
  let cursor = 0;
  for (const index of indices) {
    const row = rows[cursor++];
    if (row === undefined) source.entities.delete(index);
    else if (source.entities.get(index) !== row) source.entities.set(index, row);
  }
}
