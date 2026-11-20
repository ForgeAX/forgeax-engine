import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, Disabled, type EntityHandle, World } from '@forgeax/engine-ecs';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, scenePlugin, Transform } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { World as NativeWorld } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld, loadRapier3D, registerPhysicsSystems } from '../index';
import type { StaticPhysicsGroup, StaticResidentMember } from '../static-residency';

function errorOf<E>(result: Result<unknown, E>): E {
  if (result.ok) throw new Error('expected a rejected operation');
  return result.error;
}
function memberEntity(members: readonly StaticResidentMember[], index: number): EntityHandle {
  const member = members[index];
  if (member === undefined) throw new Error('missing fixture member');
  return member.entity;
}

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
function setup(assets?: AssetRegistry) {
  const world = new World(assets === undefined ? {} : { assets });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  const spawn = (x = 0) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] } },
        { component: Disabled, data: {} },
      )
      .unwrap();
  const sync = () => physics._syncFromEcs(world, Transform, GlobalTransform);
  const source = (members: readonly StaticResidentMember[], active: boolean) => () => {
    for (const member of members) {
      if (active && member.participates) world.removeComponent(member.entity, Disabled).unwrap();
      else if (!world.hasComponent(member.entity, Disabled))
        world.addComponent(member.entity, { component: Disabled, data: {} }).unwrap();
    }
    return ok(undefined);
  };
  const hit = (x = 0) => physics.raycast(vec3.create(x, 5, 0), vec3.create(0, -1, 0), 10)?.entity;
  const prepare = (group: StaticPhysicsGroup) => {
    for (let steps = 0; steps < 10; steps++) {
      if (group.prepareStep().unwrap().phase === 'prepared') return;
    }
    throw new Error('static preparation did not complete');
  };
  return { world, physics, spawn, sync, source, hit, prepare };
}

test('real Disabled bodies survive normal reconciliation; group acceptance reuses them and preserves authored Disabled', () => {
  const c = setup();
  try {
    const members = [
      { entity: c.spawn(), participates: true },
      { entity: c.spawn(5), participates: false },
    ];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    expect(group.prepareStep().unwrap()).toMatchObject({ phase: 'preparing', prepared: 1 });
    const first = c.physics.getBodyHandle(memberEntity(members, 0));
    c.sync();
    expect(c.physics.getBodyCount()).toBe(1);
    c.prepare(group);
    const second = c.physics.getBodyHandle(memberEntity(members, 1));
    c.sync();
    c.physics.step(1 / 60);
    expect(c.hit()).toBeUndefined();
    expect(c.hit(5)).toBeUndefined();
    group.accept(true, c.source(members, true)).unwrap();
    expect(c.hit()).toBe(memberEntity(members, 0));
    c.sync();
    c.physics.step(1 / 60);
    expect(c.hit()).toBe(memberEntity(members, 0));
    expect(c.hit(5)).toBeUndefined();
    expect(c.physics.getBodyHandle(memberEntity(members, 0))).toBe(first);
    expect(c.physics.getBodyHandle(memberEntity(members, 1))).toBe(second);
    expect(group.retireStep().ok).toBe(false);
    group.accept(false, c.source(members, false)).unwrap();
    expect(c.hit()).toBeUndefined();
    group.accept(true, c.source(members, true)).unwrap();
    expect(c.hit()).toBe(memberEntity(members, 0));
    group.accept(false, c.source(members, false)).unwrap();
    expect(c.hit()).toBeUndefined();
    c.sync();
    c.physics.step(1 / 60);
    expect(c.hit()).toBeUndefined();
    expect(c.physics.getBodyCount()).toBe(2);
    expect(group.retireStep().unwrap()).toMatchObject({ phase: 'retiring', remaining: 1 });
    expect(c.physics.getBodyCount()).toBe(1);
    c.sync();
    expect(group.retireStep().unwrap().phase).toBe('retired');
    expect(c.physics.getBodyCount()).toBe(0);
  } finally {
    c.physics.dispose();
  }
});

test('changed fixed source invalidates partial preparation and still permits no-frame retirement', () => {
  const c = setup();
  let current = true;
  try {
    const members = [c.spawn(), c.spawn(4)].map((entity) => ({ entity, participates: true }));
    const group = c.physics
      ._beginStaticResidency(c.world, members, () => (current ? ok(undefined) : err('changed')))
      .unwrap();
    group.prepareStep().unwrap();
    current = false;
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-stale');
    expect(group.retireStep().unwrap().phase).toBe('retiring');
    expect(c.physics.getBodyCount()).toBe(0);
    c.sync();
    expect(group.retireStep().unwrap().phase).toBe('retired');
  } finally {
    c.physics.dispose();
  }
});

test('expected source rejection keeps the prepared native roster; native queries cannot reenter acceptance', () => {
  const c = setup();
  try {
    const members = [{ entity: c.spawn(), participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    expect(errorOf(group.accept(true, () => err('source refused'))).code).toBe(
      'static-residency-invalid',
    );
    expect(group.inspect().phase).toBe('prepared');
    group
      .accept(true, () => {
        expect(() => c.hit()).toThrow('reenter native execution');
        return c.source(members, true)();
      })
      .unwrap();
  } finally {
    c.physics.dispose();
  }
});

test('a partial source acceptance faults native execution instead of pretending rollback', () => {
  const c = setup();
  try {
    const members = [c.spawn(), c.spawn(4)].map((entity) => ({ entity, participates: true }));
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    const result = group.accept(true, () => {
      c.world.removeComponent(memberEntity(members, 0), Disabled).unwrap();
      return ok(undefined);
    });
    expect(errorOf(result).code).toBe('static-residency-fault');
    expect(c.world.hasComponent(memberEntity(members, 0), Disabled)).toBe(false);
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    raw.step = () => {
      steps++;
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(0);
    expect(() => c.hit()).toThrow();
    expect(errorOf(group.retireStep()).code).toBe('static-residency-fault');
    expect(group.inspect().participation).toBe('unconfirmed');
  } finally {
    c.physics.dispose();
  }
});

test('static participation can count a larger Scene roster without owning its visual members', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    const visual = c.world
      .spawn({ component: Transform, data: {} }, { component: Disabled, data: {} })
      .unwrap();
    const members = [{ entity, participates: true }];
    const group = c.physics
      ._beginStaticResidency(c.world, members, () => ok(undefined), 2)
      .unwrap();
    c.prepare(group);
    const fullScene = [...members, { entity: visual, participates: true }];
    group.accept(true, c.source(fullScene, true)).unwrap();
    expect(c.hit()).toBe(entity);
    expect(c.physics.hasBody(visual)).toBe(false);
    group.accept(false, c.source(fullScene, false)).unwrap();
    expect(c.hit()).toBeUndefined();
    expect(c.world.hasComponent(visual, Disabled)).toBe(true);
  } finally {
    c.physics.dispose();
  }
});

test('static acceptance rejects an unrelated structural change during its source transition', () => {
  const c = setup();
  try {
    const members = [{ entity: c.spawn(), participates: true }];
    const unrelated = c.spawn(20);
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    const result = group.accept(true, () => {
      c.source(members, true)().unwrap();
      c.world.removeComponent(unrelated, Disabled).unwrap();
      return ok(undefined);
    });
    expect(errorOf(result).code).toBe('static-residency-fault');
    expect(group.inspect().participation).toBe('unconfirmed');
  } finally {
    c.physics.dispose();
  }
});

test('retirement of a stale group cannot remove a replacement native identity', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    c.prepare(group);
    const old = c.physics.getBodyHandle(entity);
    c.physics.removeEntity(entity);
    c.physics.ensureBody(
      entity,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      {
        type: RigidBodyTypeValue.static,
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 1,
        ccdEnabled: 0,
      },
      undefined,
    );
    expect(c.physics.getBodyHandle(entity)).not.toBe(old);
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-stale');
    group.retireStep().unwrap();
    expect(c.physics.hasBody(entity)).toBe(true);
  } finally {
    c.physics.dispose();
  }
});

test('unsupported static roster and failed native creation publish no resident body', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    c.world
      .addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
      .unwrap();
    expect(
      errorOf(
        c.physics._beginStaticResidency(c.world, [{ entity, participates: true }], () =>
          ok(undefined),
        ),
      ).code,
    ).toBe('static-residency-invalid');
    c.world.removeComponent(entity, RigidBody).unwrap();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    const raw = c.physics.raw as NativeWorld;
    const original = raw.createCollider;
    raw.createCollider = () => {
      throw new Error('injected native allocation');
    };
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-fault');
    raw.createCollider = original;
    expect(c.physics.getBodyCount()).toBe(0);
    expect(errorOf(group.retireStep()).code).toBe('static-residency-fault');
  } finally {
    c.physics.dispose();
  }
});

test('owner disposal closes pending groups and old tokens without another frame', () => {
  const c = setup();
  const group = c.physics
    ._beginStaticResidency(c.world, [{ entity: c.spawn(), participates: true }], () =>
      ok(undefined),
    )
    .unwrap();
  c.prepare(group);
  c.physics.dispose();
  expect(group.inspect().phase).toBe('closed');
  expect(errorOf(group.prepareStep()).code).toBe('static-residency-closed');
  expect(errorOf(group.accept(true, () => ok(undefined))).code).toBe('static-residency-closed');
  expect(group.retireStep().unwrap().phase).toBe('closed');
});

test.each([
  'source',
  'Disabled',
  'descriptor',
])('active %s invalidation blocks native progress and partial retirement', (change) => {
  const c = setup();
  let current = true;
  try {
    const entity = c.spawn();
    const members = [{ entity, participates: true }];
    const group = c.physics
      ._beginStaticResidency(c.world, members, () =>
        current ? ok(undefined) : err('source changed'),
      )
      .unwrap();
    c.prepare(group);
    group.accept(true, c.source(members, true)).unwrap();
    if (change === 'source') current = false;
    else if (change === 'Disabled')
      c.world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    else c.world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
    expect(() => c.sync()).toThrow();
    expect(errorOf(group.retireStep()).code).toBe('static-residency-invalid');
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    raw.step = () => {
      steps++;
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(0);
    expect(() => c.hit()).toThrow();
  } finally {
    c.physics.dispose();
  }
});

test('changed-back inputs fail their original member guard while unrelated moving rows do not', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    const unrelated = c.spawn(20);
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    c.world.set(unrelated, Transform, { pos: [21, 0, 0] }).unwrap();
    group.prepareStep().unwrap();
    c.world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
    c.world.set(entity, Transform, { pos: [0, 0, 0] }).unwrap();
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-stale');
    group.retireStep().unwrap();
  } finally {
    c.physics.dispose();
  }
});

test('native context detach closes and removes residents without a fixed tick', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    c.prepare(group);
    c.physics.clearEcsContext(c.world);
    expect(group.inspect().phase).toBe('closed');
    expect(c.physics.getBodyCount()).toBe(0);
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-closed');
  } finally {
    c.physics.dispose();
  }
});

test.each([
  'after-body',
  'after-collider',
])('native allocation failure %s cleans actual raw bodies and colliders', (point) => {
  const c = setup();
  try {
    const entity = c.spawn();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    const raw = c.physics.raw as NativeWorld;
    const create = raw.createRigidBody;
    raw.createRigidBody = function (description) {
      const body = create.call(this, description);
      if (point === 'after-body')
        body.setAdditionalSolverIterations = () => {
          throw new Error('injected post-body allocation');
        };
      else
        body.setAdditionalMass = () => {
          throw new Error('injected post-collider allocation');
        };
      return body;
    };
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-fault');
    let bodies = 0,
      colliders = 0;
    raw.forEachRigidBody(() => {
      bodies++;
    });
    raw.forEachCollider(() => {
      colliders++;
    });
    expect({ bodies, colliders }).toEqual({ bodies: 0, colliders: 0 });
    expect(c.physics.getBodyCount()).toBe(0);
    expect(errorOf(group.retireStep()).code).toBe('static-residency-fault');
    c.physics.dispose();
    expect(group.inspect().phase).toBe('closed');
  } finally {
    c.physics.dispose();
  }
});

test.each([
  ColliderShapeValue.sphere,
  ColliderShapeValue.capsule,
])('static shape %i is prepared disabled and actually enters native queries', (shape) => {
  const c = setup();
  try {
    const entity = c.spawn();
    c.world.set(entity, Collider, { shape, radius: 0.7, halfHeight: 0.5 }).unwrap();
    const members = [{ entity, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.physics.step(1 / 60);
    expect(c.hit()).toBeUndefined();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.hit()).toBe(entity);
  } finally {
    c.physics.dispose();
  }
});

test('two prepared trimeshes share the cooked Mesh and preserve its real lifetime through staggered retirement', () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  try {
    const geometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
      .unwrap();
    const a = c.spawn(),
      b = c.spawn(5);
    for (const entity of [a, b])
      c.world.set(entity, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    const members = [a, b].map((entity) => ({ entity, participates: true }));
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    assets.release(mesh).unwrap();
    expect(c.hit()).toBeUndefined();
    expect(c.hit(5)).toBeUndefined();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.hit()).toBe(a);
    expect(c.hit(5)).toBe(b);
    group.accept(false, c.source(members, false)).unwrap();
    group.retireStep().unwrap();
    c.world.despawn(a).unwrap();
    expect(assets.read(mesh).ok).toBe(true);
    c.sync();
    group.retireStep().unwrap();
    expect(assets.read(mesh).ok).toBe(true);
    c.world.despawn(b).unwrap();
    expect(assets.read(mesh).ok).toBe(false);
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});

test('stopping a resident static body clears actual overlap participation and emits one stopped fact', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    const ball = c.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    const members = [{ entity, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    const started = c.physics.drainCollisionEvents().filter((event) => event.type === 'started');
    expect(
      started.some(
        (event) =>
          [event.entityA, event.entityB].includes(ball) &&
          [event.entityA, event.entityB].includes(entity),
      ),
    ).toBe(true);
    group.accept(false, c.source(members, false)).unwrap();
    const stopped = c.physics.drainCollisionEvents().filter((event) => event.type === 'stopped');
    expect(stopped).toHaveLength(1);
    c.physics.step(1 / 60);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'stopped'),
    ).toHaveLength(0);
  } finally {
    c.physics.dispose();
  }
});

test('activation, stop and reactivation refresh native shape and character queries before a simulation step', () => {
  const c = setup();
  try {
    const floor = c.spawn();
    const character = c.world
      .spawn(
        { component: Transform, data: { pos: [0, 3, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.25 } },
        { component: CharacterController, data: {} },
      )
      .unwrap();
    c.physics.setMoveContext(c.world, Transform);
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    const raw = c.physics.raw as NativeWorld;
    const shapeHit = () =>
      raw
        .intersectionWithShape(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0, w: 1 },
          new rapier.Ball(0.1),
        )
        ?.parent()?.userData;
    let steps = 0;
    const step = raw.step;
    raw.step = function (...args) {
      steps++;
      return step.apply(this, args);
    };
    for (const active of [true, false, true]) {
      c.physics.teleport(character, vec3.create(0, 3, 0));
      group.accept(active, c.source(members, active)).unwrap();
      expect(shapeHit()).toBe(active ? floor : undefined);
      const motion = c.physics.moveAndSlide(character, vec3.create(0, -3, 0), {
        bodyMotion: 'frozen',
      });
      if (active) expect(motion[1]).toBeGreaterThan(-2);
      else expect(motion[1]).toBeCloseTo(-3, 4);
      expect(steps).toBe(0);
    }
  } finally {
    c.physics.dispose();
  }
});

test('known invalid inactive inputs reject before native creation and leave the running World healthy', () => {
  const c = setup();
  try {
    const entity = c.spawn();
    c.world.set(entity, Transform, { scale: [0, 1, 1] }).unwrap();
    expect(
      errorOf(
        c.physics._beginStaticResidency(c.world, [{ entity, participates: true }], () =>
          ok(undefined),
        ),
      ).code,
    ).toBe('static-residency-invalid');
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    const step = raw.step;
    raw.step = function (...args) {
      steps++;
      return step.apply(this, args);
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(1);
    expect(c.physics.getBodyCount()).toBe(0);
  } finally {
    c.physics.dispose();
  }
});

test.each([
  'cuboid',
  'trimesh',
])('zero-tick stop/reactivate restores actual %s contacts and logical start once', (shape) => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  try {
    const floor = c.spawn();
    if (shape === 'trimesh') {
      const geometry = createBoxGeometry(2, 2, 2).unwrap();
      const mesh = assets
        .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
        .unwrap();
      c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
      assets.release(mesh).unwrap();
    }
    const ball = c.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.physics.getCollisionPairs().get(floor)?.has(ball)).toBe(true);
    c.physics.drainCollisionEvents();
    group.accept(false, c.source(members, false)).unwrap();
    expect(c.physics.getCollisionPairs().get(floor)?.has(ball)).toBe(false);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'stopped'),
    ).toHaveLength(1);
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.physics.getCollisionPairs().get(floor)?.has(ball)).toBe(true);
    expect(c.physics.getCollisionPairs().get(ball)?.has(floor)).toBe(true);
    c.physics.finalizeDerivedFixedStep();
    expect(
      c.physics
        .getCurrentContacts(ball)
        .unwrap()
        .manifolds.some((manifold) => manifold.other === floor),
    ).toBe(true);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'started'),
    ).toHaveLength(1);
    const observations = c.physics.getContactObservations();
    expect(
      observations.filter(
        (observation) =>
          observation.phase === 'started' &&
          [observation.entityA, observation.entityB].includes(floor),
      ),
    ).toHaveLength(2);
    c.physics.step(1 / 60);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'started'),
    ).toHaveLength(0);
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});

test.each([
  'nan-pose',
  'overflow',
  'shared-overflow',
])('native %s bounds reject the whole roster before participation changes', (reason) => {
  const c = setup();
  try {
    const raw = c.physics.raw as NativeWorld;
    const first = raw.createRigidBody(rapier.RigidBodyDesc.fixed().setEnabled(false));
    raw.createCollider(rapier.ColliderDesc.cuboid(1, 1, 1), first);
    const second = raw.createRigidBody(
      rapier.RigidBodyDesc.fixed()
        .setEnabled(false)
        .setTranslation(reason === 'nan-pose' ? Number.NaN : 3e38, 0, 0),
    );
    if (reason === 'shared-overflow') {
      const geometry = raw.colliders.createSharedGeometry(new rapier.Cuboid(1, 1, 1));
      raw.createCollider(
        new rapier.ColliderDesc({ type: 'shared', geometry, scale: { x: 1e38, y: 1, z: 1 } }),
        second,
      );
    } else
      raw.createCollider(
        rapier.ColliderDesc.cuboid(reason === 'overflow' ? 1e38 : 1, 1, 1),
        second,
      );
    expect(
      raw.setStaticBodyParticipation(
        new Float64Array([first.handle, second.handle]),
        new Uint8Array([1, 1]),
      ),
    ).toBe(false);
    expect(first.isEnabled()).toBe(false);
    expect(second.isEnabled()).toBe(false);
    expect(c.hit()).toBeUndefined();
  } finally {
    c.physics.dispose();
  }
});

test('static acceptance fault blocks queued derived commits before any native step work', () => {
  const c = setup();
  try {
    const other = c.spawn(10);
    c.world.removeComponent(other, Disabled).unwrap();
    c.sync();
    const members = [c.spawn(), c.spawn(5)].map((entity) => ({ entity, participates: true }));
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    let commits = 0;
    const candidate = c.physics
      .prepareDerivedShapeCandidate({
        entity: other,
        sourceKey: 'queued',
        revision: 1,
        bodyType: 'static',
        shapes: [
          {
            kind: 'convex-compound',
            id: 'queued-box',
            revision: 1,
            pieces: [boxPoints([-1, -1, -1], [1, 1, 1])],
          },
        ],
        massProperties: { mode: 'automatic', density: 1 },
      })
      .unwrap();
    c.physics
      .admitDerivedShapeCandidate(candidate, () => {
        commits++;
        return ok(undefined);
      })
      .unwrap();
    expect(
      errorOf(
        group.accept(true, () => {
          c.world.removeComponent(memberEntity(members, 0), Disabled).unwrap();
          return ok(undefined);
        }),
      ).code,
    ).toBe('static-residency-fault');
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    raw.step = () => {
      steps++;
    };
    c.physics.step(1 / 60);
    expect(commits).toBe(0);
    expect(steps).toBe(0);
  } finally {
    c.physics.dispose();
  }
});

test('finite overflowing native bounds reject the inactive candidate without poisoning the old World', () => {
  const c = setup();
  try {
    const entity = c.spawn(3e38);
    c.world.set(entity, Collider, { halfExtents: [1e38, 1, 1] }).unwrap();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity, participates: true }], () => ok(undefined))
      .unwrap();
    expect(errorOf(group.prepareStep()).code).toBe('static-residency-invalid');
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    const step = raw.step;
    raw.step = function (...args) {
      steps++;
      return step.apply(this, args);
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(1);
    expect(c.hit()).toBeUndefined();
    expect(group.retireStep().unwrap().phase).toBe('retired');
  } finally {
    c.physics.dispose();
  }
});

test.each([
  'retire',
  'detach',
  'native-remove',
])('stopped contact work retires without a future tick on %s', (cleanup) => {
  const c = setup();
  try {
    const floor = c.spawn();
    c.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    group.accept(false, c.source(members, false)).unwrap();
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(1);
    if (cleanup === 'retire') group.retireStep().unwrap();
    else if (cleanup === 'detach') c.physics.clearEcsContext(c.world);
    else c.physics.removeEntity(floor);
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(0);
    expect(c.physics.hasBody(floor)).toBe(false);
  } finally {
    c.physics.dispose();
  }
});

test.each([
  'solid',
  'sensor',
  'spatial-groups',
])('zero-tick contact repair preserves %s counterpart identity and normal event deduplication', (kind) => {
  const c = setup();
  try {
    c.physics.setGravity(vec3.create());
    const floor = c.spawn();
    if (kind === 'spatial-groups')
      c.world.set(floor, Collider, { halfExtents: [20, 1, 1] }).unwrap();
    const other = c.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, lockRotation: true } },
      )
      .unwrap();
    if (kind !== 'spatial-groups')
      c.world
        .addComponent(other, {
          component: Collider,
          data: { shape: ColliderShapeValue.sphere, radius: 0.3, isSensor: kind === 'sensor' },
        })
        .unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    if (kind === 'spatial-groups') {
      const candidate = c.physics
        .prepareDerivedShapeCandidate({
          entity: other,
          sourceKey: 'grouped',
          revision: 1,
          bodyType: 'dynamic',
          massProperties: {
            mode: 'explicit',
            mass: 43,
            centerOfMass: [0, 0, 0],
            principalInertia: [8, 9, 10],
          },
          shapes: [
            {
              id: 'original',
              kind: 'convex-compound',
              nativeLayout: 'spatial-groups-16',
              revision: 1,
              pieces: Array.from({ length: 33 }, (_, index) =>
                boxPoints([index * 2 - 0.3, -0.3, -0.3], [index * 2 + 0.3, 0.3, 0.3]),
              ),
            },
          ],
        })
        .unwrap();
      c.physics.admitDerivedShapeCandidate(candidate).unwrap();
      c.physics.step(1 / 60);
      expect(
        (c.physics.raw as NativeWorld)
          .getRigidBody(c.physics.getBodyHandle(other) as number)
          .numColliders(),
      ).toBeGreaterThan(1);
    }
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.physics.getCollisionPairs().get(floor)?.has(other)).toBe(true);
    c.physics.drainCollisionEvents();
    group.accept(false, c.source(members, false)).unwrap();
    c.physics.drainCollisionEvents();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.physics.getCollisionPairs().get(floor)?.has(other)).toBe(true);
    const started = c.physics.drainCollisionEvents().filter((event) => event.type === 'started');
    expect(started).toHaveLength(1);
    if (kind === 'spatial-groups') {
      expect(started[0]).toMatchObject({ entityA: floor, entityB: other, shapeB: 'original' });
      const restored = c.physics.getContactObservations().at(-1);
      expect(restored).toMatchObject({
        phase: 'started',
        entityA: floor,
        entityB: other,
        shapeB: 'original',
      });
    }
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(0);
    c.physics.step(1 / 60);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'started'),
    ).toHaveLength(0);
    if (kind === 'spatial-groups') {
      c.physics.teleport(other, vec3.create(8, 1.2, 0));
      c.physics.step(1 / 60);
      expect(c.physics.getCollisionPairs().get(floor)?.has(other)).toBe(true);
      expect(
        c.physics.drainCollisionEvents().filter((event) => event.type === 'stopped'),
      ).toHaveLength(0);
      c.physics.teleport(other, vec3.create(100, 1.2, 0));
      c.physics.step(1 / 60);
      expect(c.physics.getCollisionPairs().get(floor)?.has(other)).toBe(false);
      const stopped = c.physics.drainCollisionEvents().filter((event) => event.type === 'stopped');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toMatchObject({ entityA: floor, entityB: other, shapeB: 'original' });
    }
  } finally {
    c.physics.dispose();
  }
});

test('a replaced contact body clears old-generation work and normal started restores the new pair once', () => {
  const c = setup();
  try {
    const floor = c.spawn();
    const other = c.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    c.sync();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    c.physics.drainCollisionEvents();
    const old = c.physics.getBodyHandle(other);
    group.accept(false, c.source(members, false)).unwrap();
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(1);
    c.physics.removeEntity(other);
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(0);
    c.world.set(other, Transform, { pos: [0, 1.2, 0] }).unwrap();
    c.sync();
    expect(c.physics.getBodyHandle(other)).not.toBe(old);
    c.physics.drainCollisionEvents();
    group.accept(true, c.source(members, true)).unwrap();
    c.physics.step(1 / 60);
    expect(c.physics.getCollisionPairs().get(floor)?.has(other)).toBe(true);
    expect(
      c.physics.drainCollisionEvents().filter((event) => event.type === 'started'),
    ).toHaveLength(1);
    expect(c.physics._inspectStaticResidency().pendingContactPairs).toBe(0);
  } finally {
    c.physics.dispose();
  }
});

test.each([
  'retire',
  'detach',
])('unknown native %s failure keeps release unconfirmed and blocks solver work', (operation) => {
  const c = setup();
  try {
    const floor = c.spawn();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity: floor, participates: true }], () => ok(undefined))
      .unwrap();
    c.prepare(group);
    const raw = c.physics.raw as NativeWorld;
    const remove = raw.removeRigidBody;
    raw.removeRigidBody = () => {
      throw new Error('injected native removal failure');
    };
    if (operation === 'retire')
      expect(errorOf(group.retireStep()).code).toBe('static-residency-fault');
    else expect(() => c.physics.clearEcsContext(c.world)).toThrow('native detach');
    expect(group.inspect()).toMatchObject({ phase: 'failed', participation: 'unconfirmed' });
    expect(c.physics.hasBody(floor)).toBe(true);
    let steps = 0;
    raw.step = () => {
      steps++;
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(0);
    expect(errorOf(group.retireStep()).code).toBe('static-residency-fault');
    raw.removeRigidBody = remove;
    c.physics.dispose();
    expect(group.inspect()).toMatchObject({ phase: 'closed', participation: 'inactive' });
  } finally {
    c.physics.dispose();
  }
});

test('prepared readiness waits for the captured Mesh version in the existing shared native cache', () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  try {
    const oldGeometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...oldGeometry, collision: buildMeshCollision(oldGeometry).unwrap() })
      .unwrap();
    const ordinary = c.spawn(20);
    c.world.set(ordinary, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    c.world.removeComponent(ordinary, Disabled).unwrap();
    c.sync();
    const nextGeometry = createBoxGeometry(4, 2, 2).unwrap();
    assets
      .replace(mesh, { ...nextGeometry, collision: buildMeshCollision(nextGeometry).unwrap() })
      .unwrap();
    const floor = c.spawn();
    c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    expect(group.prepareStep().unwrap().phase).toBe('preparing');
    expect(c.physics.getBodyCount()).toBe(1);
    expect(c.hit(1.5)).toBeUndefined();
    // The existing ordinary fixed-sync owner accepts the shared root; preparation must not force it early.
    c.sync();
    expect(group.prepareStep().unwrap().phase).toBe('prepared');
    group.accept(true, c.source(members, true)).unwrap();
    expect(c.hit(1.5)).toBe(floor);
    expect(c.physics.getBodyCount()).toBe(2);
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});

test('Source acceptance cannot replace a captured Mesh and still accept the prior native version', () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  try {
    const geometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
      .unwrap();
    const floor = c.spawn();
    c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    const members = [{ entity: floor, participates: true }];
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    c.prepare(group);
    const result = group.accept(true, () => {
      c.source(members, true)().unwrap();
      const changed = createBoxGeometry(4, 2, 2).unwrap();
      assets
        .replace(mesh, { ...changed, collision: buildMeshCollision(changed).unwrap() })
        .unwrap();
      return ok(undefined);
    });
    expect(errorOf(result).code).toBe('static-residency-fault');
    expect(group.inspect().participation).toBe('unconfirmed');
    expect(c.world.hasComponent(floor, Disabled)).toBe(false);
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    raw.step = () => {
      steps++;
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(0);
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});

test('old cached bounds cannot reject the captured newer Mesh before its ordinary native adoption', () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  try {
    const oldGeometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...oldGeometry, collision: buildMeshCollision(oldGeometry).unwrap() })
      .unwrap();
    const ordinary = c.spawn(20);
    c.world.set(ordinary, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    c.world.removeComponent(ordinary, Disabled).unwrap();
    c.sync();
    const changed = createBoxGeometry(2e-20, 2, 2).unwrap();
    assets.replace(mesh, { ...changed, collision: buildMeshCollision(changed).unwrap() }).unwrap();
    const floor = c.spawn(3e38);
    c.world.set(floor, Transform, { scale: [1e38, 1, 1] }).unwrap();
    c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity: floor, participates: true }], () => ok(undefined))
      .unwrap();
    expect(group.prepareStep().unwrap().phase).toBe('preparing');
    c.sync();
    expect(group.prepareStep().unwrap().phase).toBe('prepared');
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});

test('inactive Mesh invalidation settles the candidate while the actual fixed World keeps advancing', async () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  const context = await createWorldContext(c.world, [scenePlugin()]);
  c.world.insertResource(PhysicsWorldResource, c.physics);
  const release = registerPhysicsSystems(c.world);
  try {
    const geometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
      .unwrap();
    const floor = c.spawn();
    c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    const player = c.world
      .spawn(
        { component: Transform, data: { pos: [10, 4, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    const group = c.physics
      ._beginStaticResidency(c.world, [{ entity: floor, participates: true }], () => ok(undefined))
      .unwrap();
    c.prepare(group);
    const changed = createBoxGeometry(4, 2, 2).unwrap();
    assets.replace(mesh, { ...changed, collision: buildMeshCollision(changed).unwrap() }).unwrap();
    expect(c.world.update(1 / 60).ok).toBe(true);
    expect(group.inspect()).toMatchObject({ phase: 'failed', participation: 'inactive' });
    expect(c.physics._inspectStaticResidency().faulted).toBe(false);
    const first = c.world.get(player, Transform).unwrap().pos[1];
    c.world.update(1 / 60).unwrap();
    expect(c.world.get(player, Transform).unwrap().pos[1]).toBeLessThan(first as number);
    expect(group.retireStep().unwrap().phase).toBe('retired');
    c.world.despawn(floor).unwrap();
    c.world.despawn(player).unwrap();
  } finally {
    release();
    c.physics.dispose();
    await context.fiber.dispose();
    assets.dispose();
  }
});

test('Mesh change observation retires without a tick and unchanged preparation does not rescan all revisions', () => {
  const assets = new AssetRegistry();
  const c = setup(assets);
  const records = runtimeAssets(assets);
  const version = records.version;
  try {
    const members = Array.from({ length: 16 }, (_, index) => {
      const geometry = createBoxGeometry(2, 2, 2).unwrap();
      const mesh = assets
        .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
        .unwrap();
      const entity = c.spawn(index * 4);
      c.world.set(entity, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
      return { entity, participates: true };
    });
    const group = c.physics._beginStaticResidency(c.world, members, () => ok(undefined)).unwrap();
    let reads = 0;
    records.version = function (handle) {
      reads++;
      return version.call(this, handle);
    };
    for (let step = 0; step < members.length; step++) group.prepareStep().unwrap();
    expect(group.inspect().phase).toBe('prepared');
    expect(reads).toBeLessThanOrEqual(members.length * 3);
    expect(records.inspect().observers).toBe(2);
    for (let step = 0; step < members.length; step++) group.retireStep().unwrap();
    expect(records.inspect().observers).toBe(1);
    c.physics.dispose();
    expect(records.inspect().observers).toBe(0);
  } finally {
    records.version = version;
    c.physics.dispose();
    assets.dispose();
  }
});

test('Mesh observation capacity rejection is local and allocates no candidate native body', () => {
  const assets = new AssetRegistry({ limits: { maxObservers: 1 } });
  const c = setup(assets);
  try {
    const geometry = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = assets
      .create({ ...geometry, collision: buildMeshCollision(geometry).unwrap() })
      .unwrap();
    const floor = c.spawn();
    c.world.set(floor, Collider, { shape: ColliderShapeValue.trimesh, mesh }).unwrap();
    expect(
      errorOf(
        c.physics._beginStaticResidency(c.world, [{ entity: floor, participates: true }], () =>
          ok(undefined),
        ),
      ).code,
    ).toBe('static-residency-invalid');
    expect(c.physics._inspectStaticResidency()).toMatchObject({
      groups: 0,
      residents: 0,
      faulted: false,
    });
    expect(c.physics.getBodyCount()).toBe(0);
    const raw = c.physics.raw as NativeWorld;
    let steps = 0;
    const step = raw.step;
    raw.step = function (...args) {
      steps++;
      return step.apply(this, args);
    };
    c.physics.step(1 / 60);
    expect(steps).toBe(1);
  } finally {
    c.physics.dispose();
    assets.dispose();
  }
});
