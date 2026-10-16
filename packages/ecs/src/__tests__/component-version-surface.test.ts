import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { Query } from '../query/query';
import { World } from '../world';

const Value = defineComponent('ComponentVersionSurfaceValue', { value: 'f32' });

function changedEntities(query: Query): number[] {
  const entities: number[] = [];
  for (const span of query.spans().unwrap()) entities.push(...span.entities);
  return entities;
}

describe('component version surface', () => {
  it('keeps value observation independent of structure versions', () => {
    const world = new World();
    const query = world.query({ changed: [Value] }).unwrap();
    const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();

    expect(changedEntities(query)).toEqual([entity]);
    world.set(entity, Value, { value: 2 }).unwrap();
    expect(changedEntities(query)).toEqual([entity]);
    expect(changedEntities(query)).toEqual([]);
  });

  it('lets independent consumers observe the same component version', () => {
    const world = new World();
    const entity = world.spawn({ component: Value, data: { value: 2 } }).unwrap();
    const first = world.query({ changed: [Value] }).unwrap();
    const second = world.query({ changed: [Value] }).unwrap();
    changedEntities(first);
    changedEntities(second);

    world.set(entity, Value, { value: 3 }).unwrap();

    expect(changedEntities(first)).toEqual([entity]);
    expect(changedEntities(second)).toEqual([entity]);
  });
});
