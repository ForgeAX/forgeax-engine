import { expect, it } from 'vitest';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  false,
  true,
])('invalidates fixed CCD targets while bodies are slow (replacement: %s)', async (replace) => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  let failure: unknown;
  try {
    const floor = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const old = world.createCollider(rapier.ColliderDesc.cuboid(2, 0.5, 2), floor);
    const ball = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
    world.createCollider(rapier.ColliderDesc.ball(0.1), ball);

    // The initial fall populates CCD's fixed-target cache before the body sleeps.
    for (let frame = 0; frame < 240; frame++) world.step();
    expect(ball.isSleeping()).toBe(true);
    expect(ball.translation().y).toBeCloseTo(0.6, 3);

    world.removeCollider(old, true);
    if (replace) {
      world.createCollider(rapier.ColliderDesc.cuboid(2, 0.5, 2).setTranslation(0, -1, 0), floor);
    }
    // Scene mutation occurs while slow. Gravity later activates CCD without
    // another authored change; a stale cache used to dereference the old handle.
    for (let frame = 0; frame < 120; frame++) world.step();
    const y = ball.translation().y;
    expect(Number.isFinite(y)).toBe(true);
    if (replace) expect(y).toBeCloseTo(-0.4, 3);
    else expect(y).toBeLessThan(-10);
  } catch (error) {
    failure = error;
  } finally {
    try {
      world.free();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
});
