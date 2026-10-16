import { describe, expect, it } from 'vitest';
import { createWorldContext } from '../plugin-service';
import { World } from '../world';

describe('world plugin service', () => {
  it('creates a Cordis context with the World owner', async () => {
    const world = new World();
    const context = await createWorldContext(world);

    expect(context).toBeDefined();
    await context.fiber.dispose();
  });
});
