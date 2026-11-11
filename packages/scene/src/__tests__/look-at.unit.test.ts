import { type Query, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { setTransformLookAt, Transform } from '../index';

function changedEntities(query: Query): number[] {
  const entities: number[] = [];
  for (const span of query.spans().unwrap()) entities.push(...span.entities);
  return entities;
}

describe('setTransformLookAt', () => {
  it('aims -Z at the target and publishes only when the pose moves', () => {
    const world = new World();
    const camera = world.spawn({ component: Transform, data: {} }).unwrap();
    const changes = world.query({ changed: [Transform] }).unwrap();
    changedEntities(changes);

    expect(setTransformLookAt(world, camera, [0, 2, 5], [0, 2, 0]).unwrap()).toBe(true);
    const { pos, quat } = world.get(camera, Transform).unwrap();
    expect(Array.from(pos)).toEqual([0, 2, 5]);
    expect(Array.from(quat).map((v) => (Math.abs(v) < 1e-6 ? 0 : v))).toEqual([0, 0, 0, 1]);
    expect(changedEntities(changes)).toEqual([camera]);

    expect(setTransformLookAt(world, camera, [0, 2, 5], [0, 2, 0]).unwrap()).toBe(false);
    expect(changedEntities(changes)).toEqual([]);

    expect(setTransformLookAt(world, camera, [0, 2, 6], [0, 2, 0]).unwrap()).toBe(true);
    expect(changedEntities(changes)).toEqual([camera]);
  });

  it('returns the ECS error for an entity without Transform', () => {
    const world = new World();
    const bare = world.spawn().unwrap();
    expect(setTransformLookAt(world, bare, [0, 0, 1], [0, 0, 0]).ok).toBe(false);
  });
});
