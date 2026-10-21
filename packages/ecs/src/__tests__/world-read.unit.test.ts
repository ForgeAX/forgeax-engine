import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { defineRelationship } from '../relationship-index';
import { World } from '../world';
import { worldRead } from '../world-read';

const relationship = defineRelationship({
  sourceName: 'WorldReadSource',
  sourceField: 'target',
  targetName: 'WorldReadTargets',
  targetField: 'sources',
});

describe('World semantic read seam', () => {
  it('reads the existing relationship epoch independently of unrelated entities', () => {
    const world = new World();
    const read = world[worldRead];
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const source = world
      .spawn({ component: relationship.source, data: { target: first } })
      .unwrap();
    const initial = read.getRelationshipEpoch(relationship.source);
    const unrelated = world.spawn().unwrap();
    world.despawn(unrelated).unwrap();
    expect(read.getRelationshipEpoch(relationship.source)).toBe(initial);
    world.set(source, relationship.source, { target: second }).unwrap();
    expect(read.getRelationshipEpoch(relationship.source)).toBeGreaterThan(initial);
    const reparented = read.getRelationshipEpoch(relationship.source);
    world.despawn(source).unwrap();
    expect(read.getRelationshipEpoch(relationship.source)).toBeGreaterThan(reparented);
  });

  it('checks a known relationship edge after mirror swap, reparent and identity reuse', () => {
    const world = new World();
    const read = world[worldRead];
    const target = world.spawn().unwrap();
    const other = world.spawn().unwrap();
    const first = world.spawn({ component: relationship.source, data: { target } }).unwrap();
    const last = world.spawn({ component: relationship.source, data: { target } }).unwrap();
    expect(read.hasRelationshipEdge(relationship.source, last, target)).toBe(true);
    expect(read.hasRelationshipEdge(relationship.target, last, target)).toBe(false);
    world.despawn(first).unwrap();
    expect(read.hasRelationshipEdge(relationship.source, first, target)).toBe(false);
    expect(read.hasRelationshipEdge(relationship.source, last, target)).toBe(true);
    world.set(last, relationship.source, { target: other }).unwrap();
    expect(read.hasRelationshipEdge(relationship.source, last, target)).toBe(false);
    expect(read.hasRelationshipEdge(relationship.source, last, other)).toBe(true);
    world.despawn(last).unwrap();
    const replacement = world
      .spawn({ component: relationship.source, data: { target: other } })
      .unwrap();
    expect(read.hasRelationshipEdge(relationship.source, last, other)).toBe(false);
    expect(read.hasRelationshipEdge(relationship.source, replacement, other)).toBe(true);
  });

  it('reads relationship facts without exposing a storage view', () => {
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: relationship.source, data: { target } }).unwrap();

    expect(world[worldRead].getFieldValue(source, relationship.source, 'target')).toBe(
      target as number,
    );
    expect(world[worldRead].getArrayLength(target, relationship.target, 'sources')).toBe(1);
    expect(world[worldRead].getArrayElement(target, relationship.target, 'sources', 0)).toBe(
      source as number,
    );
    expect(world[worldRead].getArrayElement(target, relationship.target, 'sources', 1)).toBe(
      undefined,
    );
  });
  it('keeps stale and recycled identities absent in every semantic read', () => {
    const values = defineComponent('WorldReadGenerationValues', {
      scalar: 'f32',
      fixed: { type: 'array<f32, 4>' },
    });
    const world = new World();
    const first = world
      .spawn({ component: values, data: { scalar: 7, fixed: [1, 2, 3, 4] } })
      .unwrap();
    world.despawn(first).unwrap();
    const recycled = world
      .spawn({ component: values, data: { scalar: 31, fixed: [5, 6, 7, 8] } })
      .unwrap();
    expect(recycled).not.toBe(first);
    const read = world[worldRead];
    expect(read.getFieldValue(first, values, 'scalar')).toBeUndefined();
    expect(read.getArrayLength(first, values, 'fixed')).toBeUndefined();
    expect(read.getArrayElement(first, values, 'fixed', 0)).toBeUndefined();
    expect(read.getFieldValue(recycled, values, 'scalar')).toBe(31);
    expect(read.getArrayLength(recycled, values, 'fixed')).toBe(4);
    expect(read.getArrayElement(recycled, values, 'fixed', 0)).toBe(5);
  });

  it('reads fixed and dynamic arrays without changing missing or bounds semantics', () => {
    const values = defineComponent('WorldReadArrayValues', {
      scalar: 'f32',
      fixed: { type: 'array<f32, 4>' },
      dynamic: { type: 'array<f32>' },
    });
    const missing = defineComponent('WorldReadMissingValues', { scalar: 'f32' });
    const world = new World();
    const entity = world
      .spawn({ component: values, data: { scalar: 7, fixed: [1, 2, 3, 4], dynamic: [5, 6, 7] } })
      .unwrap();
    const read = world[worldRead];
    expect(read.getArrayLength(entity, values, 'dynamic')).toBe(3);
    expect(read.getArrayElement(entity, values, 'dynamic', 2)).toBe(7);
    world.setArrayRange(entity, values, 'dynamic', 1, [9]).unwrap();
    expect(read.getArrayElement(entity, values, 'dynamic', 1)).toBe(9);
    expect(read.getFieldValue(entity, missing, 'scalar')).toBeUndefined();
    expect(read.getArrayLength(entity, missing, 'fixed')).toBeUndefined();
    expect(read.getArrayElement(entity, missing, 'fixed', 0)).toBeUndefined();
    expect(read.getArrayLength(entity, values, 'missing')).toBeUndefined();
    expect(read.getArrayElement(entity, values, 'missing', 0)).toBeUndefined();
    for (const index of [-1, 0.5, 4, Infinity, NaN])
      expect(read.getArrayElement(entity, values, 'fixed', index)).toBeUndefined();
    world.set(entity, values, { dynamic: [] }).unwrap();
    expect(read.getArrayLength(entity, values, 'dynamic')).toBe(0);
    expect(read.getArrayElement(entity, values, 'dynamic', 0)).toBeUndefined();
  });

  it('keeps live array counts after table growth, migration and swap removal', () => {
    const values = defineComponent('WorldReadGrowingArrays', {
      dynamic: { type: 'array<f32>' },
    });
    const marker = defineComponent('WorldReadMigrationMarker', {});
    const world = new World();
    const entities = Array.from({ length: 140 }, (_, index) =>
      world.spawn({ component: values, data: { dynamic: [index, index + 1] } }).unwrap(),
    );
    const read = world[worldRead];
    for (const entity of entities)
      world.addComponent(entity, { component: marker, data: {} }).unwrap();
    const removed = entities[0];
    const last = entities.at(-1);
    if (removed === undefined || last === undefined) throw Error('expected grown table');
    world.despawn(removed).unwrap();
    expect(read.getArrayLength(removed, values, 'dynamic')).toBeUndefined();
    expect(read.getArrayLength(last, values, 'dynamic')).toBe(2);
    expect(read.getArrayElement(last, values, 'dynamic', 1)).toBe(140);
    world.set(last, values, { dynamic: [7, 8, 9] }).unwrap();
    world.removeComponent(last, marker).unwrap();
    expect(read.getArrayLength(last, values, 'dynamic')).toBe(3);
    expect(read.getArrayElement(last, values, 'dynamic', 2)).toBe(9);
    world.set(last, values, { dynamic: [] }).unwrap();
    expect(read.getArrayLength(last, values, 'dynamic')).toBe(0);
    expect(read.getArrayElement(last, values, 'dynamic', 0)).toBeUndefined();
  });
});
