import { expect, test } from 'vitest';
import { componentId, defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { createStateProjection } from '../projection/state-projection';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Position = defineComponent('ProjectionPosition', { x: 'f32' });
const Extra = defineComponent('ProjectionExtra', {});
const Selected = defineComponent('ProjectionSelected', {}, { storage: 'sparse' });

test('value-only acceptance preserves known membership without re-reading archetypes', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  world.set(entity, Position, { x: 2 }).unwrap();
  const owner = world[worldInternal];
  const getGraph = owner.getGraph;
  Object.defineProperty(owner, 'getGraph', {
    configurable: true,
    value: () => {
      throw new Error('value-only acceptance rediscovered membership');
    },
  });
  try {
    const batch = projection.read();
    expect(batch.indices).toEqual([entityIndex(entity)]);
    batch.accept();
    expect(projection.read().indices).toEqual([]);
  } finally {
    Object.defineProperty(owner, 'getGraph', { configurable: true, value: getGraph });
  }
});

test.each([
  32, 511, 512, 700,
])('structural changes retain same-frame writes without forwarding unchanged block neighbors (%i rows)', (count) => {
  const world = new World();
  const entities = Array.from({ length: count }, (_, x) =>
    world.spawn({ component: Position, data: { x } }).unwrap(),
  );
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  const first = entities[0] as EntityHandle;
  const changed = entities[1] as EntityHandle;
  const appended = world.spawn({ component: Position, data: { x: count } }).unwrap();
  world.set(changed, Position, { x: -1 }).unwrap();
  expect(new Set(projection.read().indices)).toEqual(
    new Set([entityIndex(appended), entityIndex(changed)]),
  );
  projection.read().accept();
  world.despawn(appended).unwrap();
  expect(projection.read().indices).toEqual([entityIndex(appended)]);
  projection.read().accept();

  world.addComponent(first, { component: Extra, data: {} }).unwrap();
  expect(new Set(projection.read().indices)).toEqual(new Set([entityIndex(first)]));
  projection.read().accept();
  world.removeComponent(first, Extra).unwrap();
  expect(projection.read().indices).toEqual([entityIndex(first)]);
  projection.read().accept();
  expect(projection.read().indices).toEqual([]);
});

test('candidate-only generation replacement is discovered when the row index stays the same', () => {
  const world = new World();
  const previous = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [], [Position]);
  projection.read().accept();
  world.despawn(previous).unwrap();
  const current = world.spawn({ component: Position, data: { x: 2 } }).unwrap();
  expect(entityIndex(current)).toBe(entityIndex(previous));
  expect(current).not.toBe(previous);
  const batch = projection.read();
  expect(batch.indices).toEqual([entityIndex(current)]);
  expect(projection.entity(entityIndex(current))).toBe(current);
  batch.accept();
  expect(projection.read().indices).toEqual([]);
});

test('tracked sparse membership remains visible with table-only candidate roots', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: {} }).unwrap();
  const projection = createStateProjection(world, [Selected], [Position]);
  projection.read().accept();
  world.addComponent(entity, { component: Selected, data: {} }).unwrap();
  expect(projection.read().indices).toEqual([entityIndex(entity)]);
  projection.read().accept();
  world.removeComponent(entity, Selected).unwrap();
  expect(projection.read().indices).toEqual([entityIndex(entity)]);
});

test('sparse scalar changes inspect one identity; failed candidates and consumers remain independent', () => {
  const world = new World();
  const entities = Array.from({ length: 1024 }, (_, x) =>
    world.spawn({ component: Position, data: { x } }).unwrap(),
  );
  const first = createStateProjection(world, [Position]);
  const second = createStateProjection(world, [Position]);
  first.read().accept();
  second.read().accept();
  expect(first.read().scannedRows).toBe(0);
  const changedEntity = entities[511];
  if (changedEntity === undefined) throw new Error('missing fixture entity');
  world.set(changedEntity, Position, { x: 9 }).unwrap();
  const failed = first.read();
  expect(failed.indices).toEqual([entityIndex(changedEntity)]);
  expect(failed.scannedRows).toBe(1);
  expect(failed.checkedBlocks).toBe(0);
  expect(failed.checkedIndexEntries).toBeLessThan(400);
  const retry = first.read();
  expect(retry.indices).toEqual([entityIndex(changedEntity)]);
  retry.accept();
  expect(first.read().indices).toEqual([]);
  expect(second.read().indices).toEqual([entityIndex(changedEntity)]);
  expect(() => failed.accept()).toThrow();
});

test('migration, swap removal, generation reuse, sparse membership and deletion use final state', () => {
  const world = new World();
  const a = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const b = world.spawn({ component: Position, data: { x: 2 } }).unwrap();
  const projection = createStateProjection(world, [Position, Selected]);
  projection.read().accept();
  world.addComponent(a, { component: Extra, data: {} }).unwrap();
  world.addComponent(a, { component: Selected, data: {} }).unwrap();
  world.despawn(b).unwrap();
  const replacement = world.spawn({ component: Position, data: { x: 3 } }).unwrap();
  const batch = projection.read();
  expect(new Set(batch.indices)).toEqual(new Set([entityIndex(a), entityIndex(b)]));
  expect(projection.entity(entityIndex(b))).toBe(replacement);
  batch.accept();
  world.removeComponent(a, Selected).unwrap();
  expect(projection.read().indices).toContain(entityIndex(a));
  projection.read().accept();
  world.despawn(a).unwrap();
  world.despawn(replacement).unwrap();
  const removed = projection.read();
  expect(new Set(removed.indices)).toEqual(new Set([entityIndex(a), entityIndex(b)]));
  removed.accept();
  expect(projection.read().indices).toEqual([]);
});

test('range writes publish their block summaries and invalidation preserves deletion evidence', () => {
  const world = new World();
  const entities = Array.from({ length: 600 }, () =>
    world.spawn({ component: Position, data: {} }).unwrap(),
  );
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  for (const span of world
    .query({ write: [Position] })
    .unwrap()
    .spans()
    .unwrap())
    span.mut(Position).x.fill(4);
  expect(projection.read().indices).toHaveLength(600);
  projection.read().accept();
  const removedEntity = entities[0];
  if (removedEntity === undefined) throw new Error('missing fixture entity');
  world.despawn(removedEntity).unwrap();
  projection.invalidate();
  expect(projection.read().indices).toContain(entityIndex(removedEntity));
});

test.each(
  [1, 17, 731, 65537].flatMap((seed) => [
    { seed, membership: Extra },
    { seed, membership: Selected },
  ]),
)('matches an independent current-state oracle across skipped publications ($seed, $membership.name)', ({
  seed,
  membership,
}) => {
  let random = seed;
  const next = (limit: number) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % limit;
  };
  const world = new World();
  const projection = createStateProjection(world, [Position, membership]);
  const live: EntityHandle[] = [];
  const accepted = new Map<number, { entity: number; x: number; selected: boolean }>();
  for (let step = 0; step < 800; step++) {
    const entity = live[next(Math.max(1, live.length))];
    const operation = next(6);
    if (entity === undefined || operation === 0)
      live.push(world.spawn({ component: Position, data: { x: next(100) } }).unwrap());
    else if (operation === 1) world.set(entity, Position, { x: next(100) }).unwrap();
    else if (operation === 2) {
      world.despawn(entity).unwrap();
      live.splice(live.indexOf(entity), 1);
    } else {
      const component = operation === 3 ? Extra : Selected;
      if (world.hasComponent(entity, component)) world.removeComponent(entity, component).unwrap();
      else world.addComponent(entity, { component, data: {} }).unwrap();
    }
    if (step % 7 !== 0) continue;
    if (step % 31 === 0) projection.invalidate();
    const candidate = projection.read();
    if (step % 11 === 0) continue;
    for (const index of candidate.indices) {
      const current = projection.entity(index);
      const position = current === undefined ? undefined : world.get(current, Position);
      if (current === undefined || !position?.ok) accepted.delete(index);
      else
        accepted.set(index, {
          entity: current,
          x: position.value.x,
          selected: world.hasComponent(current, membership),
        });
    }
    candidate.accept();
    const oracle = new Map<number, { entity: number; x: number; selected: boolean }>();
    for (const row of world.query({ read: [Position] }).unwrap()) {
      oracle.set(entityIndex(row.entity), {
        entity: row.entity,
        x: row.get(Position).x,
        selected: world.hasComponent(row.entity, membership),
      });
    }
    expect(accepted).toEqual(oracle);
  }
});

test('invalidating an outstanding candidate prevents acceptance and retains the baseline', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  const stale = projection.read();
  projection.invalidate();
  expect(() => stale.accept()).toThrow();
  expect(projection.read().indices).toEqual([entityIndex(entity)]);
});

test('source writes during candidate construction cannot be accepted', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  const stale = projection.read();
  world.set(entity, Position, { x: 2 }).unwrap();
  expect(() => stale.validate()).toThrow();
  expect(() => stale.accept()).toThrow();
  const current = projection.read();
  expect(current.indices).toEqual([entityIndex(entity)]);
  current.accept();
  expect(projection.read().indices).toEqual([]);
});

test('a local write never enumerates the clean table directory', () => {
  const world = new World();
  const entities = Array.from({ length: 4096 }, () =>
    world.spawn({ component: Position, data: {} }).unwrap(),
  );
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  const directory = world[worldInternal]
    .getGraph()
    .activeTablesByComponent.get(componentId(Position));
  if (directory === undefined) throw new Error('missing table directory');
  Object.defineProperty(directory, Symbol.iterator, {
    configurable: true,
    value() {
      throw new Error('clean table directory visited');
    },
  });
  world.set(entities[2000] as EntityHandle, Position, { x: 1 }).unwrap();
  const candidate = projection.read();
  expect(candidate.indices).toEqual([entityIndex(entities[2000] as EntityHandle)]);
  expect(candidate.checkedBlocks).toBe(0);
  candidate.accept();
});

test('changed span reads do not consult clean block summaries', () => {
  const world = new World();
  const entities = Array.from({ length: 1024 }, () =>
    world.spawn({ component: Position, data: {} }).unwrap(),
  );
  const query = world.query({ read: [Position], changed: [Position] }).unwrap();
  for (const _span of query.spans().unwrap()) {
    /* establish the cursor */
  }
  const entity = entities[511] as EntityHandle;
  world.set(entity, Position, { x: 3 }).unwrap();
  const graph = world[worldInternal].getGraph();
  const archetype = world[worldInternal].getEntityArchetype(entity);
  const storage = graph.tables[archetype?.tableId ?? -1]?.storage.get(componentId(Position));
  if (storage === undefined) throw new Error('missing fixture storage');
  Object.defineProperty(storage, 'epochs', {
    get() {
      throw new Error('obsolete row change evidence visited');
    },
  });
  const found: number[] = [];
  for (const span of query.spans().unwrap())
    for (const current of span.entities) found.push(current);
  expect(found).toEqual([entity]);
});

test('distinguishes structural identities from value-only rows in one borrowed candidate', () => {
  const world = new World();
  const changed = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const removed = world
    .spawn({ component: Position, data: { x: 2 } }, { component: Extra, data: {} })
    .unwrap();
  const projection = createStateProjection(world, [Position, Extra]);
  const baseline = projection.read();
  expect(baseline.hasStructuralChange(entityIndex(changed))).toBe(true);
  baseline.accept();
  expect(() => baseline.hasStructuralChange(entityIndex(changed))).toThrow();
  world.set(changed, Position, { x: 3 }).unwrap();
  world.removeComponent(removed, Extra).unwrap();
  const candidate = projection.read();
  expect(candidate.hasStructuralChange(entityIndex(changed))).toBe(false);
  expect(candidate.hasStructuralChange(entityIndex(removed))).toBe(true);
  expect(projection.changed(removed, Extra)).toBe(false); // Removal has no live component tick.
  const retry = projection.read();
  expect(() => candidate.hasStructuralChange(entityIndex(removed))).toThrow();
  expect(retry.hasStructuralChange(entityIndex(removed))).toBe(true);
  retry.accept();
  const empty = projection.read();
  expect(empty.indices).toEqual([]);
  expect(empty.hasStructuralChange(entityIndex(removed))).toBe(false);
});
