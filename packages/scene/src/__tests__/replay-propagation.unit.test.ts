import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '../index';

function spawn(world: World, x: number, parent?: EntityHandle): EntityHandle {
  const transform = { component: Transform, data: { pos: [x, 0, 0] } };
  if (parent === undefined) return world.spawn(transform).unwrap();
  return world.spawn(transform, { component: ChildOf, data: { parent } }).unwrap();
}

function move(world: World, entity: EntityHandle, x: number): void {
  world.set(entity, Transform, { pos: [x, 0, 0] }).unwrap();
}

function worldX(world: World, entity: EntityHandle): number {
  return world.get(entity, GlobalTransform).unwrap().world[12] as number;
}

/** Two roots with a chain of three below each; every row moves each round. */
function build(): { world: World; rows: EntityHandle[]; roots: EntityHandle[] } {
  const world = new World();
  const rows: EntityHandle[] = [];
  const roots: EntityHandle[] = [];
  for (let tree = 0; tree < 2; tree++) {
    let parent: EntityHandle | undefined;
    for (let depth = 0; depth < 4; depth++) {
      const entity = spawn(world, 1, parent);
      if (depth === 0) roots.push(entity);
      rows.push(entity);
      parent = entity;
    }
  }
  propagateTransforms(world).unwrap();
  return { world, rows, roots };
}

function moveAll(world: World, rows: readonly EntityHandle[], x: number): void {
  for (const entity of rows) move(world, entity, x);
  propagateTransforms(world).unwrap();
}

describe('replayed dense propagation', () => {
  it('keeps deriving every row across repeated all-changed runs', () => {
    const { world, rows } = build();
    for (let round = 2; round < 6; round++) {
      moveAll(world, rows, round);
      expect(worldX(world, rows[3] as EntityHandle)).toBe(round * 4);
      expect(worldX(world, rows[7] as EntityHandle)).toBe(round * 4);
    }
  });

  it('follows a reparent made after the order was recorded', () => {
    const { world, rows, roots } = build();
    for (let round = 2; round < 5; round++) moveAll(world, rows, round);
    world.set(rows[5] as EntityHandle, ChildOf, { parent: rows[1] as EntityHandle }).unwrap();
    propagateTransforms(world).unwrap();
    moveAll(world, rows, 7);
    expect(worldX(world, rows[5] as EntityHandle)).toBe(7 * 3);
    expect(worldX(world, rows[7] as EntityHandle)).toBe(7 * 5);
    expect(worldX(world, roots[0] as EntityHandle)).toBe(7);
  });

  it('drops a despawned leaf and keeps the rest', () => {
    const { world, rows } = build();
    for (let round = 2; round < 5; round++) moveAll(world, rows, round);
    world.despawn(rows[3] as EntityHandle);
    const alive = rows.filter((entity) => entity !== rows[3]);
    moveAll(world, alive, 9);
    expect(worldX(world, rows[2] as EntityHandle)).toBe(9 * 3);
    expect(worldX(world, rows[7] as EntityHandle)).toBe(9 * 4);
  });

  it('includes a child spawned after the order was recorded', () => {
    const { world, rows } = build();
    for (let round = 2; round < 5; round++) moveAll(world, rows, round);
    const added = spawn(world, 1, rows[3] as EntityHandle);
    propagateTransforms(world).unwrap();
    moveAll(world, [...rows, added], 8);
    expect(worldX(world, added)).toBe(8 * 5);
  });

  it('leaves unchanged rows alone when only some move after replaying', () => {
    const { world, rows } = build();
    for (let round = 2; round < 5; round++) moveAll(world, rows, round);
    move(world, rows[6] as EntityHandle, 100);
    propagateTransforms(world).unwrap();
    expect(worldX(world, rows[6] as EntityHandle)).toBe(4 + 4 + 100);
    expect(worldX(world, rows[2] as EntityHandle)).toBe(4 * 3);
  });
});
