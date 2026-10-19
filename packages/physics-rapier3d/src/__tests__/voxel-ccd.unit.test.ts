import { expect, it } from 'vitest';
import { loadRapier3D } from '../wasm-loader.js';

it.each([
  ['solid', 0.4, false],
  ['hole', 0, false],
  ['sensor', 0.4, true],
] as const)('retains %s crossings through native voxel CCD', async (kind, y, sensor) => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  for (const speed of [30, 60, 120]) {
    const world = new R.World({ x: 0, y: 0, z: 0 });
    const events = new R.EventQueue(true);
    try {
      const wall = world.createCollider(
        R.ColliderDesc.voxelRegions(new Int32Array([0, -8, -8, 1, -1, 8, 0, 1, -8, 1, 8, 8]), {
          x: 0.1,
          y: 0.1,
          z: 0.1,
        })
          .setSensor(sensor)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      );
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(-0.5, y, 0)
          .setLinvel(speed, 0, 0)
          .setCcdEnabled(true),
      );
      const box = world.createCollider(R.ColliderDesc.cuboid(0.03, 0.03, 0.03), body);
      let crossed = false;
      let entered = false;
      for (let step = 0; step < 20; step++) {
        world.step(events);
        crossed ||= body.translation().x > 0.2;
        events.drainCollisionEvents((a: number, b: number, started: boolean) => {
          if ((a === wall.handle && b === box.handle) || (a === box.handle && b === wall.handle)) {
            entered ||= started;
          }
        });
      }
      expect(crossed, `${kind} at ${speed} m/s`).toBe(kind !== 'solid');
      expect(entered, `${kind} collision event at ${speed} m/s`).toBe(kind !== 'hole');
    } finally {
      events.free();
      world.free();
    }
  }
});
