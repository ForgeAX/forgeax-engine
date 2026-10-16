import { animationPlugin } from '@forgeax/engine-animation';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { scenePlugin } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

describe('scene plugin policy', () => {
  it('can be composed on a host-owned world', async () => {
    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
  });
});

it('extracted animation plugin has a stable identity', () => {
  expect(animationPlugin().name).toBe('animation');
});
