import { createWorldContext, World } from '@forgeax/engine-ecs';
import { inputBackendPlugin } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';

import { inputPlugin } from '../src/plugin-factories';

describe('inputPlugin SystemSet registration', () => {
  it('records InputFrameStartScan in the input set', async () => {
    const world = new World();
    await createWorldContext(world, [
      inputBackendPlugin({ sample: () => ({}) } as never),
      inputPlugin(),
    ]);

    expect(
      world.inspect().systems.find((system) => system.name === 'input-frame-start-scan')?.sets,
    ).toContain('input');
  });
});
