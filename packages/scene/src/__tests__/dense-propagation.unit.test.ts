import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '../index';

interface Tree {
  readonly world: World;
  readonly root: EntityHandle;
  readonly mids: readonly EntityHandle[];
  readonly leaves: readonly EntityHandle[];
}

function spawn(world: World, x: number, parent?: EntityHandle): EntityHandle {
  const transform = { component: Transform, data: { pos: [x, 0, 0] } };
  if (parent === undefined) return world.spawn(transform).unwrap();
  return world.spawn(transform, { component: ChildOf, data: { parent } }).unwrap();
}

/** One root, three children, one grandchild under each child. */
function buildTree(): Tree {
  const world = new World();
  const root = spawn(world, 1);
  const mids = [2, 3, 4].map((x) => spawn(world, x, root));
  const leaves = mids.map((mid, index) => spawn(world, 10 * (index + 1), mid));
  propagateTransforms(world).unwrap();
  return { world, root, mids, leaves };
}

function move(world: World, entity: EntityHandle, x: number): void {
  world.set(entity, Transform, { pos: [x, 0, 0] }).unwrap();
}

function worldX(world: World, entity: EntityHandle): number {
  return world.get(entity, GlobalTransform).unwrap().world[12] as number;
}

describe('dense propagation', () => {
  it('re-derives every row when most of the hierarchy changed', () => {
    const { world, root, mids, leaves } = buildTree();
    move(world, root, 5);
    for (const [index, mid] of mids.entries()) move(world, mid, 6 + index);
    for (const [index, leaf] of leaves.entries()) move(world, leaf, 100 * (index + 1));

    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, root)).toBe(5);
    for (const [index, mid] of mids.entries()) {
      expect(worldX(world, mid)).toBe(5 + 6 + index);
    }
    for (const [index, leaf] of leaves.entries()) {
      expect(worldX(world, leaf)).toBe(5 + 6 + index + 100 * (index + 1));
    }
  });

  it('reaches changed descendants under a root that did not change', () => {
    const { world, root, mids, leaves } = buildTree();
    for (const [index, mid] of mids.entries()) {
      move(world, mid, 7 + index);
    }
    for (const [index, leaf] of leaves.entries()) {
      move(world, leaf, 50 + index);
    }

    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, root)).toBe(1);
    for (const [index, mid] of mids.entries()) {
      expect(worldX(world, mid)).toBe(1 + 7 + index);
    }
    for (const [index, leaf] of leaves.entries()) {
      expect(worldX(world, leaf)).toBe(1 + 7 + index + 50 + index);
    }
  });

  it('keeps an untouched branch correct while the rest is rewritten', () => {
    const { world, root, mids, leaves } = buildTree();
    move(world, mids[0] as EntityHandle, 20);
    move(world, mids[1] as EntityHandle, 30);
    move(world, leaves[0] as EntityHandle, 40);
    move(world, leaves[1] as EntityHandle, 50);

    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, root)).toBe(1);
    expect(worldX(world, mids[0] as EntityHandle)).toBe(21);
    expect(worldX(world, mids[1] as EntityHandle)).toBe(31);
    expect(worldX(world, mids[2] as EntityHandle)).toBe(5);
    expect(worldX(world, leaves[0] as EntityHandle)).toBe(61);
    expect(worldX(world, leaves[1] as EntityHandle)).toBe(81);
    expect(worldX(world, leaves[2] as EntityHandle)).toBe(35);
  });

  it('stays correct when a sparse run follows a dense one', () => {
    const { world, root, mids, leaves } = buildTree();
    for (const entity of [root, ...mids, ...leaves]) move(world, entity, 2);
    expect(propagateTransforms(world).ok).toBe(true);

    move(world, leaves[2] as EntityHandle, 9);
    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, leaves[2] as EntityHandle)).toBe(2 + 2 + 9);
    expect(worldX(world, leaves[0] as EntityHandle)).toBe(6);
  });

  it('falls back to the walk when the shape changed in the same run', () => {
    const { world, root, mids, leaves } = buildTree();
    world.set(leaves[0] as EntityHandle, ChildOf, { parent: root }).unwrap();
    for (const entity of [root, ...mids, ...leaves]) move(world, entity, 3);

    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, leaves[0] as EntityHandle)).toBe(3 + 3);
    expect(worldX(world, leaves[1] as EntityHandle)).toBe(3 + 3 + 3);
  });

  it('falls back to the walk when a parent was despawned in the same run', () => {
    const { world, root, mids, leaves } = buildTree();
    world.despawn(mids[2] as EntityHandle).unwrap();
    for (const entity of [root, mids[0], mids[1], leaves[0], leaves[1]] as EntityHandle[])
      move(world, entity, 4);

    expect(propagateTransforms(world).ok).toBe(true);

    expect(worldX(world, leaves[0] as EntityHandle)).toBe(4 + 4 + 4);
    expect(worldX(world, leaves[1] as EntityHandle)).toBe(4 + 4 + 4);
  });
});
