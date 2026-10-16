import { World } from '@forgeax/engine/ecs';
import {
  CharacterController,
  Collider,
  CollidingEntities,
  CollisionEvent,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  RigidBody,
  registerPhysicsComponents,
} from '@forgeax/engine/physics';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Physics ECS interface',
  catalog: 'Physics ECS interface',
  kind: 'headless',
  summary:
    'registerPhysicsComponents installs RigidBody, Collider, CharacterController and CollidingEntities with schema defaults. The interface package ships no solver: a World with only the components has no PhysicsWorld resource.',
  expect:
    'All checks pass: the four components resolve by name, spawn defaults match the documented schema, CollisionEvent is the named event token, and no PhysicsWorld exists without a backend.',
  run(checks) {
    const world = new World();
    const release = registerPhysicsComponents(world);
    for (const name of ['RigidBody', 'Collider', 'CharacterController', 'CollidingEntities']) {
      checks.ok(`component ${name} registered`, world.components.resolve(name) !== undefined);
    }
    const entity = world
      .spawn(
        { component: RigidBody, data: {} },
        { component: Collider, data: {} },
        { component: CharacterController, data: {} },
      )
      .unwrap();
    const body = world.get(entity, RigidBody).unwrap() as unknown as Record<string, unknown>;
    checks.equal('RigidBody default type = dynamic (1)', body.type, 1);
    checks.near('RigidBody default mass', body.mass as number, 1);
    checks.near('RigidBody default gravityScale', body.gravityScale as number, 1);
    const collider = world.get(entity, Collider).unwrap() as unknown as Record<string, unknown>;
    checks.equal('Collider default shape = cuboid (0)', collider.shape, 0);
    checks.equal(
      'Collider default halfExtents',
      Array.from(collider.halfExtents as ArrayLike<number>),
      [0.5, 0.5, 0.5],
    );
    checks.equal('Collider default isSensor', collider.isSensor, false);
    const controller = world.get(entity, CharacterController).unwrap() as unknown as Record<
      string,
      unknown
    >;
    checks.near(
      'CharacterController default maxSlopeClimbDeg',
      controller.maxSlopeClimbDeg as number,
      45,
    );
    checks.equal('CharacterController.grounded starts false', controller.grounded, false);
    checks.equal('CollisionEvent token', CollisionEvent, '__CollisionEvent__');
    checks.ok(
      'CollidingEntities is a component token',
      typeof CollidingEntities === 'object' && CollidingEntities !== null,
    );
    checks.ok('no PhysicsWorld without a backend plugin', !world.hasResource('PhysicsWorld'));
    const error = new PhysicsError({
      code: 'body-not-found',
      expected: 'a registered body',
      hint: PHYSICS_ERROR_HINTS['body-not-found'],
      detail: { code: 'body-not-found', entity: 7 },
    });
    checks.equal('PhysicsError carries a closed code', error.code, 'body-not-found');
    checks.ok(
      'every PhysicsErrorCode has a hint',
      Object.values(PHYSICS_ERROR_HINTS).every((hint) => hint.length > 0),
    );
    world.despawn(entity).unwrap();
    release();
    checks.ok(
      'release() after despawn removes the component vocabulary',
      world.components.resolve('RigidBody') === undefined,
    );
  },
});
