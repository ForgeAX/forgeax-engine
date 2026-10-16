import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '@forgeax/engine-physics-rapier3d';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { statePlugin } from '@forgeax/engine/state';
import { expect, test } from 'vitest';
import {
  Projectile,
  ProjectileCover,
  PROJECTILE_ALLEGIANCE_PLAYER,
} from '../../../apps/game-capability-lab/assets/plugins/components/gameplay';
import { installGameplayState } from '../../../apps/game-capability-lab/assets/plugins/gameplay-state';
import { installProjectileImpactSystem } from '../../../apps/game-capability-lab/assets/plugins/projectile-impact';

const outputDirectory = process.env.FORGEAX_SENTINEL_RED_DIR;

function persist(lines: readonly string[]): void {
  if (outputDirectory === undefined) return;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'probe.log'), `${lines.join('\n')}\n`);
}

test('public Rapier3D contact reaches the shared projectile owner', async ({ onTestFinished }) => {
  const lines: string[] = [];
  const rapier = await loadRapier3D();
  if ('code' in rapier) {
    const line = `PUBLIC_PHYSICS_CONTACT=environment code=${rapier.code}`;
    lines.push(line);
    persist(lines);
    throw new Error(line);
  }

  const world = new World();
  const physics = createRapier3DPhysicsWorld(rapier);
  const context = await createWorldContext(world, [scenePlugin(), statePlugin()]);
  world.insertResource('PhysicsWorld', physics);
  const releasePhysics = registerPhysicsSystems(world);
  const ownedEntities: EntityHandle[] = [];
  onTestFinished(async () => {
    for (const entity of ownedEntities)
      if (world.get(entity, Transform).ok) world.despawn(entity).unwrap();
    releasePhysics();
    await context.fiber.dispose();
    physics.dispose();
  });
  installGameplayState({ context, world, reset: () => {} });

  const source = world.spawn({ component: Transform, data: { pos: [0, 0.6, -2] } }).unwrap();
  ownedEntities.push(source);
  const player = world.spawn({ component: Transform, data: { pos: [4, 0.6, 0] } }).unwrap();

  ownedEntities.push(player);
  const projectile = world.spawn(
    { component: Transform, data: { pos: [0, 0.6, 0] } },
    {
      component: RigidBody,
      data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true },
    },
    {
      component: Collider,
      data: { shape: ColliderShapeValue.sphere, radius: 0.2 },
    },
    { component: CollidingEntities, data: { entities: [] } },
    {
      component: Projectile,
      data: {
        age: 0,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 10,
        life: 2.5,
        impactScale: 1,
        source,
        allegiance: PROJECTILE_ALLEGIANCE_PLAYER,
      },
    },
  ).unwrap();
  ownedEntities.push(projectile);
  const cover = world.spawn(
    { component: Transform, data: { pos: [0, 0.6, 0] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    {
      component: Collider,
      data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.4, 0.8, 0.3] },
    },
    { component: CollidingEntities, data: { entities: [] } },
    { component: ProjectileCover, data: {} },
  ).unwrap();

  ownedEntities.push(cover);
  let coverBlocked = 0;
  let observedContacts: readonly number[] = [];
  let bodiesReady = false;
  installProjectileImpactSystem({
    world,
    player,
    projectileEntities: () => world.get(projectile, Projectile).ok ? [projectile] : [],
    barrierEntity: undefined,
    barrierRoute: undefined,
    counterattack: undefined,
    admitTarget: () => {},
    onCoverImpact: () => {},
    consume: (entity) => {
      observedContacts = world.get(entity, CollidingEntities).unwrap().entities;
      bodiesReady = physics.hasBody(entity) && physics.hasBody(cover);
      world.despawn(entity).unwrap();
    },
    onOutcome: (_source, outcome) => {
      if (outcome === 'cover-blocked') coverBlocked += 1;
    },
    onTargetResolved: () => {},
    after: ['physicsCollisionSync'],
    before: [],
  });

  for (let step = 0; step < 8; step++) world.update(1 / 60).unwrap();

  const hasContact = observedContacts.includes(cover);
  if (!bodiesReady || !hasContact) {
    const line = `PUBLIC_PHYSICS_CONTACT=fail bodiesReady=${bodiesReady} projectile=${projectile} cover=${cover} contacts=${JSON.stringify([...observedContacts])}`;
    lines.push(line);
    persist(lines);
    expect({ bodiesReady, hasContact }).toEqual({ bodiesReady: true, hasContact: true });
    return;
  }

  lines.push(`PUBLIC_PHYSICS_CONTACT=pass bodiesReady=true projectile=${projectile} cover=${cover} contacts=${JSON.stringify([...observedContacts])}`);
  const consumed = !world.get(projectile, Projectile).ok;
  lines.push(`PUBLIC_PROJECTILE_OWNER=pass consumed=${consumed} coverBlocked=${coverBlocked}`);
  persist(lines);
  for (const line of lines) console.info(line);
  expect({ consumed, coverBlocked }).toEqual({ consumed: true, coverBlocked: 1 });
});
