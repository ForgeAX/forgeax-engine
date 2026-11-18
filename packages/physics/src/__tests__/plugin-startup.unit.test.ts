import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { type PhysicsWorld, PhysicsWorldResource } from '../physics-world';
import { definePhysicsPlugin, PHYSICS_STARTUP_OPTIONS } from '../plugin-factory';

function backend() {
  const physics = { dispose: vi.fn() } as unknown as PhysicsWorld;
  return {
    physics,
    resource: PhysicsWorldResource,
    name: 'constructor-witness',
    load: vi.fn(async () => ({ native: true })),
    create: vi.fn(() => physics),
    registerSystems: vi.fn(() => vi.fn()),
  };
}

describe('physics constructor configuration', () => {
  it('reads the startup slice before loading and constructing its native owner', async () => {
    const world = new World();
    const settings = Object.freeze({ solverIterations: 8, asyncResultsInterpolation: false });
    world.insertResource(PHYSICS_STARTUP_OPTIONS, settings);
    const native = backend();
    const context = await createWorldContext(world, [definePhysicsPlugin(native)]);
    expect(native.create).toHaveBeenCalledWith({ native: true }, settings);
    expect(world.getResource(PhysicsWorldResource)).toBe(native.physics);
    expect(native.load.mock.invocationCallOrder[0]).toBeLessThan(
      native.create.mock.invocationCallOrder[0] ?? 0,
    );
    await context.fiber.dispose();
    expect(native.physics.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects competing constructor arguments before native loading', async () => {
    const world = new World();
    world.insertResource(PHYSICS_STARTUP_OPTIONS, { solverIterations: 8 });
    const native = backend();
    const plugin = definePhysicsPlugin(native);
    await expect(
      createWorldContext(world, [
        {
          name: 'root',
          async apply(ctx) {
            await ctx.plugin(plugin, { solverIterations: 4 });
          },
        },
      ]),
    ).rejects.toThrow();
    expect(native.load).not.toHaveBeenCalled();
    expect(native.create).not.toHaveBeenCalled();
  });
});
