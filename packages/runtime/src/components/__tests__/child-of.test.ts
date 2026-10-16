// AC-08: cascade-despawn — when ChildOf default linkedSpawn=true,
// world.despawn(parent) recursively despawns child entities that hold
// the default-constructed ChildOf (no explicit linkedSpawn override).
//
// The test uses the actual exported runtime ChildOf component (default
// linkedSpawn=true post flip) directly, not a test-specific fixture.
//
// Children must be imported before ChildOf: ChildOf.defineComponent resolves
// the mirror component 'Children' by name at module evaluation time.

import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
// Side-effect: loads the canonical scene barrel before ChildOf is consumed.
import '@forgeax/engine-scene';
import { ChildOf } from '@forgeax/engine-scene';

function alive(world: World, entity: EntityHandle): boolean {
  const r = world.get(entity, Entity);
  if (r.ok) return true;
  return r.error.code !== 'stale-entity';
}

describe('child-of.ts cascade-despawn (AC-08)', () => {
  it('despawn(parent) cascade-despawns child when ChildOf uses default linkedSpawn', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();

    expect(alive(world, child)).toBe(true);

    world.despawn(parent).unwrap();

    expect(alive(world, child)).toBe(false);
  });
});
