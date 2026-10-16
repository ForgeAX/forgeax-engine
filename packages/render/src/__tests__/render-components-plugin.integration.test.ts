import { RuntimeMaterialValue, RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { renderComponentsPlugin } from '../plugin';

describe('render component vocabulary', () => {
  it('registers the runtime payload tokens consumed by Render extraction', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin()]);
    try {
      expect(world.components.resolve(RuntimeMaterialValue.name)).toBe(RuntimeMaterialValue);
      expect(world.components.resolve(RuntimeMeshVertices.name)).toBe(RuntimeMeshVertices);
    } finally {
      await context.fiber.dispose();
    }
    expect(world.components.resolve(RuntimeMaterialValue.name)).toBeUndefined();
    expect(world.components.resolve(RuntimeMeshVertices.name)).toBeUndefined();
  });
});
