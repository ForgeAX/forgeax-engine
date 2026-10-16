import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

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
