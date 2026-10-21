import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Skin, skinningPlugin } from '../index';

describe('skinningPlugin', () => {
  it('installs only the optional Skin component vocabulary', async () => {
    const world = new World();
    const context = await createWorldContext(world, [skinningPlugin()]);

    expect([...world.components.entries()].map(([name]) => name)).toEqual(['Skin']);
    const entity = world.spawn({ component: Skin, data: { joints: [] } }).unwrap();
    expect(world.get(entity, Skin).ok).toBe(true);

    world.despawn(entity).unwrap();
    await context.fiber.dispose();
    expect(world.components.entries()).toHaveLength(0);
  });
});
