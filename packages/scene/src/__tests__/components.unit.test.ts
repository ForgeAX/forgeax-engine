import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  ChildOf,
  Children,
  GlobalTransform,
  MorphWeights,
  Name,
  propagateTransforms,
  Transform,
} from '../index';

describe('scene component roster', () => {
  it('exports exactly the four scene components', () => {
    expect(Object.keys({ Name, Transform, GlobalTransform, ChildOf, Children }).sort()).toEqual([
      'ChildOf',
      'Children',
      'GlobalTransform',
      'Name',
      'Transform',
    ]);
  });

  it('registers and spawns in a headless world', () => {
    const world = new World();
    const entity = world
      .spawn(
        { component: Name, data: { value: 'root' } },
        { component: Transform, data: {} },
        { component: Children, data: {} },
      )
      .unwrap();
    expect(world.get(entity, Name).unwrap().value).toBe('root');
  });

  it('exposes the propagated world transform through a read span', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [3, 0, 0] } }).unwrap();
    expect(propagateTransforms(world).ok).toBe(true);

    const query = world.query({ read: [GlobalTransform] }).unwrap();
    const [span] = query.spans().unwrap();
    expect(span?.get(GlobalTransform).world[12]).toBeCloseTo(3);
    expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);
  });

  it('keeps morph weights outside the transform carrier lane', () => {
    expect(MorphWeights.name).toBe('MorphWeights');
    expect(Transform.name).toBe('Transform');
    expect(MorphWeights).not.toBe(Transform);
  });
});
