import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, scenePlugin, Transform } from '../index';

describe('scenePlugin', () => {
  it('installs propagation without render or animation capabilities', async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [scenePlugin()]);
    const root = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(5);
    await ctx.fiber.dispose();
    expect(world.inspect().systems.some((system) => system.name === 'propagateTransforms')).toBe(
      false,
    );
  });
});
