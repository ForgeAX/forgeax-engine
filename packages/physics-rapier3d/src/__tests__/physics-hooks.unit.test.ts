import { expect, it } from 'vitest';
import { loadRapier3D } from '../wasm-browser';

it('keeps immovable solver contact points and sensor events without JavaScript filters', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new R.World({ x: 0, y: -9.81, z: 0 }),
    events = new R.EventQueue(true);
  const bodies = [
    R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.5, 0),
    R.RigidBodyDesc.fixed().setTranslation(0, 0.5, 0),
  ].map((desc) => world.createRigidBody(desc));
  const colliders = bodies.map((body, index) =>
    world.createCollider(
      R.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setSensor(index === 2)
        .setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
        .setActiveHooks(
          R.ActiveHooks.FILTER_CONTACT_PAIRS | R.ActiveHooks.FILTER_INTERSECTION_PAIRS,
        )
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      body,
    ),
  );
  try {
    world.step(events);
    let solverPoints = 0;
    world.contactPair(
      colliders[0],
      colliders[1],
      (m: { numSolverContacts(): number }) => (solverPoints += m.numSolverContacts()),
    );
    expect(solverPoints).toBeGreaterThan(0);
    const started: boolean[] = [];
    events.drainCollisionEvents((_a: number, _b: number, value: boolean) => started.push(value));
    expect(started.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  } finally {
    events.free();
    world.free();
  }
});

it('calls native pair filters directly with the original receiver and four handles', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  const events = new R.EventQueue(true);
  const floor = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const falling = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0));
  const trigger = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0.5, 0));
  for (const [body, sensor] of [
    [floor, false],
    [falling, false],
    [trigger, true],
  ] as const) {
    world.createCollider(
      R.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setSensor(sensor)
        .setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
        .setActiveHooks(
          R.ActiveHooks.FILTER_CONTACT_PAIRS | R.ActiveHooks.FILTER_INTERSECTION_PAIRS,
        )
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      body,
    );
  }
  let contacts = 0,
    intersections = 0;
  const check = (args: number[]) => {
    expect(args).toHaveLength(4);
    expect(world.getCollider(args[0]).parent()?.handle).toBe(args[2]);
    expect(world.getCollider(args[1]).parent()?.handle).toBe(args[3]);
  };
  const hooks = {
    filterContactPair(this: unknown, ...args: number[]) {
      expect(this).toBe(hooks);
      check(args);
      contacts++;
      return R.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair(this: unknown, ...args: number[]) {
      expect(this).toBe(hooks);
      check(args);
      intersections++;
      return true;
    },
  };
  // A native step must not allocate a temporary bound function for each pair.
  for (const fn of [hooks.filterContactPair, hooks.filterIntersectionPair]) {
    Object.defineProperty(fn, 'bind', {
      value() {
        throw new Error('temporary pair-filter bind');
      },
    });
  }
  try {
    world.step(events, hooks);
    expect(contacts).toBeGreaterThan(0);
    expect(intersections).toBeGreaterThan(0);
    const started: boolean[] = [];
    events.drainCollisionEvents((_a: number, _b: number, value: boolean) => started.push(value));
    expect(started.some(Boolean)).toBe(true);
  } finally {
    events.free();
    world.free();
  }
});
