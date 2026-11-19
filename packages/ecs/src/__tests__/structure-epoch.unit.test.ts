import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

describe('structure-epoch', () => {
  describe('World structureEpoch', () => {
    it('bumps for entity and component structure writes', () => {
      const Position = defineComponent('StructureEpochPosition', { x: 'f32' });
      const Velocity = defineComponent('StructureEpochVelocity', { dx: 'f32' });
      const world = new World();
      const initial = world.getStructureEpoch();

      const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
      const afterSpawn = world.getStructureEpoch();
      world.addComponent(entity, { component: Velocity, data: { dx: 2 } }).unwrap();
      const afterAdd = world.getStructureEpoch();
      world.removeComponent(entity, Velocity).unwrap();
      const afterRemove = world.getStructureEpoch();
      world.despawn(entity).unwrap();

      expect(afterSpawn).toBeGreaterThan(initial);
      expect(afterAdd).toBeGreaterThan(afterSpawn);
      expect(afterRemove).toBeGreaterThan(afterAdd);
      expect(world.getStructureEpoch()).toBeGreaterThan(afterRemove);
    });

    it('does not bump for scalar writes or no-op writes', () => {
      const Position = defineComponent('StructureEpochScalar', { x: 'f32' });
      const world = new World();
      const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
      const beforeWrite = world.getStructureEpoch();

      world.set(entity, Position, { x: 2 }).unwrap();
      expect(world.getStructureEpoch()).toBe(beforeWrite);
      world.set(entity, Position, {}).unwrap();
      expect(world.getStructureEpoch()).toBe(beforeWrite);
    });

    it('does not let stale writes change the current World revision', () => {
      const Position = defineComponent('StructureEpochStale', { x: 'f32' });
      const world = new World();
      const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
      world.despawn(entity).unwrap();
      const beforeStaleWrite = world.getStructureEpoch();

      expect(world.set(entity, Position, { x: 2 }).ok).toBe(false);
      expect(world.getStructureEpoch()).toBe(beforeStaleWrite);
    });
  });
});

describe('structure-epoch-boundaries', () => {
  describe('structureEpoch boundaries', () => {
    it('reports a strictly increasing revision for each successful structure write', () => {
      const Tag = defineComponent('StructureEpochBoundaryTag', {});
      const world = new World();
      const values = [world.getStructureEpoch()];
      const entity = world.spawn({ component: Tag, data: {} }).unwrap();
      values.push(world.getStructureEpoch());
      world
        .addComponent(entity, {
          component: defineComponent('StructureEpochBoundaryExtra', { value: 'f32' }),
          data: { value: 1 },
        })
        .unwrap();
      values.push(world.getStructureEpoch());
      world.despawn(entity).unwrap();
      values.push(world.getStructureEpoch());

      expect(values).toEqual([...values].sort((left, right) => left - right));
      expect(new Set(values).size).toBe(values.length);
    });

    it('keeps scalar writes and stale writes outside the structure revision', () => {
      const Value = defineComponent('StructureEpochBoundaryValue', { value: 'f32' });
      const world = new World();
      const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
      const epoch = world.getStructureEpoch();

      world.set(entity, Value, { value: 3 }).unwrap();
      expect(world.getStructureEpoch()).toBe(epoch);
      world.despawn(entity).unwrap();
      const afterDespawn = world.getStructureEpoch();
      expect(world.set(entity, Value, { value: 4 }).ok).toBe(false);
      expect(world.getStructureEpoch()).toBe(afterDespawn);
    });
  });
});
