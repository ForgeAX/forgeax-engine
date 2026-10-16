import { defineComponent, defineRelationship, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

const { source: ChildOf, target: Children } = defineRelationship({
  sourceName: 'ReductionChildOf',
  sourceField: 'parent',
  targetName: 'ReductionChildren',
  targetField: 'entities',
});
const { source: AnimatedBy, target: AnimationTargets } = defineRelationship({
  sourceName: 'ReductionAnimatedBy',
  sourceField: 'player',
  targetName: 'ReductionAnimationTargets',
  targetField: 'targets',
});

describe('M0 ECS reduction characterization', () => {
  it('F-01: exposes pending reservations after a system throws', () => {
    const Marker = defineComponent('M0PendingMarker', {});
    const world = new World();

    world.addSystem(Update, {
      name: 'throw-after-reservation',
      queries: [],
      fn: (_world, _queries, commands) => {
        commands.spawn({ component: Marker, data: {} });
        throw new Error('M0 system failure');
      },
    });

    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('system-failed');
      if (result.error.code === 'system-failed') {
        expect(result.error.detail.cause).toBeInstanceOf(Error);
      }
    }
    expect(world.execution.health).toBe('poisoned');
  });

  it('F-02: preserves a failed command result at the public update boundary', () => {
    const Marker = defineComponent('M0CommandMarker', {});
    const world = new World();
    const entity = world.spawn({ component: Marker, data: {} }).unwrap();
    const before = world.inspect().entityCount;

    world.addSystem(Update, {
      name: 'duplicate-component-command',
      queries: [],
      fn: (_world, _queries, commands) => {
        commands.addComponent(entity, { component: Marker, data: {} });
      },
    });

    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('command-failed');
      if (result.error.code === 'command-failed') {
        expect(result.error.detail.systemName).toBe('duplicate-component-command');
        expect(result.error.detail.commandKind).toBe('addComponent');
        expect((result.error.detail.cause as { readonly code?: string }).code).toBe(
          'component-already-present',
        );
      }
    }
    expect(world.execution.health).toBe('healthy');
    expect(world.inspect().entityCount).toBe(before);
  });

  it('F-03: despawn does not own shared payload disposal', () => {
    const world = new World();
    const payload = { id: 1 };
    const handle = world.allocSharedRef('M0Asset', payload);
    const Holder = defineComponent('M0SharedHolder', { asset: 'shared<M0Asset>' });
    const entity = world.spawn({ component: Holder, data: { asset: handle } }).unwrap();
    world.sharedRefs.release(handle).unwrap();

    expect(() => world.despawn(entity)).not.toThrow();
    expect(world.sharedRefs.resolve(handle).ok).toBe(false);
    expect(world.sharedRefs.refcount(handle)).toBe(0);
  });

  it('F-07: rejects undefined shared payloads before allocating a slot', () => {
    const world = new World();
    expect(() => world.allocSharedRef('M0UndefinedAsset', undefined)).toThrow();
  });

  it('T-02: rejects an invalid managed-array payload without a row delta', () => {
    const Values = defineComponent('M0ManagedValues', { values: 'array<f32>' });
    const world = new World();
    const beforeEntityCount = world.inspect().entityCount;
    const beforeEpoch = world.getStructureEpoch();

    const result = world.spawn({
      component: Values,
      data: { values: { invalid: true } as never },
    });

    expect(result.ok).toBe(false);
    expect(world.inspect().entityCount).toBe(beforeEntityCount);
    expect(world.getStructureEpoch()).toBe(beforeEpoch);
  });

  it('keeps ChildOf/Children and AnimatedBy/AnimationTargets as materialized target pairs', () => {
    const world = new World();
    const parent = world.spawn({ component: Children, data: { entities: [] } }).unwrap();
    const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
    const children = world.get(parent, Children).unwrap().entities;
    expect([...children]).toContain(child);

    const player = world.spawn({ component: AnimationTargets, data: { targets: [] } }).unwrap();
    const target = world.spawn({ component: AnimatedBy, data: { player } }).unwrap();
    const targets = world.get(player, AnimationTargets).unwrap().targets;
    expect([...targets]).toContain(target);

    const childrenEpoch = world.getStructureEpoch();
    // Relationship target components are intentionally not writable through
    // the typed mutation facade; the runtime returns a structured refusal.
    // @ts-expect-error relationship target is a read-only projection.
    const targetWrite = world.set(parent, Children, { entities: [] });
    // @ts-expect-error relationship target is a read-only projection.
    const animationTargetWrite = world.set(player, AnimationTargets, { targets: [] });
    expect(childrenEpoch).toBeLessThanOrEqual(world.getStructureEpoch());
    expect(targetWrite.ok).toBe(false);
    expect(animationTargetWrite.ok).toBe(false);
  });
});
