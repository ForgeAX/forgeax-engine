import { expect, it } from 'vitest';
import { loadRapier3D } from '../src/wasm-loader.js';

it('preserves dynamic CCD and collision events after a fast body is parked and reactivated', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw Error(R.code);
  const world = new R.World({ x: 0, y: 0, z: 0 });
  const events = new R.EventQueue(true);
  try {
    const parked = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setLinvel(60, 0, 0).setCcdEnabled(true),
    );
    world.createCollider(R.ColliderDesc.cuboid(0.05, 0.05, 0.05), parked);
    const dynamic = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, 10, 0).setLinvel(60, 0, 0).setCcdEnabled(true),
    );
    const dynamicCollider = world.createCollider(
      R.ColliderDesc.cuboid(0.05, 0.05, 0.05).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      dynamic,
    );
    world.step(events);
    // Match the destruction lifecycle: park immediately after an active CCD step.
    const position = { ...parked.translation() };
    parked.setBodyType(R.RigidBodyType.Fixed, true);
    const wallX = dynamic.translation().x + 0.3;
    const wall = world.createCollider(
      R.ColliderDesc.cuboid(0.01, 1, 1).setTranslation(wallX, 10, 0),
    );
    world.createCollider(R.ColliderDesc.cuboid(0.01, 1, 1).setTranslation(position.x + 0.3, 0, 0));
    const emitted: [number, number, boolean][] = [];
    const dynamicX: number[] = [];
    for (let step = 0; step < 20; step++) {
      world.step(events);
      events.drainCollisionEvents((a, b, started) => emitted.push([a, b, started]));
      expect(parked.translation()).toEqual(position);
      expect(dynamic.translation().x).toBeLessThan(wallX);
      dynamicX.push(dynamic.translation().x);
    }
    expect(Math.max(...dynamicX)).toBeGreaterThan(position.x);
    expect(
      emitted.some(
        ([a, b, started]) =>
          started &&
          ((a === wall.handle && b === dynamicCollider.handle) ||
            (b === wall.handle && a === dynamicCollider.handle)),
      ),
    ).toBe(true);
    // Releasing parked rubble must restore its ordinary dynamic CCD behavior.
    parked.setBodyType(R.RigidBodyType.Dynamic, true);
    parked.setLinvel({ x: 60, y: 0, z: 0 }, true);
    const releasedX: number[] = [];
    for (let step = 0; step < 20; step++) {
      world.step(events);
      expect(parked.translation().x).toBeLessThan(position.x + 0.3);
      releasedX.push(parked.translation().x);
    }
    expect(Math.max(...releasedX)).toBeGreaterThan(position.x);
  } finally {
    events.free();
    world.free();
  }
});
