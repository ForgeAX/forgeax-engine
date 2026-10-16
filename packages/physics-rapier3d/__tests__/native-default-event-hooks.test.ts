import { loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import { expect, it } from 'vitest';
import type { TempContactManifold } from '../pkg/rapier.mjs';

type Mode = 'constant' | 'default' | 'reject' | 'getter-error' | 'raw-absent-this';
async function replay(mode: Mode, sensor = false) {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  const queue = new R.EventQueue(true);
  const flags = R.ActiveHooks.FILTER_CONTACT_PAIRS | R.ActiveHooks.FILTER_INTERSECTION_PAIRS;
  const a = world.createRigidBody(R.RigidBodyDesc.fixed());
  const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.8, 0));
  const ca = world.createCollider(
    R.ColliderDesc.cuboid(2, 0.5, 2)
      .setActiveHooks(flags)
      .setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
      .setSensor(sensor),
    a,
  );
  const cb = world.createCollider(
    R.ColliderDesc.cuboid(0.5, 0.5, 0.5)
      .setActiveHooks(flags)
      .setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
    b,
  );
  const rows: unknown[] = [];
  let calls = 0;
  const marker = new Error('authored hook getter');
  let getterArmed = mode === 'getter-error';
  const hooks = {
    get filterContactPair() {
      if (getterArmed) {
        getterArmed = false;
        throw marker;
      }
      return () => {
        calls++;
        return mode === 'reject' ? null : R.SolverFlags.COMPUTE_IMPULSE;
      };
    },
    filterIntersectionPair() {
      calls++;
      return mode !== 'reject';
    },
  };
  if (mode === 'raw-absent-this') {
    const pipeline = world.physicsPipeline.raw;
    const original = pipeline.stepWithEvents.bind(pipeline);
    pipeline.stepWithEvents = (...args: unknown[]) => {
      args[11] = undefined;
      return original(...args);
    };
  }
  let failure: unknown;
  try {
    if (mode === 'getter-error') {
      let caught: unknown;
      try {
        world.step(queue, hooks);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(marker);
      world.step(queue, {
        filterContactPair: () => R.SolverFlags.COMPUTE_IMPULSE,
        filterIntersectionPair: () => true,
      });
    }
    for (let step = 0; step < 18; step++) {
      if (step === 5) b.setTranslation({ x: 0.1, y: 0.8, z: 0 }, true);
      if (step === 9) cb.setShape(new R.Ball(0.5));
      if (step === 12) b.setBodyType(R.RigidBodyType.KinematicVelocityBased, true);
      if (step === 14) b.setBodyType(R.RigidBodyType.Dynamic, true);
      world.step(queue, mode === 'default' ? undefined : hooks);
      const events: unknown[] = [];
      queue.drainCollisionEvents((x: number, y: number, started: boolean) =>
        events.push([x, y, started]),
      );
      const contacts: unknown[] = [];
      world.contactPair(ca, cb, (m: TempContactManifold) => {
        const points = [];
        for (let i = 0; i < m.numContacts(); i++)
          points.push([
            m.localContactPoint1(i),
            m.localContactPoint2(i),
            m.contactDist(i),
            m.contactImpulse(i),
          ]);
        contacts.push({ normal: m.normal(), points, solver: m.numSolverContacts() });
      });
      rows.push({
        translation: b.translation(),
        rotation: b.rotation(),
        velocity: b.linvel(),
        angularVelocity: b.angvel(),
        contacts,
        intersects: world.intersectionPair(ca, cb),
        events,
        hooks: [ca.activeHooks(), cb.activeHooks()],
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const free of [() => queue.free(), () => world.free()]) {
      try {
        free();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
  return { rows, calls };
}

it.each([
  false,
  true,
])('absent hooks retain exact motion/contact/intersection/events with flags enabled (sensor=%s)', async (sensor) => {
  const constant = await replay('constant', sensor);
  const ordinary = await replay('default', sensor);
  expect(constant.calls).toBeGreaterThan(0);
  expect(ordinary.calls).toBe(0);
  expect(ordinary.rows).toEqual(constant.rows);
  const rows = ordinary.rows as { contacts: unknown[]; intersects: boolean; events: unknown[] }[];
  expect(rows.some((row) => row.events.length > 0)).toBe(true);
  expect(rows.some((row) => (sensor ? row.intersects : row.contacts.length > 0))).toBe(true);
});

it('explicit filters still reject contacts and sensors', async () => {
  for (const sensor of [false, true]) {
    const reject = await replay('reject', sensor);
    expect(reject.calls).toBeGreaterThan(0);
    for (const row of reject.rows as {
      contacts: unknown[];
      intersects: boolean;
      events: unknown[];
    }[]) {
      expect(row.contacts).toEqual([]);
      expect(row.intersects).toBe(false);
      expect(row.events).toEqual([]);
    }
  }
});

it('explicit getter errors keep their identity and leave the World usable', async () => {
  const value = await replay('getter-error');
  expect(value.rows).toHaveLength(18);
});

it('direct raw callbacks retain execution with an absent this argument', async () => {
  const ordinary = await replay('constant');
  const raw = await replay('raw-absent-this');
  expect(raw.calls).toBe(ordinary.calls);
  expect(raw.rows).toEqual(ordinary.rows);
});
