import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import type { RapierPhysicsWorld3D } from '@forgeax/engine/physics-rapier3d';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { waitForPhysicsWorld, waitUntil } from './support/live';

export default defineFeature({
  title: 'Collision events',
  catalog: 'Collision pairs/events',
  kind: 'probe',
  appOptions: { plugins: [physicsPlugin('rapier-3d')] },
  summary:
    'The PhysicsCollisionSync phase writes CollidingEntities on entities that carry it, and the Rapier backend keeps started/stopped pair events (drainCollisionEvents / getCollisionEventHistory). Sensors report overlap without blocking.',
  expect:
    'All checks pass: a falling ball lists the floor in CollidingEntities, a sensor volume lists the ball passing through it, a started event exists for the pair, and teleporting away clears the set.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    const { physics } = await waitForPhysicsWorld<RapierPhysicsWorld3D>(world, frames);
    checks.ok('PhysicsWorld resource inserted', physics !== undefined);
    if (physics === undefined) return { checks: () => checks.items };
    const collidingWith = (entity: number): readonly number[] => {
      const read = world.get(entity as never, CollidingEntities);
      return read.ok
        ? Array.from((read.value as unknown as { entities: ArrayLike<number> }).entities)
        : [];
    };
    const floor = world
      .spawn(
        { component: Transform, data: { pos: [0, -0.5, 0] } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 10] },
        },
      )
      .unwrap();
    const sensor = world
      .spawn(
        { component: Transform, data: { pos: [0, 2, 0] } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 0.3, 1], isSensor: true },
        },
        { component: CollidingEntities, data: {} },
      )
      .unwrap();
    const ball = world
      .spawn(
        { component: Transform, data: { pos: [0, 4, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.4 } },
        { component: CollidingEntities, data: {} },
      )
      .unwrap();
    const sensed = await waitUntil(frames, () => collidingWith(sensor).includes(ball), 300);
    checks.ok(
      'sensor CollidingEntities lists the passing ball',
      sensed !== undefined,
      `sensor=${collidingWith(sensor)}`,
    );
    const touched = await waitUntil(frames, () => collidingWith(ball).includes(floor), 600);
    checks.ok(
      'ball CollidingEntities lists the floor',
      touched !== undefined,
      `ball=${collidingWith(ball)}`,
    );
    checks.ok('ball never blocked by the sensor (it reached the floor)', touched !== undefined);
    const history = physics.getCollisionEventHistory();
    const pair = (a: number, b: number) =>
      history.some(
        (event) =>
          event.type === 'started' &&
          ((event.entityA === a && event.entityB === b) ||
            (event.entityA === b && event.entityB === a)),
      );
    checks.ok('history has started(ball, floor)', pair(ball, floor), `events=${history.length}`);
    checks.ok('history has started(ball, sensor)', pair(ball, sensor));
    const drained = physics.drainCollisionEvents();
    checks.ok(
      'drainCollisionEvents returns pending events',
      drained.length > 0,
      `drained=${drained.length}`,
    );
    checks.equal('second drain is empty', physics.drainCollisionEvents().length, 0);
    physics.teleport(ball, Float32Array.of(20, 5, 0) as never);
    const cleared = await waitUntil(frames, () => collidingWith(ball).length === 0, 120);
    checks.ok(
      'leaving contact clears CollidingEntities',
      cleared !== undefined,
      `ball=${collidingWith(ball)}`,
    );
    const stopped = physics
      .getCollisionEventHistory()
      .some(
        (event) => event.type === 'stopped' && (event.entityA === ball || event.entityB === ball),
      );
    checks.ok('history records a stopped event', stopped);
    return { checks: () => checks.items };
  },
});
