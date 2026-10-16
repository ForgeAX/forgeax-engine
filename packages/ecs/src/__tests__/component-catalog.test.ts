import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { readComponentMutationEpoch } from '../projection';
import { Update } from '../schedule-token';
import { World } from '../world';

describe('World ComponentCatalog', () => {
  it('owns independent leases for the same declaration in multiple Worlds', () => {
    const Position = defineComponent('WorldCatalogPosition', { x: 'f32' });
    const worldA = new World();
    const worldB = new World();
    const leaseA = worldA.components.register(Position).unwrap();
    const leaseB = worldB.components.register(Position).unwrap();

    expect(worldA.components.resolve(Position.name)).toBe(Position);
    expect(worldB.components.resolve(Position.name)).toBe(Position);
    expect(leaseA.dispose().ok).toBe(true);
    expect(worldA.components.resolve(Position.name)).toBeUndefined();
    expect(worldB.components.resolve(Position.name)).toBe(Position);
    expect(leaseB.dispose().ok).toBe(true);
  });

  it('refuses the last unregister while entities or systems still reference the token', () => {
    const Marker = defineComponent('WorldCatalogMarker', {});
    const world = new World();
    const lease = world.components.register(Marker).unwrap();
    const entity = world.spawn({ component: Marker, data: {} }).unwrap();

    const entityFailure = lease.dispose();
    expect(entityFailure.ok).toBe(false);
    if (!entityFailure.ok) expect(entityFailure.error.code).toBe('component-in-use');

    world.despawn(entity).unwrap();
    world
      .addSystem(Update, {
        name: 'world-catalog-reader',
        queries: [{ read: [Marker] }],
        fn: () => undefined,
      })
      .unwrap();
    const systemFailure = lease.dispose();
    expect(systemFailure.ok).toBe(false);
    if (!systemFailure.ok) expect(systemFailure.error.code).toBe('component-in-use');

    world.removeSystem(Update, 'world-catalog-reader').unwrap();
    expect(lease.dispose().ok).toBe(true);
    expect(world.components.resolve(Marker.name)).toBeUndefined();
  });

  it('rejects a different token with the same name inside one World', () => {
    const First = defineComponent('WorldCatalogConflict', { x: 'f32' });
    const Second = defineComponent('WorldCatalogConflict', { x: 'f32' });
    const world = new World();
    const lease = world.components.register(First).unwrap();
    const conflict = world.components.register(Second);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('component-name-conflict');
    expect(lease.dispose().ok).toBe(true);
  });

  it('reads one component mutation epoch without advancing on unrelated writes', () => {
    const Marker = defineComponent('WorldCatalogEpochMarker', { value: 'f32' });
    const Other = defineComponent('WorldCatalogEpochOther', { value: 'f32' });
    const world = new World();
    const marker = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const initial = readComponentMutationEpoch(world, Marker);

    world.set(marker, Marker, { value: 2 }).unwrap();
    const changed = readComponentMutationEpoch(world, Marker);
    expect(changed).toBeGreaterThan(initial);

    const other = world.spawn({ component: Other, data: { value: 1 } }).unwrap();
    expect(readComponentMutationEpoch(world, Marker)).toBe(changed);
    expect(readComponentMutationEpoch(world, Other)).toBeGreaterThan(changed);
    world.despawn(other).unwrap();
  });
});
