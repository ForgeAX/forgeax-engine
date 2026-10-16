import { type Query, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '../index';

function changedEntities(query: Query): number[] {
  const entities: number[] = [];
  for (const span of query.spans().unwrap()) entities.push(...span.entities);
  return entities;
}

describe('transform component versions', () => {
  it('observes a large derived publication without rebuilding on the next pass', () => {
    const world = new World();
    for (let index = 0; index <= 65_536; index += 1) {
      world.spawn({ component: Transform, data: {} }).unwrap();
    }

    const first = propagateTransforms(world);
    const second = propagateTransforms(world);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('publishes exactly the recomputed subtree and stays empty on no-change propagation', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const grandchild = world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        { component: ChildOf, data: { parent: child } },
      )
      .unwrap();
    const sibling = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();

    propagateTransforms(world).unwrap();
    const changes = world.query({ changed: [GlobalTransform] }).unwrap();
    changedEntities(changes);
    propagateTransforms(world).unwrap();
    expect(changedEntities(changes)).toEqual([]);

    world.set(child, Transform, { pos: [8, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    const changed = changedEntities(changes);
    expect(changed.sort((left, right) => left - right)).toEqual(
      [child, grandchild].sort((left, right) => left - right),
    );
    expect(changed).not.toContain(sibling);
  });

  it('does not propagate again from derived Transform records', () => {
    const world = new World();
    world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();

    propagateTransforms(world).unwrap();
    const changes = world.query({ changed: [GlobalTransform] }).unwrap();
    changedEntities(changes);

    propagateTransforms(world).unwrap();

    expect(changedEntities(changes)).toEqual([]);
  });

  it('uses the final authored Transform state and publishes mutation evidence', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();

    propagateTransforms(world).unwrap();
    const changes = world.query({ changed: [GlobalTransform] }).unwrap();
    changedEntities(changes);

    world.set(root, Transform, { pos: [5, 0, 0] }).unwrap();
    world.set(root, Transform, { pos: [1, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    expect(changedEntities(changes)).toEqual([root]);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);

    world.set(root, Transform, { pos: [5, 0, 0] }).unwrap();
    world.set(root, Transform, { pos: [7, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    expect(changedEntities(changes).sort((left, right) => left - right)).toEqual(
      [root, child].sort((left, right) => left - right),
    );
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(9);
  });
});
