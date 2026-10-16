import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, it } from 'vitest';
import { animationPlugin } from '../plugin';

describe('animation ECS consumer', () => {
  it('accepts the plugin build callback from a real World', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
  });
});
