import { FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { GlobalTransform, Transform } from '../index';
import { registerPropagateTransforms } from '../systems/propagate-transforms';

describe('TransformPropagation schedule contract', () => {
  it('exposes one ordering token in both Update and FixedUpdate', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const inspection = world.inspect();
    const update = inspection.schedules.find((entry) => entry.schedule === Update);
    const fixed = inspection.schedules.find((entry) => entry.schedule === FixedUpdate);

    expect(update?.systems.map((system) => system.name)).toContain('propagateTransforms');
    expect(fixed?.systems.map((system) => system.name)).toContain('propagateTransformsFixed');
    expect(inspection.schedules.map((entry) => entry.schedule.name)).toEqual(
      expect.arrayContaining(['Update', 'FixedUpdate']),
    );
    expect(inspection.schedules.map((entry) => entry.schedule.name)).not.toContain('FramePublish');
  });

  it('keeps local and world query surfaces disjoint', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    registerPropagateTransforms(world);

    expect(
      world
        .query({ read: [Transform] })
        .unwrap()
        .at(entity)
        ?.get(Transform).pos[0],
    ).toBe(4);
    expect(
      world
        .query({ read: [GlobalTransform] })
        .unwrap()
        .at(entity),
    ).toBeDefined();
    expect(world.update(0).ok).toBe(true);
    expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(4);
  });
});
