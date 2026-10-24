import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { renderComponentsPlugin } from '../plugin';
import { VolumetricFog } from '../volume/component';

describe('render component vocabulary', () => {
  it('leases the render binding tokens consumed by extraction', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin()]);
    try {
      expect(world.components.resolve(MeshFilter.name)).toBe(MeshFilter);
      expect(world.components.resolve(MeshRenderer.name)).toBe(MeshRenderer);
      expect(world.components.resolve(VolumetricFog.name)).toBe(VolumetricFog);
    } finally {
      await context.fiber.dispose();
    }
    expect(world.components.resolve(MeshFilter.name)).toBeUndefined();
    expect(world.components.resolve(MeshRenderer.name)).toBeUndefined();
    expect(world.components.resolve(VolumetricFog.name)).toBeUndefined();
  });
});
