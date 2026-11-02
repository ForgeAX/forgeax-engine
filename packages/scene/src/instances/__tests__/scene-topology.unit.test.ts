import { World } from '@forgeax/engine-ecs';
import type { LocalEntityId } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { CompiledSceneEntity } from '../keyed';
import { sceneTopoSort } from '../scene-topology';

function nodes(count: number): CompiledSceneEntity[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        localId: i as LocalEntityId,
        components: i === count - 1 ? {} : { ChildOf: { parent: i + 1 } },
      }) as CompiledSceneEntity,
  );
}
describe('Scene topology arena consumer', () => {
  it('orders a reverse-authored hierarchy and reuses scratch without retaining it in output', () => {
    const world = new World();
    const input = nodes(2048);
    const first = sceneTopoSort(world, input);
    expect(first).toEqual(Array.from({ length: 2048 }, (_, i) => 2047 - i));
    const allocations = world.memoryStats().arena.backingAllocations;
    const next = sceneTopoSort(world, input);
    expect(next).toEqual(first);
    expect(next).not.toBe(first);
    expect(world.memoryStats().arena.backingAllocations).toBe(allocations);
    expect(world.frameArena.isActive).toBe(false);
    world.trimMemory().unwrap();
    expect(first[0]).toBe(2047);
  });
  it('keeps stable fallback order for a cycle and initializes reused visited markers', () => {
    const world = new World();
    const input = nodes(4);
    input[3] = { ...input[3], components: { ChildOf: { parent: 0 } } } as CompiledSceneEntity;
    expect(sceneTopoSort(world, input)).toEqual([0, 1, 2, 3]);
    expect(sceneTopoSort(world, nodes(4))).toEqual([3, 2, 1, 0]);
  });
});
