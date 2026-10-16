// M1 test — collectSubtree shared visited de-duplication (AC-03, AC-16).
//
// Verifies the extracted collectSubtree shared util:
//   (a) single root with 3-tier descendants — visited.size equals total closure
//   (b) roots=[A, A_child] with shared external visited — no error, no duplicates
//   (c) no visited argument — util creates its own Set internally
//
// TDD phase "red": collect-subtree.ts does not exist yet.

import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, collectSubtree, Name } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

// Build a chain of N entities linked by Children.
// Returns the array of entity raw IDs from root down.
function buildChain(world: World, depth: number): number[] {
  const ids: number[] = [];
  let parent: EntityHandle | undefined;
  for (let i = 0; i < depth; i++) {
    const res =
      parent === undefined
        ? world.spawn({ component: Name, data: { value: `e${i}` } })
        : world.spawn(
            { component: Name, data: { value: `e${i}` } },
            { component: ChildOf, data: { parent } },
          );
    if (!res.ok) throw new Error(`spawn failed: ${i}`);
    ids.push(res.value as number);
    parent = res.value;
  }
  return ids;
}

describe('collectSubtree — AC-03 shared visited', () => {
  it('single root with 3-tier descendants yields visited.size = total closure', () => {
    const world = new World();
    const chain = buildChain(world, 4); // 4 entities: e0 -> e1 -> e2 -> e3
    const visited = collectSubtree(world, chain[0] as EntityHandle);
    expect(visited.size).toBe(4);
    expect(visited.has(chain[0] as number)).toBe(true);
    expect(visited.has(chain[1] as number)).toBe(true);
    expect(visited.has(chain[2] as number)).toBe(true);
    expect(visited.has(chain[3] as number)).toBe(true);
  });

  it('roots=[A, A_child] with shared visited — no error and no duplicates', () => {
    const world = new World();
    const chain = buildChain(world, 4); // e0 -> e1 -> e2 -> e3
    const sharedVisited = new Set<number>();
    const visited1 = collectSubtree(world, chain[0] as EntityHandle, sharedVisited);
    const visited2 = collectSubtree(world, chain[1] as EntityHandle, sharedVisited);
    // Both calls use the same sharedVisited; no duplicates
    expect(sharedVisited.size).toBe(4);
    expect(visited1).toBe(sharedVisited);
    expect(visited2).toBe(sharedVisited);
  });

  it('no visited argument — creates a new Set internally', () => {
    const world = new World();
    const chain = buildChain(world, 3);
    const visited = collectSubtree(world, chain[0] as EntityHandle);
    expect(visited).toBeInstanceOf(Set);
    expect(visited.size).toBe(3);
  });

  it('leaf entity (no Children) returns set containing only itself', () => {
    const world = new World();
    const res = world.spawn({ component: Name, data: { value: 'leaf' } });
    expect(res.ok).toBe(true);
    const e = res.ok ? res.value : 0;
    const visited = collectSubtree(world, e as EntityHandle);
    expect(visited.size).toBe(1);
    expect(visited.has(e as number)).toBe(true);
  });
});
