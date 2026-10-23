import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { loadRapier3D } from '../wasm-loader.js';

it.each(['cuboid', 'convex'] as const)('retains native voxel CCD for a %s box', async (shape) => {
  for (const [kind, y, sensor] of [
    ['solid', 0.4, false],
    ['hole', 0, false],
    ['sensor', 0.4, true],
  ] as const) {
    const R = await loadRapier3D();
    if ('code' in R) throw R;
    for (const speed of [30, 60, 120]) {
      for (const angular of [0, 10]) {
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
              .setAngvel({ x: angular, y: angular, z: angular })
              .setCcdEnabled(true),
          );
          const desc =
            shape === 'cuboid'
              ? R.ColliderDesc.cuboid(0.03, 0.03, 0.03)
              : R.ColliderDesc.convexHull(boxPoints([-0.03, -0.03, -0.03], [0.03, 0.03, 0.03]));
          if (!desc) throw new Error('The complete box must form a convex hull');
          const box = world.createCollider(desc, body);
          let crossed = false;
          let entered = false;
          for (let step = 0; step < 20; step++) {
            world.step(events);
            crossed ||= body.translation().x > 0.2;
            events.drainCollisionEvents((a: number, b: number, started: boolean) => {
              if (
                (a === wall.handle && b === box.handle) ||
                (a === box.handle && b === wall.handle)
              ) {
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
    }
  }
});

it.each([
  ['solid', 0.4, false],
  ['hole', 0, false],
  ['sensor', 0.4, true],
] as const)('sweeps a moving voxel %s through a stationary cuboid', async (kind, y, sensor) => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  for (const speed of [30, 60, 120]) {
    const world = new R.World({ x: 0, y: 0, z: 0 });
    const events = new R.EventQueue(true);
    try {
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic().setLinvel(-speed, 0, 0).setCcdEnabled(true).lockRotations(),
      );
      const moving = world.createCollider(
        R.ColliderDesc.voxelRegions(new Int32Array([0, -8, -8, 1, -1, 8, 0, 1, -8, 1, 8, 8]), {
          x: 0.1,
          y: 0.1,
          z: 0.1,
        })
          .setSensor(sensor)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      const box = world.createCollider(
        R.ColliderDesc.cuboid(0.03, 0.03, 0.03).setTranslation(-0.5, y, 0),
      );
      let crossed = false;
      let entered = false;
      for (let step = 0; step < 20; step++) {
        world.step(events);
        crossed ||= body.translation().x < -0.7;
        events.drainCollisionEvents((a: number, b: number, started: boolean) => {
          if (
            (a === moving.handle && b === box.handle) ||
            (a === box.handle && b === moving.handle)
          ) {
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

it.each([
  0, 10, 60,
])('retains rotating moving voxels at %s rad/s against a thin wall', async (angular) => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  for (const speed of [30, 60, 120]) {
    const world = new R.World({ x: 0, y: 0, z: 0 });
    try {
      world.createCollider(R.ColliderDesc.cuboid(0.025, 10, 10));
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(0.5, 0, 0)
          .setLinvel(-speed, 0, 0)
          .setAngvel({ x: angular, y: angular, z: angular })
          .setCcdEnabled(true),
      );
      world.createCollider(
        R.ColliderDesc.voxelRegions(new Int32Array([-2, -1, -1, 2, 1, 1]), {
          x: 0.1,
          y: 0.1,
          z: 0.1,
        }),
        body,
      );
      for (let step = 0; step < 20; step++) {
        world.step();
        expect(body.translation().x, `${speed} m/s at step ${step}`).toBeGreaterThan(0);
      }
    } finally {
      world.free();
    }
  }
});

it.each([
  ['grenade', 0.1, 16],
  ['fast grenade', 0.1, 40],
  ['debris', 0.25, 25],
] as const)('keeps a CCD %s out of a thin voxel wall at a merged 100 ms step', async (_kind, half, speed) => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  // Two merged 50 ms fixed steps: one native integration over 100 ms.
  world.timestep = 0.1;
  const events = new R.EventQueue(true);
  try {
    // One 0.1 m voxel layer spanning the path.
    world.createCollider(
      R.ColliderDesc.voxelRegions(new Int32Array([0, -16, -16, 1, 16, 16]), {
        x: 0.1,
        y: 0.1,
        z: 0.1,
      }),
    );
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(-1.5, 0.5, 0)
        .setLinvel(speed, 0, 0)
        .setCcdEnabled(true),
    );
    world.createCollider(R.ColliderDesc.cuboid(half, half, half), body);
    for (let step = 0; step < 10; step++) {
      world.step(events);
      // The body never ends a step beyond the wall's far face.
      expect(body.translation().x).toBeLessThan(0.1 + half);
    }
  } finally {
    events.free();
    world.free();
  }
});
