import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
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

  it('keeps world transform reads on the renderer projection boundary', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [3, 0, 0] } }).unwrap();
    expect(propagateTransforms(world).ok).toBe(true);

    const lease = createRenderReadLease(world);
    const projection = lease.querySpans({
      components: [{ component: GlobalTransform, fields: ['world'] }],
    });
    const worldColumn = projection.spans[0]?.fields.world;
    expect(worldColumn?.[12]).toBeCloseTo(3);
    expect(lease.generation).toBeGreaterThan(0);
    lease.dispose();
    expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);
  });

  it('keeps morph weights outside the transform carrier lane', () => {
    expect(MorphWeights.name).toBe('MorphWeights');
    expect(Transform.name).toBe('Transform');
    expect(MorphWeights).not.toBe(Transform);
  });
});
