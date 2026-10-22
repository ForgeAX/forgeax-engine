import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { Visibility, VisibilityStateValue } from '../components';
import {
  acceptRenderSourceEntities,
  captureRenderSourceEntities,
  createRenderSourceState,
  renderSourceHierarchyChanged,
} from '../scene/render-source';

function fixture() {
  const world = new World();
  const parent = world.spawn({ component: Transform, data: {} }).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();
  const source = createRenderSourceState(world);
  const index = source.batch.indices.find((index) => source.projection.entity(index) === entity);
  if (index === undefined) throw new Error('Missing source identity');
  source.batch.accept();
  return {
    world,
    parent,
    entity,
    source,
    index,
    read() {
      const batch = source.projection.read(),
        rows = captureRenderSourceEntities(world, source, batch);
      return {
        batch,
        rows,
        changed() {
          const row = rows[batch.indices.indexOf(index)];
          return row !== undefined && renderSourceHierarchyChanged(source, index, row);
        },
        accept() {
          batch.accept();
          acceptRenderSourceEntities(source, batch.indices, rows);
        },
      };
    },
  };
}

it('keeps removed hierarchy presence at the accepted boundary until a successful retry', () => {
  const f = fixture(),
    original = f.source.entities.get(f.index);
  f.world.removeComponent(f.entity, Visibility).unwrap();
  const discarded = f.read();
  expect(discarded.changed()).toBe(true);
  expect(f.source.entities.get(f.index)).toBe(original);
  const retry = f.read();
  expect(retry.changed()).toBe(true);
  retry.accept();
  expect(f.source.entities.get(f.index)?.hierarchyPresence).toBe(1);
  expect(f.read().batch.indices).toEqual([]);
});

it('observes remove and readd through the value epoch even when final presence is unchanged', () => {
  const f = fixture();
  f.world.removeComponent(f.entity, Visibility).unwrap();
  f.world
    .addComponent(f.entity, {
      component: Visibility,
      data: { state: VisibilityStateValue.visible },
    })
    .unwrap();
  const candidate = f.read();
  expect(candidate.changed()).toBe(true);
  candidate.accept();
  f.world.removeComponent(f.entity, ChildOf).unwrap();
  const detached = f.read();
  expect(detached.changed()).toBe(true);
  detached.accept();
  expect(f.source.entities.get(f.index)?.hierarchyPresence).toBe(2);
});

it('captures exact generation identity and never samples a later World during acceptance', () => {
  const f = fixture(),
    index = f.index;
  f.world.despawn(f.entity).unwrap();
  const next = f.world.spawn({ component: Transform, data: {} }).unwrap();
  expect(f.source.projection.entity(index)).toBe(next);
  expect(next).not.toBe(f.entity);
  const batch = f.source.projection.read(),
    rows = captureRenderSourceEntities(f.world, f.source, batch);
  const row = rows[batch.indices.indexOf(index)];
  if (row === undefined) throw new Error('Missing replacement source');
  expect(row.entity).toBe(next);
  expect(renderSourceHierarchyChanged(f.source, index, row)).toBe(true);
  batch.accept();
  const has = f.world.hasComponent;
  f.world.hasComponent = () => {
    throw new Error('late World read');
  };
  try {
    acceptRenderSourceEntities(f.source, batch.indices, rows);
  } finally {
    f.world.hasComponent = has;
  }
  expect(f.source.entities.get(index)).toBe(row);
});
