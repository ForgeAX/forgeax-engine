import { expect, test } from 'vitest';
import { componentId, defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { setDerivedComponent } from '../projection';
import { createStateProjection } from '../projection/state-projection';
import { defineRelationship } from '../relationship-index';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Value = defineComponent('ChangePublicationValue', { x: 'f32' });
const Selected = defineComponent('ChangePublicationSelected', {}, { storage: 'sparse' });
const ArrayValue = defineComponent('ChangePublicationArray', { values: { type: 'array<f32>' } });

test('removing the newest member of many leaves prunes cold survivors for independent consumers', () => {
  const world = new World();
  const entities = Array.from({ length: 2048 }, (_, x) =>
    world.spawn({ component: Value, data: { x } }, { component: Selected, data: {} }).unwrap(),
  );
  const projection = createStateProjection(world, [Value, Selected]);
  const slow = createStateProjection(world, [Value, Selected]);
  const changed = world.query({ read: [Value], changed: [Value] }).unwrap();
  const sparseChanged = world.query({ with: [Selected], changed: [Selected] }).unwrap();
  projection.read().accept();
  slow.read().accept();
  Array.from(changed);
  Array.from(sparseChanged);
  const hot = entities.filter((entity) => (entityIndex(entity) & 63) === 63);
  for (const entity of hot) {
    world.set(entity, Value, { x: -1 }).unwrap();
    world.set(entity, Selected, {}).unwrap();
  }
  for (const entity of hot) {
    world.removeComponent(entity, Value).unwrap();
    world.removeComponent(entity, Selected).unwrap();
  }
  expect(Array.from(changed)).toEqual([]);
  expect(Array.from(sparseChanged)).toEqual([]);
  const owner = world[worldInternal];
  for (const component of [Value, Selected])
    expect(owner.getComponentChangeIndex(componentId(component))?.checkedEntries).toBe(1);
  const expected = hot.map(entityIndex);
  expect(projection.read().indices).toEqual(expected);
  for (const component of [Value, Selected])
    expect(owner.getComponentChangeIndex(componentId(component))?.checkedEntries).toBe(1);
  projection.read().accept();
  expect(projection.read().indices).toEqual([]);
  expect(slow.read().indices).toEqual(expected);
  expect(slow.read().indices).toEqual(expected);
  slow.read().accept();
  expect(slow.read().indices).toEqual([]);
  const previous = hot[0] as EntityHandle;
  world.despawn(previous).unwrap();
  const replacement = world.spawn({ component: Value, data: { x: 3 } }).unwrap();
  expect(entityIndex(replacement)).toBe(entityIndex(previous));
  expect(owner.getComponentChange(previous, componentId(Value))).toBeUndefined();
  expect(owner.getComponentChange(replacement, componentId(Value))?.changed).toBe(
    owner.getMutationEpoch(),
  );
});

test.each([
  'set',
  'array',
] as const)('retires the World when %s cannot publish after changing payload', (operation) => {
  const world = new World();
  const entity = world
    .spawn(
      { component: Value, data: { x: 1 } },
      { component: ArrayValue, data: { values: [1, 2] } },
    )
    .unwrap();
  const projection = createStateProjection(world, [Value, ArrayValue]);
  projection.read().accept();
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  expect(() =>
    operation === 'set'
      ? world.set(entity, Value, { x: 2 })
      : world.setArrayRange(entity, ArrayValue, 'values', 0, [9]),
  ).toThrow();
  expect(world.execution.health).toBe('poisoned');
  expect(world.execution.fault?.partialWrite).toBe(true);
  expect(() => projection.read()).toThrow();
});

test('epoch exhaustion before a query mutable borrow leaves an unchanged healthy World', () => {
  const world = new World();
  const entity = world.spawn({ component: Value, data: { x: 1 } }).unwrap();
  const row = Array.from(world.query({ write: [Value] }).unwrap())[0];
  if (row === undefined) throw new Error('missing fixture row');
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  expect(() => row.mut(Value)).toThrow();
  expect(world.execution.health).toBe('healthy');
  expect(world.get(entity, Value).unwrap().x).toBe(1);
});

test.each([
  'set',
  'derived',
] as const)('epoch exhaustion of an empty sparse tag %s leaves its existing membership healthy', (operation) => {
  const world = new World();
  const entity = world.spawn({ component: Selected, data: {} }).unwrap();
  const before = world[worldInternal].getComponentChange(entity, componentId(Selected));
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  expect(() =>
    operation === 'set'
      ? world.set(entity, Selected, {})
      : setDerivedComponent(world, entity, Selected, {}),
  ).toThrow();
  expect(world.execution.health).toBe('healthy');
  expect(world.hasComponent(entity, Selected)).toBe(true);
  expect(world[worldInternal].getComponentChange(entity, componentId(Selected))).toEqual(before);
});

test.each([
  'add',
  'set',
] as const)('retires a %s whose first relationship mirror fails final publication', (operation) => {
  const pair = defineRelationship({
    sourceName: `EpochMirror${operation}`,
    sourceField: 'target',
    targetName: `EpochMirrorTargets${operation}`,
    targetField: 'sources',
  });
  const world = new World();
  const parent = world.spawn().unwrap();
  const child =
    operation === 'add'
      ? world.spawn().unwrap()
      : world.spawn({ component: pair.source, data: { target: null } }).unwrap();
  Object.defineProperty(world, 'mutationEpoch', {
    value: Number.MAX_SAFE_INTEGER - 1,
    writable: true,
  });
  expect(() =>
    operation === 'add'
      ? world.addComponent(child, { component: pair.source, data: { target: parent } })
      : world.set(child, pair.source, { target: parent }),
  ).toThrow();
  expect(world.execution.health).toBe('poisoned');
  expect(world.execution.fault?.partialWrite).toBe(true);
});

test('retires an owner-derived write whose final changed publication fails', () => {
  const world = new World();
  const entity = world.spawn({ component: Value, data: { x: 1 } }).unwrap();
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  expect(() => setDerivedComponent(world, entity, Value, { x: 2 })).toThrow();
  expect(world.execution.health).toBe('poisoned');
  expect(world.execution.fault?.partialWrite).toBe(true);
});

test.each([
  'add-dense',
  'add-sparse',
  'remove-dense',
  'remove-sparse',
] as const)('retires the World when %s cannot publish after changing membership', (operation) => {
  const world = new World();
  const entity = world
    .spawn({ component: Value, data: { x: 1 } }, { component: Selected, data: {} })
    .unwrap();
  if (operation === 'add-dense') world.removeComponent(entity, Value).unwrap();
  if (operation === 'add-sparse') world.removeComponent(entity, Selected).unwrap();
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  expect(() => {
    switch (operation) {
      case 'add-dense':
        return world.addComponent(entity, { component: Value, data: { x: 2 } });
      case 'add-sparse':
        return world.addComponent(entity, { component: Selected, data: {} });
      case 'remove-dense':
        return world.removeComponent(entity, Value);
      case 'remove-sparse':
        return world.removeComponent(entity, Selected);
    }
  }).toThrow();
  expect(world.execution.health).toBe('poisoned');
  expect(world.execution.fault?.partialWrite).toBe(true);
});
