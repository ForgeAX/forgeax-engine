import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { Collider, RigidBody, registerPhysicsComponents } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  physics.setGravity(vec3.create(0, 0, 0));
  const body = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic().setCcdEnabled(true));
  body.userData = 2;
  physics.registerBody(2, body.handle);
  const input = (revision: number) => ({
    entity: 2,
    revision,
    sourceKey: 'debris:2',
    bodyType: 'dynamic' as const,
    shapes: [
      {
        id: 'piece',
        revision,
        kind: 'convex-compound' as const,
        pieces: [boxPoints([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5])],
      },
    ],
    massProperties: { mode: 'automatic' as const, density: 1 },
  });
  physics
    .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input(7)).unwrap())
    .unwrap();
  physics.step(1 / 60);
  return { R, physics, body, input };
}

it('sleeps the actual Native body and preserves derived source, type, colliders, CCD and ray hits', async () => {
  const { physics, body } = await fixture();
  try {
    const publication = physics.getDerivedPublication(2);
    const handles = Array.from({ length: body.numColliders() }, (_, i) => body.collider(i).handle);
    const before = physics.getBodyMotion(2).unwrap();
    physics.sleepBody(2).unwrap();
    expect(body.isSleeping()).toBe(true);
    expect(physics.getBodyMotion(2).unwrap()).toEqual({ ...before, sleeping: true });
    expect(physics.getDerivedPublication(2)).toEqual(publication);
    expect(physics.getDerivedBodyType(2)).toBe('dynamic');
    expect(body.isCcdEnabled()).toBe(true);
    expect(Array.from({ length: body.numColliders() }, (_, i) => body.collider(i).handle)).toEqual(
      handles,
    );
    expect(body.collider(0).isEnabled()).toBe(true);
    expect(physics.raycast(vec3.create(-4, 0, 0), vec3.create(1, 0, 0), 8)?.entity).toBe(2);
    expect(physics.getCurrentContacts(2).ok).toBe(false);
    physics.sleepBody(2).unwrap();
    physics.wakeBody(2).unwrap();
    expect(body.isSleeping()).toBe(false);
  } finally {
    physics.dispose();
  }
});

it('retains collision eligibility and wakes through an actual moving-body contact', async () => {
  const { R, physics, body } = await fixture();
  try {
    physics.sleepBody(2).unwrap();
    const mover = physics.raw.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(-3, 0, 0).setLinvel(12, 0, 0),
    );
    mover.userData = 3;
    physics.registerBody(3, mover.handle);
    physics.raw.createCollider(R.ColliderDesc.cuboid(0.25, 0.25, 0.25).setMass(2), mover);
    for (let i = 0; i < 24; i++) physics.step(1 / 60);
    expect(body.isSleeping()).toBe(false);
    expect(body.translation().x).toBeGreaterThan(0);
    expect(body.numColliders()).toBe(1);
  } finally {
    physics.dispose();
  }
});

it('wakes through the public external impulse without publishing or changing collision policy', async () => {
  const { physics, body } = await fixture();
  try {
    const publication = physics.getDerivedPublication(2);
    physics.sleepBody(2).unwrap();
    physics.applyBodyImpulse(2, [2, 0, 0]).unwrap();
    expect(body.isSleeping()).toBe(false);
    physics.step(1 / 60);
    expect(body.translation().x).toBeGreaterThan(0);
    expect(physics.getDerivedPublication(2)).toEqual(publication);
  } finally {
    physics.dispose();
  }
});

it('rejects Native execution and paired admission commands without sleeping the live body', async () => {
  const { physics, body, input } = await fixture();
  try {
    const original = physics.raw.step.bind(physics.raw);
    let executing = false,
      paired = false;
    physics.raw.step = (...args: unknown[]) => {
      executing = !physics.sleepBody(2).ok;
      original(...args);
    };
    physics.step(1 / 60);
    physics.raw.step = original;
    const candidate = physics.prepareDerivedShapeCandidate(input(8)).unwrap();
    physics
      .admitDerivedShapeCandidate(candidate, () => {
        paired = !physics.sleepBody(2).ok;
        return ok(undefined);
      })
      .unwrap();
    physics.step(1 / 60);
    expect(executing).toBe(true);
    expect(paired).toBe(true);
    expect(body.isSleeping()).toBe(false);
  } finally {
    physics.dispose();
  }
});

it('refuses retired entities and a disposed World without touching a recycled Native body', async () => {
  const { R, physics } = await fixture();
  for (const invalid of [NaN, Infinity, -1, 0.5])
    expect(physics.sleepBody(invalid)).toMatchObject({
      ok: false,
      error: { code: 'managed-body-missing' },
    });
  physics.removeEntity(2);
  const successor = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic());
  successor.userData = 33554434;
  physics.registerBody(33554434, successor.handle);
  expect(physics.sleepBody(2)).toMatchObject({
    ok: false,
    error: { code: 'managed-body-missing' },
  });
  expect(successor.isSleeping()).toBe(false);
  expect(physics.sleepBody(33554434).ok).toBe(true);
  physics.dispose();
  expect(physics.sleepBody(33554434)).toMatchObject({
    ok: false,
    error: { code: 'managed-physics-unavailable' },
  });
});

it('rejects a despawned ECS generation before Native reconciliation', async () => {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R),
    world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  const release = registerPhysicsComponents(world);
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: {} },
        { component: Collider, data: {} },
      )
      .unwrap();
  try {
    const old = spawn();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    expect(physics.hasBody(old)).toBe(true);
    world.despawn(old).unwrap();
    const current = spawn();
    expect(Number(current) === Number(old)).toBe(false);
    // Its old Native mapping is still retained until sync, but no command may use it.
    expect(physics.sleepBody(old)).toMatchObject({
      ok: false,
      error: { code: 'managed-body-missing' },
    });
    physics._syncFromEcs(world, Transform, GlobalTransform);
    expect(physics.sleepBody(old).ok).toBe(false);
    expect(physics.sleepBody(current).ok).toBe(true);
  } finally {
    physics.dispose();
    release();
  }
});
