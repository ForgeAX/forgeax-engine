import type { Component, EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { createStateProjection, type StateProjectionBatch } from '@forgeax/engine-ecs/projection';
import {
  ChildOf,
  Children,
  GlobalTransform,
  Mobility,
  MorphWeights,
  Transform,
  WaterBodyInstance,
} from '@forgeax/engine-scene';
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

/**
 * Accepted source rows keyed by entity slot, stored as typed columns: a
 * million sources cost two typed cells each instead of one object each.
 * `get` and `values` materialize transient rows.
 */
export class RenderSourceEntities {
  private entities = new Uint32Array(64);
  /** Hierarchy presence bits, or -1 for an absent slot. */
  private presence = new Int8Array(64).fill(-1);
  size = 0;

  get(index: number): RenderSourceEntity | undefined {
    const presence = this.presence[index];
    return presence === undefined || presence < 0
      ? undefined
      : { entity: this.entities[index] as EntityHandle, hierarchyPresence: presence };
  }

  set(index: number, row: RenderSourceEntity): void {
    if (index >= this.presence.length) this.grow(index);
    if ((this.presence[index] as number) < 0) this.size++;
    this.entities[index] = row.entity as number;
    this.presence[index] = row.hierarchyPresence;
  }

  delete(index: number): void {
    if ((this.presence[index] ?? -1) < 0) return;
    this.presence[index] = -1;
    this.size--;
  }

  *values(): IterableIterator<RenderSourceEntity> {
    for (let index = 0; index < this.presence.length; index++) {
      const row = this.get(index);
      if (row !== undefined) yield row;
    }
  }

  private grow(index: number): void {
    let capacity = this.presence.length;
    while (capacity <= index) capacity *= 2;
    const entities = new Uint32Array(capacity);
    entities.set(this.entities);
    const presence = new Int8Array(capacity).fill(-1);
    presence.set(this.presence);
    this.entities = entities;
    this.presence = presence;
  }
}

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
  WaterBodyInstance,
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
  const entities = new RenderSourceEntities();
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
      world.hasComponent(entity as EntityHandle, WaterBodyInstance) ||
      world.hasComponent(entity as EntityHandle, MeshRenderer)) &&
    world.hasComponent(entity as EntityHandle, Transform) &&
    (world.hasComponent(entity as EntityHandle, Tilemap) ||
      world.hasComponent(entity as EntityHandle, GlyphText) ||
      world.hasComponent(entity as EntityHandle, Terrain) ||
      world.hasComponent(entity as EntityHandle, WaterBodyInstance) ||
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
    source.projection.changed(current.entity, Visibility) ||
    // Descendants without their own Mobility inherit this one.
    source.projection.changed(current.entity, Mobility)
  );
}

export interface RenderSourceMembership {
  has(entity: number): boolean;
  /** Retained content can depend on component presence, independently of value writes. */
  changed?(entity: number): boolean;
}

interface RenderSourceDelta {
  readonly changed: ReadonlySet<number>;
  readonly content: ReadonlySet<number>;
  readonly removed: ReadonlySet<number>;
  readonly retiredTransforms: ReadonlySet<number>;
  readonly meshFilterWrites: number;
}

const EMPTY_ENTITIES: ReadonlySet<number> = new Set();
interface RenderSourceChangeBuffers {
  readonly changed: Set<number>;
  readonly content: Set<number> | false;
  readonly removed: Set<number>;
  readonly onChanged?: (
    reason: 'hierarchy' | 'renderable-component-or-new',
    inserted: boolean,
  ) => void;
}

function markSourceHierarchyChanges(
  world: World,
  current: EntityHandle,
  visited: Set<number> | undefined,
  content: Set<number> | false,
  markChanged: (entity: number, reason: 'hierarchy') => void,
): Set<number> {
  const hierarchy = visited ?? new Set<number>();
  const pending: EntityHandle[] = [current];
  while (pending.length > 0) {
    const entity = pending.pop();
    if (entity === undefined || hierarchy.has(entity)) continue;
    hierarchy.add(entity);
    if (isRenderableMember(world, entity)) {
      markChanged(entity, 'hierarchy');
      if (content !== false) content.add(entity);
    }
    const children = world.get(entity, Children);
    if (children.ok)
      for (const child of children.value.entities) pending.push(child as EntityHandle);
  }
  return hierarchy;
}

/** Observed facts only: the caller advances the source batch after its own admission succeeds. */
function observeRenderSourceChanges(
  world: World,
  source: ReturnType<typeof createRenderSourceState>,
  batch: StateProjectionBatch,
  rows: readonly (RenderSourceEntity | undefined)[],
  members: RenderSourceMembership,
  baseline: boolean,
  buffers: RenderSourceChangeBuffers,
): RenderSourceDelta {
  const { changed, content, removed } = buffers;
  if (batch.indices.length === 0)
    return {
      changed,
      content: content === false ? EMPTY_ENTITIES : content,
      removed,
      retiredTransforms: EMPTY_ENTITIES,
      meshFilterWrites: 0,
    };
  let retiredTransforms: Set<number> | undefined;
  let hierarchy: Set<number> | undefined;
  const markChanged = (entity: number, reason: 'hierarchy' | 'renderable-component-or-new') => {
    const size = changed.size;
    changed.add(entity);
    buffers.onChanged?.(reason, size !== changed.size);
  };
  let meshFilterWrites = 0;
  const contentComponents = source.renderableComponents.filter(
    (component) => component !== Instances && batch.changedComponents.includes(component),
  );
  const contentChanged = (index: number, current: EntityHandle): boolean => {
    let dirty =
      baseline ||
      batch.hasStructuralChange(index) ||
      !members.has(current) ||
      (batch.membershipChanged && members.changed?.(current) === true);
    for (const component of contentComponents) {
      if (!source.projection.changed(current, component)) continue;
      dirty = true;
      if (component.name === MeshFilter.name) meshFilterWrites++;
    }
    return dirty;
  };
  const retirePrevious = (
    previous: EntityHandle | undefined,
    current: EntityHandle | undefined,
  ) => {
    if (previous !== undefined) {
      if (members.has(previous) && (previous !== current || !isRenderableMember(world, previous)))
        removed.add(previous);
      if (previous !== current || !world.hasComponent(previous, GlobalTransform)) {
        retiredTransforms ??= new Set();
        retiredTransforms.add(previous);
      }
    }
  };
  const instancesChanged = batch.changedComponents.includes(Instances);
  let cursor = 0;
  for (const index of batch.indices) {
    const row = rows[cursor++];
    const current = row?.entity;
    const previous = source.entities.get(index)?.entity;
    retirePrevious(previous, current);
    if (current === undefined) continue;
    const dirty = contentChanged(index, current);
    if (isRenderableMember(world, current)) {
      if (dirty && content !== false) content.add(current);
      if (dirty || (instancesChanged && source.projection.changed(current, Instances)))
        markChanged(current, 'renderable-component-or-new');
    }
    if (row === undefined || !renderSourceHierarchyChanged(source, index, row)) continue;
    hierarchy = markSourceHierarchyChanges(world, current, hierarchy, content, markChanged);
  }
  return {
    changed,
    content: content === false ? EMPTY_ENTITIES : content,
    removed,
    retiredTransforms: retiredTransforms ?? EMPTY_ENTITIES,
    meshFilterWrites,
  };
}

/** One observed source candidate; only successful admission advances its captured cursor. */
export function readRenderSourceChanges(
  world: World,
  source: ReturnType<typeof createRenderSourceState>,
  members: RenderSourceMembership,
  baseline = false,
  buffers: RenderSourceChangeBuffers = {
    changed: new Set(),
    content: new Set(),
    removed: new Set(),
  },
) {
  const batch = source.projection.read();
  const rows = captureRenderSourceEntities(world, source, batch);
  const changes = observeRenderSourceChanges(
    world,
    source,
    batch,
    rows,
    members,
    baseline,
    buffers,
  );
  let closed = false;
  const validate = () => {
    if (closed) throw new Error('Render source candidate is closed');
    batch.validate();
  };
  return {
    batch,
    changes,
    validate,
    accept() {
      validate();
      batch.accept();
      acceptRenderSourceEntities(source, batch.indices, rows);
      closed = true;
    },
    discard() {
      closed = true;
    },
  };
}

export type RenderSourceChanges = ReturnType<typeof readRenderSourceChanges>;

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
    else source.entities.set(index, row);
  }
}
