// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/physics-rapier3d/__tests__/collision-event.test.ts
//   - packages/physics-rapier3d/__tests__/despawn-cleanup.test.ts
//   - packages/physics-rapier3d/__tests__/raycast-teleport.test.ts
//   - packages/physics-rapier3d/__tests__/tick-pipeline.test.ts
//   - packages/physics-rapier3d/__tests__/wasm-loader.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from __tests__/ into src/__tests__/; import paths adjusted (../src/xxx → ../xxx).

import { World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  PhysicsError,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import {
  ChildOf,
  GlobalTransform,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

function prepareWorld(): World {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  return world;
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture accepts the ECS spawn component tuple.
function spawnPairedEntity(world: World, ...components: any[]) {
  return world.spawn(...components);
}

function runPhysicsTicks(world: World, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Rapier exposes runtime WASM classes.
function rapierBodyFor(pw: any, entity: number): any | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Rapier exposes runtime WASM classes.
  let found: any | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: Rapier exposes runtime WASM classes.
  pw.raw.bodies.forEach((body: any) => {
    if (body.userData === entity) found = body;
  });
  return found;
}

{
  // ─── from collision-event.test.ts ───

  describe('collision-event.test.ts', () => {
    describe('feat-20260528 M2 t13 Rapier3D collision events', () => {
      it('two dynamic spheres fall and collide', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const b1 = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, -0.3),
        );
        b1.userData = 101;
        pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
          b1,
        );
        pw.registerBody(101, b1.handle);

        const b2 = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0.3));
        b2.userData = 102;
        pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
          b2,
        );
        pw.registerBody(102, b2.handle);

        for (let i = 0; i < 120; i++) {
          pw.step(1 / 60);
        }

        const pos1 = b1.translation();
        const pos2 = b2.translation();
        expect(pos1.y).toBeLessThan(1);
        expect(pos2.y).toBeLessThan(1);
      });

      it('userData can be read after setting', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));

        body.userData = 42;
        expect(body.userData).toBe(42);
      });

      it('ball bounces on ground without errors', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const ground = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
        ground.userData = 200;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setRestitution(0.3), ground);
        pw.registerBody(200, ground.handle);

        const ball = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        ball.userData = 201;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0.5), ball);
        pw.registerBody(201, ball.handle);

        for (let i = 0; i < 180; i++) {
          pw.step(1 / 60);
        }

        const pos = ball.translation();
        expect(pos.y).toBeLessThan(5);
      });
    });
  });
}

{
  // ─── from despawn-cleanup.test.ts ───

  describe('despawn-cleanup.test.ts', () => {
    describe('feat-20260528 M2 t14 Rapier3D entity despawn cleanup', () => {
      it('removeEntity reduces body count to zero', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 401;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(401, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(401);
        expect(pw.getBodyCount()).toBe(0);
      });

      it('multi-entity: remove one, others remain', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        for (let i = 0; i < 3; i++) {
          const body = pw.raw.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(i, 5, 0),
          );
          body.userData = 410 + i;
          pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
          pw.registerBody(410 + i, body.handle);
        }

        const countBefore = pw.getBodyCount();
        expect(countBefore).toBe(3);

        pw.removeEntity(410);
        expect(pw.getBodyCount()).toBe(2);
      });

      it('removeEntity on unknown entity does not throw', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1));

        pw.removeEntity(999);
        expect(pw.getBodyCount()).toBe(0);
      });
    });
  });
}

{
  // ─── from raycast-teleport.test.ts ───

  describe('raycast-teleport.test.ts', () => {
    describe('feat-20260528 M2 t13b Rapier3D raycast + teleport', () => {
      it('raycast: Rapier castRayAndGetNormal hits static ground', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeDefined();
        if (hit !== null) {
          const point = ray.pointAt(hit.timeOfImpact);
          expect(point.y).toBeLessThan(0);
          expect(point.y).toBeGreaterThan(-3);
          expect(hit.normal.y).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeLessThan(100);
        }
      });

      it('raycast: Rapier castRay pointing away returns null', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeNull();
      });

      // bug-20260713 solo round-22: PhysicsWorld.raycast() resolved hit.entity via
      // `bodies.get(hit.collider.parent())`, but `.parent()` already returns the
      // RigidBody OBJECT (compat build), so treating it as a handle returned a
      // DIFFERENT body → the WRONG entity for every hit. This drives the real
      // PhysicsWorld.raycast() wrapper (the prior tests only hit raw rapier and
      // never exercised entity resolution) with TWO distinct entities and asserts
      // the ray reports the one it geometrically struck. Reverting the fix (back to
      // `bodies.get(...)`) reddens the `hit.entity === target` assertions.
      it('raycast: hit.entity is the entity actually struck (not another body)', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER as never);
        world.insertResource('PhysicsWorld', pw);

        // Ground: static cuboid, top at y=0.
        const ground = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, -0.5, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 10] },
          },
        ).unwrap();

        // Target: static cuboid centred at x=5 (near face x=4), well above ground.
        const target = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [5, 1, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
          },
        ).unwrap();

        registerPhysicsSystems(world);
        for (let i = 0; i < 5; i++) {
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        // Ray at y=1 toward +X can only reach the target (ground tops out at y=0).
        const toTarget = pw.raycast(
          Float32Array.of(0, 1, 0) as never,
          Float32Array.of(1, 0, 0) as never,
          20,
        );
        expect(toTarget).toBeDefined();
        expect(toTarget?.entity).toBe(target);
        expect(toTarget?.timeOfImpact).toBeCloseTo(4, 1); // near face at x=4
        expect(toTarget?.normal[0]).toBeCloseTo(-1, 1); // facing -X

        // Ray straight down from above the origin hits the ground, not the target.
        const toGround = pw.raycast(
          Float32Array.of(0, 5, 0) as never,
          Float32Array.of(0, -1, 0) as never,
          20,
        );
        expect(toGround).toBeDefined();
        expect(toGround?.entity).toBe(ground);
        expect(toGround?.normal[1]).toBeCloseTo(1, 1); // facing +Y

        // A ray past all geometry misses.
        const miss = pw.raycast(
          Float32Array.of(0, 1, 0) as never,
          Float32Array.of(0, 1, 0) as never,
          20,
        );
        expect(miss).toBeUndefined();
      });

      it('teleport: Rapier setTranslation + zero velocity', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
        rw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);

        body.setTranslation({ x: 100, y: 100, z: 100 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);

        const pos = body.translation();
        expect(pos.x).toBeCloseTo(100, 0);
        expect(pos.y).toBeCloseTo(100, 0);
        expect(pos.z).toBeCloseTo(100, 0);
      });
    });
  });
}

{
  // ─── from tick-pipeline.test.ts ───

  describe('tick-pipeline.test.ts', () => {
    describe('feat-20260528 M2 t12 Rapier3D low-level primitives (kinematic teleport, despawn)', () => {
      it('kinematic body: position follows setNextKinematicTranslation', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0),
        );
        body.userData = 3;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1), body);
        pw.registerBody(3, body.handle);

        pw.setKinematicPosition(3, { x: 10, y: 3, z: 0 });

        for (let i = 0; i < 60; i++) {
          pw.step(1 / 60);
        }

        const posAfter = body.translation();
        expect(posAfter.x).toBeCloseTo(10, 0);
      });

      it('kinematic body honors ccdEnabled through the ECS bridge', async () => {
        // Regression: the kinematic arm of ensureBody omitted setCcdEnabled, so
        // a fast kinematic mover (bullet) tunneled through dynamics. A kinematic
        // body spawned with ccdEnabled:true must carry CCD on the Rapier body.
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 1, 0] } },
          {
            component: RigidBody as never,
            data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true },
          },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 0.2 },
          },
        ).unwrap();

        registerPhysicsSystems(world);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        let ccdBodies = 0;
        pw.raw.forEachRigidBody((b: { isCcdEnabled(): boolean }) => {
          if (b.isCcdEnabled()) ccdBodies++;
        });
        expect(ccdBodies).toBe(1);
      });

      it('despawn: removeEntity reduces body count', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 4;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(4, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(4);
        expect(pw.getBodyCount()).toBe(0);
      });
    });

    describe('bug-20260529 M1 real ECS bridge (regression)', () => {
      it('dynamic ball falls + static ground unchanged through registerPhysicsSystems', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        const dynamicEntity = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 5, 0] } },
          {
            component: RigidBody as never,
            data: {
              type: RigidBodyTypeValue.dynamic,
              mass: 1,
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 1,
            },
          },
          {
            component: Collider as never,
            data: { shape: 1, radius: 0.5, friction: 0.5, restitution: 0 },
          },
        ).unwrap();

        const staticEntity = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          {
            component: RigidBody as never,
            data: { type: RigidBodyTypeValue.static },
          },
          {
            component: Collider as never,
            data: {
              shape: 0,
              halfExtents: [10, 1, 10],
              friction: 0.5,
              restitution: 0,
            },
          },
        ).unwrap();

        const initDynamic = world.get(dynamicEntity, Transform as never);
        const initStatic = world.get(staticEntity, Transform as never);
        expect(initDynamic.ok).toBe(true);
        expect(initStatic.ok).toBe(true);
        if (!initDynamic.ok || !initStatic.ok) return;
        const dynPosYBefore = (initDynamic.value as { pos: Float32Array }).pos[1] as number;
        expect(dynPosYBefore).toBeCloseTo(5, 1);

        registerPhysicsSystems(world);

        for (let i = 0; i < 60; i++) {
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        const finalDynamic = world.get(dynamicEntity, Transform as never);
        if (!finalDynamic.ok) {
          expect(finalDynamic.ok).toBe(true);
          return;
        }
        const dynPosYAfter = (finalDynamic.value as { pos: Float32Array }).pos[1] as number;
        expect(dynPosYAfter).toBeLessThan(4.5);

        const finalStatic = world.get(staticEntity, Transform as never);
        if (!finalStatic.ok) {
          expect(finalStatic.ok).toBe(true);
          return;
        }
        const staticPosYAfter = (finalStatic.value as { pos: Float32Array }).pos[1] as number;
        expect(staticPosYAfter).toBeCloseTo(0, 1);

        const bodyCount = pw.getBodyCount();
        expect(bodyCount).toBe(2);
      });

      // solo-round26 (P7 residue): a BARE Collider (no RigidBody) is the natural
      // way to author static level geometry (floors, walls). The Collider
      // component docstring promises "Entities with Collider but no RigidBody are
      // treated as static colliders" — but physicsSyncBackend used to gate on a
      // RigidBody column, so a bare-Collider floor was NEVER simulated and a
      // dynamic ball fell straight through it. This locks the fix: the floor is
      // synthesized as an implicit static body and the ball settles on it.
      it('bare Collider (no RigidBody) acts as a static floor — dynamic ball settles, not falls through', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        // Ball: dynamic body + sphere collider dropped from y=5.
        const ball = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 5, 0] } },
          {
            component: RigidBody as never,
            data: {
              type: RigidBodyTypeValue.dynamic,
              mass: 1,
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 1,
            },
          },
          {
            component: Collider as never,
            data: {
              shape: ColliderShapeValue.sphere,
              radius: 0.5,
              friction: 0.5,
              restitution: 0,
            },
          },
        ).unwrap();

        // Floor: a BARE Collider — NO RigidBody. Cuboid top at y = 0 + 0.5 = 0.5.
        const floor = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          {
            component: Collider as never,
            data: {
              shape: ColliderShapeValue.cuboid,
              halfExtents: [10, 0.5, 10],
              friction: 0.5,
              restitution: 0,
            },
          },
        ).unwrap();

        // Sanity: the floor archetype genuinely has no RigidBody column.
        expect(world.get(floor, RigidBody as never).ok).toBe(false);

        registerPhysicsSystems(world);

        for (let i = 0; i < 90; i++) {
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        const finalBall = world.get(ball, Transform as never);
        expect(finalBall.ok).toBe(true);
        if (!finalBall.ok) return;
        const ballY = (finalBall.value as { pos: Float32Array }).pos[1] as number;
        // Rests at floorTop (0.5) + radius (0.5) = ~1.0 — NOT fallen through to
        // large-negative y (the pre-fix behavior was y ≈ -20 and still falling).
        expect(ballY).toBeGreaterThan(0.6);
        expect(ballY).toBeLessThan(1.4);

        // Both bodies exist in the sim (the bare-Collider floor now gets a body).
        expect(pw.getBodyCount()).toBe(2);
      });
    });

    describe('rapier-authored-transform-pose.test.ts', () => {
      it('applies authored rotation and scale to a static cuboid collider', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        const obstacle = spawnPairedEntity(
          world,
          {
            component: Transform as never,
            data: {
              quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
              scale: [2, 1, 1],
            },
          },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 0.25, 0.25] },
          },
        ).unwrap();
        registerPropagateTransforms(world);
        registerPhysicsSystems(world);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        const alongX = pw.raycast(
          Float32Array.of(-5, 0, 0) as never,
          Float32Array.of(1, 0, 0) as never,
          10,
        );
        const alongY = pw.raycast(
          Float32Array.of(0, -5, 0) as never,
          Float32Array.of(0, 1, 0) as never,
          10,
        );
        expect(alongX?.entity).toBe(obstacle);
        expect(alongY?.entity).toBe(obstacle);
        // Rotation swaps the local X/Y spans. Scale doubles the local-X span,
        // so the world Y ray hits its near face at -2, not the unscaled -1.
        expect(alongX?.timeOfImpact).toBeCloseTo(4.75, 1);
        expect(alongY?.timeOfImpact).toBeCloseTo(3, 1);
      });

      it('updates a static collider when its authored Transform pose changes', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        const obstacle = spawnPairedEntity(
          world,
          { component: Transform as never, data: { scale: [1, 1, 1] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 0.25, 0.25] },
          },
        ).unwrap();
        registerPropagateTransforms(world);
        registerPhysicsSystems(world);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        world.set(obstacle, Transform as never, {
          quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [2, 1, 1],
        });
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        const alongY = pw.raycast(
          Float32Array.of(0, -5, 0) as never,
          Float32Array.of(0, 1, 0) as never,
          10,
        );
        expect(alongY?.entity).toBe(obstacle);
        expect(alongY?.timeOfImpact).toBeCloseTo(3, 1);
      });
    });

    describe('feat-20260709 M4 / w18 -- cuboid halfExtents array passes through the 3D bridge', () => {
      it('per-axis resting heights track halfExtents[1] (axis-order regression)', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        // Two grounds with distinct halfExtents[1] (Y half-height) at the same
        // base Y. A ball dropped on each rests at base + halfY + radius. If the
        // array collapse swizzled axes (e.g. read [2] where [1] was meant) or
        // dropped an element, the two resting heights would not differ by the
        // Y-half delta -- a dimension- AND axis-order-sensitive regression.
        async function restHeight(halfExtents: readonly [number, number, number]): Promise<number> {
          const world = prepareWorld();
          const pw = createRapier3DPhysicsWorld(RAPIER as never);
          world.insertResource('PhysicsWorld', pw);
          const ball = spawnPairedEntity(
            world,
            { component: Transform as never, data: { pos: [0, 8, 0] } },
            {
              component: RigidBody as never,
              data: { type: RigidBodyTypeValue.dynamic, mass: 1, gravityScale: 1 },
            },
            {
              component: Collider as never,
              data: { shape: 1, radius: 0.5, friction: 0.5, restitution: 0 },
            },
          ).unwrap();
          spawnPairedEntity(
            world,
            { component: Transform as never, data: { pos: [0, 0, 0] } },
            { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
            {
              component: Collider as never,
              data: { shape: 0, halfExtents, friction: 0.5, restitution: 0 },
            },
          ).unwrap();
          registerPhysicsSystems(world);
          for (let i = 0; i < 300; i++) {
            world.update(1 / 60).unwrap();
            world.update(1 / 60).unwrap();
          }
          const r = world.get(ball, Transform as never);
          expect(r.ok).toBe(true);
          return r.ok ? ((r.value as { pos: Float32Array }).pos[1] as number) : Number.NaN;
        }

        // Thin ground: top at 0.5, ball rests ~1.0.
        const thin = await restHeight([10, 0.5, 10]);
        // Thick ground: top at 3.0, ball rests ~3.5.
        const thick = await restHeight([10, 3, 10]);
        expect(thin).toBeGreaterThan(0.7);
        expect(thin).toBeLessThan(1.3);
        expect(thick).toBeGreaterThan(3.2);
        expect(thick).toBeLessThan(3.8);
        // Delta must track the Y-half difference (3 - 0.5 = 2.5).
        expect(thick - thin).toBeGreaterThan(2.0);
      });
    });

    describe('childof-kinematic-world-mirror.test.ts (regression)', () => {
      // A ChildOf kinematic collider (e.g. a Guardian attack sensor parented to
      // its body) must have its Rapier collider follow the parent in WORLD space.
      // The bug: physicsSyncBackend's kinematic mirror fed LOCAL posX/Y/Z to
      // setKinematicPosition, so a child with local pos (0,0,0) had its collider
      // pinned at the world origin forever while only its ECS Transform followed
      // the parent (via propagateTransforms). Symptom in the collectathon: the
      // player at spawn (origin) overlapped ALL guardian attack sensors at once,
      // and once the player roamed off-origin no sensor could ever reach it.
      it('a ChildOf kinematic sensor overlaps a probe at the parent world pos, not the origin', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        // Parent: a kinematic body (NO CharacterController, so the kinematic
        // mirror -- not moveAndSlide -- drives it) placed far from the origin.
        const PARENT_X = 8;
        const parent = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [PARENT_X, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 0.3 },
          },
        ).unwrap();

        // Child sensor: ChildOf the parent with LOCAL pos (0,0,0), so its world
        // pos equals the parent's. This is the shape that regressed.
        const sensor = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 1, isSensor: true },
          },
          { component: ChildOf as never, data: { parent } },
          { component: CollidingEntities as never, data: { entities: [] } },
        ).unwrap();

        // Probe at the ORIGIN: if the sensor collider were (wrongly) pinned at
        // the origin, it would overlap this probe.
        const originProbe = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 0.3 },
          },
        ).unwrap();

        // Probe at the PARENT world pos: the sensor must overlap THIS one once it
        // correctly follows the parent.
        const farProbe = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [PARENT_X, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 0.3 },
          },
        ).unwrap();

        registerPropagateTransforms(world);
        registerPhysicsSystems(world);
        for (let i = 0; i < 5; i++) {
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        const colliding = world.get(sensor, CollidingEntities as never);
        expect(colliding.ok).toBe(true);
        if (!colliding.ok) return;
        const overlaps = Array.from(
          (colliding.value as unknown as { entities: ArrayLike<number> }).entities,
        );

        // The sensor follows the parent to world x=8: it overlaps the far probe
        // and NOT the origin probe.
        expect(overlaps).toContain(farProbe as unknown as number);
        expect(overlaps).not.toContain(originProbe as unknown as number);
      });
    });
  });
}

{
  // ─── from wasm-loader.test.ts ───

  describe('wasm-loader.test.ts', () => {
    describe('feat-20260528 M2 t10 Rapier3D WASM loader', () => {
      it('loadRapier3D should import and init rapier3d-compat returning a RAPIER instance', async () => {
        const result = await loadRapier3D();

        if ('code' in result) {
          expect(result.code).toBe('wasm-load-failed');
          return;
        }

        expect(result).toBeDefined();
        expect(typeof result.version).toBe('function');
      });

      it('loadRapier3D RAPIER instance should support World + RigidBody creation', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world2 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        expect(world2).toBeDefined();

        const bodyDesc = rapier.RigidBodyDesc.dynamic()
          .setTranslation(0, 5, 0)
          .setLinearDamping(0.1)
          .setAngularDamping(0.1);
        const body = world2.createRigidBody(bodyDesc);
        expect(body).toBeDefined();
        expect(typeof body.handle).toBe('number');
        expect(body.handle).toBeGreaterThanOrEqual(0);

        const colliderDesc = rapier.ColliderDesc.ball(0.5).setFriction(0.5).setRestitution(0.3);
        const collider = world2.createCollider(colliderDesc, body);
        expect(collider).toBeDefined();
        expect(typeof collider.handle).toBe('number');
      });

      it('loadRapier3D should step simulation without errors', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world3 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        const body = world3.createRigidBody(
          rapier.RigidBodyDesc.dynamic().setTranslation(0, 10, 0),
        );
        world3.createCollider(rapier.ColliderDesc.ball(0.5), body);

        for (let i = 0; i < 60; i++) {
          world3.step();
        }

        const pos = body.translation();
        expect(pos.y).toBeLessThan(10);
      });
    });
  });
}

describe('incremental physics ECS reconciliation', () => {
  async function loadOrSkip() {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return undefined;
    }
    return RAPIER;
  }

  function spawnBox(
    world: World,
    options: {
      readonly pos?: readonly [number, number, number];
      readonly bodyType?: number | 'implicit';
      readonly halfExtents?: readonly [number, number, number];
    } = {},
  ): number {
    const transform = {
      component: Transform as never,
      data: { pos: options.pos ?? [0, 0, 0] },
    };
    const collider = {
      component: Collider as never,
      data: {
        shape: ColliderShapeValue.cuboid,
        halfExtents: options.halfExtents ?? [1, 1, 1],
      },
    };
    const result =
      options.bodyType === 'implicit'
        ? spawnPairedEntity(world, transform, collider)
        : spawnPairedEntity(
            world,
            transform,
            {
              component: RigidBody as never,
              data: { type: options.bodyType ?? RigidBodyTypeValue.static },
            },
            collider,
          );
    return result.unwrap() as unknown as number;
  }

  it('does not mark initialization complete before PhysicsWorld becomes ready', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const entity = spawnBox(world);
    registerPhysicsSystems(world);

    runPhysicsTicks(world);

    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    runPhysicsTicks(world);
    expect(pw.hasBody(entity)).toBe(true);
    expect(pw.getBodyCount()).toBe(1);
  });

  it('releases ECS projection contexts on teardown and rejects reuse after dispose', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    spawnBox(world);
    const unregister = registerPhysicsSystems(world);
    runPhysicsTicks(world);

    // biome-ignore lint/suspicious/noExplicitAny: test-only lifecycle inspection.
    const internals = pw as any;
    expect(internals.syncState?.world).toBe(world);
    expect(internals.moveContext?.world).toBe(world);

    unregister();
    expect(internals.syncState).toBeUndefined();
    expect(internals.moveContext).toBeUndefined();

    const unregisterAgain = registerPhysicsSystems(world);
    runPhysicsTicks(world);
    expect(internals.syncState?.world).toBe(world);
    expect(internals.moveContext?.world).toBe(world);
    unregisterAgain();

    pw.dispose();
    expect(internals.syncState).toBeUndefined();
    expect(internals.moveContext).toBeUndefined();
    expect(pw.getBodyCount()).toBe(0);
    expect(pw.getKinematicControllerStates()).toEqual([]);
    expect(() => pw._syncFromEcs(world, Transform)).toThrow(/disposed/);
    expect(() => pw.setMoveContext(world, Transform)).toThrow(/disposed/);
  });

  it('bootstraps once, then performs no query, materialization, or Rapier setters on warm static ticks', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world);
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);

    const ensureSpy = vi.spyOn(pw, 'ensureBody');
    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    runPhysicsTicks(world);
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).not.toHaveBeenCalled();

    const body = rapierBodyFor(pw, entity);
    expect(body).toBeDefined();
    const collider = body?.collider(0);
    expect(collider).toBeDefined();
    const translationSpy = vi.spyOn(body, 'setTranslation');
    const rotationSpy = vi.spyOn(body, 'setRotation');
    const shapeSpy = vi.spyOn(collider, 'setHalfExtents');
    const querySpy = vi.spyOn(world, 'query');
    const pruneSpy = vi.spyOn(pw, 'pruneMissingEntities');
    ensureSpy.mockClear();
    syncSpy.mockClear();

    runPhysicsTicks(world, 2);

    expect(querySpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(translationSpy).not.toHaveBeenCalled();
    expect(rotationSpy).not.toHaveBeenCalled();
    expect(shapeSpy).not.toHaveBeenCalled();
  });

  it('coalesces authored Transform writes and consumes the final resolved pose once', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world);
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const ensureSpy = vi.spyOn(pw, 'ensureBody');
    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    world.set(entity as never, Transform as never, { pos: [2, 0, 0] }).unwrap();
    world.set(entity as never, Transform as never, { pos: [4, 0, 0] }).unwrap();
    world.set(entity as never, Transform as never, { pos: [7, 0, 0] }).unwrap();
    runPhysicsTicks(world);

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(rapierBodyFor(pw, entity)?.translation().x).toBeCloseTo(7, 5);
  });

  it('uses derived Transform evidence to update only collider descendants after a parent move', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const parent = spawnPairedEntity(world, {
      component: Transform as never,
      data: { pos: [1, 0, 0] },
    }).unwrap();
    const child = spawnPairedEntity(
      world,
      { component: Transform as never, data: { pos: [2, 0, 0] } },
      { component: ChildOf as never, data: { parent } },
      { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider as never,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
      },
    ).unwrap();
    const unrelated = spawnBox(world, { pos: [20, 0, 0] });
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    world.set(parent, Transform as never, { pos: [5, 0, 0] }).unwrap();
    runPhysicsTicks(world);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ position: expect.objectContaining({ x: 7 }) }),
      undefined,
      'static',
    );
    expect(rapierBodyFor(pw, child)?.translation().x).toBeCloseTo(7, 5);
    expect(rapierBodyFor(pw, unrelated)?.translation().x).toBeCloseTo(20, 5);
  });

  it.each([
    ['static', RigidBodyTypeValue.static],
    ['non-controller-owned kinematic', RigidBodyTypeValue.kinematic],
  ] as const)('uses a readable identity world pose for root and parent-cancelled %s bodies', async (_label, bodyType) => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const root = spawnBox(world, { bodyType });
    const parent = spawnPairedEntity(world, {
      component: Transform as never,
      data: { pos: [1, 0, 0] },
    }).unwrap();
    const child = spawnPairedEntity(
      world,
      { component: Transform as never, data: { pos: [-1, 0, 0] } },
      { component: ChildOf as never, data: { parent } },
      { component: RigidBody as never, data: { type: bodyType } },
      {
        component: Collider as never,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
      },
    ).unwrap();
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const rootWorld = world.get(root as never, GlobalTransform as never).unwrap()
      .world as Float32Array;
    const childWorld = world.get(child, GlobalTransform as never).unwrap().world as Float32Array;
    expect(Array.from(rootWorld)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(Array.from(childWorld)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(rapierBodyFor(pw, root)?.translation().x).toBeCloseTo(0, 5);
    expect(rapierBodyFor(pw, child)?.translation().x).toBeCloseTo(0, 5);

    world.set(parent, Transform as never, { pos: [3, 0, 0] }).unwrap();
    world.set(child, Transform as never, { pos: [-3, 0, 0] }).unwrap();
    runPhysicsTicks(world);

    expect(rapierBodyFor(pw, child)?.translation().x).toBeCloseTo(0, 5);
  });

  it('does not treat a dynamic body Transform write as an authored Rapier pose', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.dynamic });
    world.set(entity as never, RigidBody as never, { gravityScale: 0 }).unwrap();
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const ensureSpy = vi.spyOn(pw, 'ensureBody');
    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    world.set(entity as never, Transform as never, { pos: [50, 0, 0] }).unwrap();
    runPhysicsTicks(world);

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(rapierBodyFor(pw, entity)?.translation().x).toBeCloseTo(0, 5);
  });

  it('reconciles Collider and RigidBody add, remove, and change from the final ECS combination', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const removeSpy = vi.spyOn(pw, 'removeEntity');
    const ensureSpy = vi.spyOn(pw, 'ensureBody');
    world.set(entity as never, Collider as never, { halfExtents: [3, 1, 1] }).unwrap();
    runPhysicsTicks(world);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(rapierBodyFor(pw, entity)?.collider(0).halfExtents().x).toBeCloseTo(3, 5);

    removeSpy.mockClear();
    ensureSpy.mockClear();
    world.removeComponent(entity as never, Collider as never).unwrap();
    runPhysicsTicks(world);
    expect(pw.hasBody(entity)).toBe(true);
    expect(rapierBodyFor(pw, entity)?.numColliders()).toBe(0);
    expect(removeSpy).not.toHaveBeenCalled();

    world
      .addComponent(entity as never, {
        component: Collider as never,
        data: { shape: ColliderShapeValue.sphere, radius: 2 },
      })
      .unwrap();
    runPhysicsTicks(world);
    expect(pw.hasBody(entity)).toBe(true);
    expect(rapierBodyFor(pw, entity)?.collider(0).radius()).toBeCloseTo(2, 5);

    world.removeComponent(entity as never, RigidBody as never).unwrap();
    runPhysicsTicks(world);
    expect(rapierBodyFor(pw, entity)?.bodyType()).toBe(RAPIER.RigidBodyType.Fixed);

    world
      .addComponent(entity as never, {
        component: RigidBody as never,
        data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 },
      })
      .unwrap();
    runPhysicsTicks(world);
    expect(rapierBodyFor(pw, entity)?.bodyType()).toBe(RAPIER.RigidBodyType.Dynamic);
    expect(pw.getBodyCount()).toBe(1);

    world.set(entity as never, RigidBody as never, { type: RigidBodyTypeValue.static }).unwrap();
    world.set(entity as never, RigidBody as never, { type: RigidBodyTypeValue.kinematic }).unwrap();
    runPhysicsTicks(world);
    expect(rapierBodyFor(pw, entity)?.bodyType()).toBe(RAPIER.RigidBodyType.KinematicPositionBased);
    expect(pw.getBodyCount()).toBe(1);
  });

  it('keeps a body-only derived publication intact when its authored collider is added and removed', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.dynamic });
    world.removeComponent(entity as never, Collider as never).unwrap();
    world.set(entity as never, RigidBody as never, { gravityScale: 0 }).unwrap();
    registerPhysicsSystems(world);
    runPhysicsTicks(world);
    expect(rapierBodyFor(pw, entity)?.numColliders()).toBe(0);
    pw.admitDerivedShapeCandidate(
      pw
        .prepareDerivedShapeCandidate({
          entity,
          revision: 1,
          sourceKey: 'body-only',
          worldIdentity: world,
          bodyType: 'dynamic',
          velocityPolicy: 'preserve',
          constraints: [],
          massProperties: {
            mode: 'explicit',
            mass: 2,
            centerOfMass: [0, 0, 0],
            principalInertia: [1, 1, 1],
          },
          shapes: [
            {
              id: 'derived-box',
              revision: 1,
              kind: 'convex-compound',
              pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
              origin: [3, 0, 0],
            },
          ],
        })
        .unwrap(),
    ).unwrap();
    runPhysicsTicks(world);
    const body = rapierBodyFor(pw, entity);
    const derivedHandle = body.collider(0).handle;
    world
      .addComponent(entity as never, {
        component: Collider as never,
        data: { shape: ColliderShapeValue.sphere, radius: 0.5 },
      })
      .unwrap();
    runPhysicsTicks(world);
    expect(rapierBodyFor(pw, entity)?.handle).toBe(body.handle);
    expect(body.numColliders()).toBe(2);
    expect(pw.raw.getCollider(derivedHandle)?.isValid()).toBe(true);
    expect(pw.getDerivedBodyMass(entity)).toBeCloseTo(2);
    world.removeComponent(entity as never, Collider as never).unwrap();
    runPhysicsTicks(world);
    expect(body.numColliders()).toBe(1);
    expect(body.collider(0).handle).toBe(derivedHandle);
    expect(pw.getDerivedPublication(entity)?.revision).toBe(1);
    expect(pw.getDerivedBodyMass(entity)).toBeCloseTo(2);
    pw.dispose();
  });

  it('switches kinematic pose ownership when CharacterController is added or removed', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.kinematic });
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    world.set(entity as never, Transform as never, { pos: [9, 0, 0] }).unwrap();
    world
      .addComponent(entity as never, { component: CharacterController as never, data: {} })
      .unwrap();
    runPhysicsTicks(world);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(rapierBodyFor(pw, entity)?.translation().x).toBeCloseTo(0, 5);

    world.removeComponent(entity as never, CharacterController as never).unwrap();
    runPhysicsTicks(world);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(rapierBodyFor(pw, entity)?.translation().x).toBeCloseTo(9, 5);
  });

  it('rebuilds only the cached character controller receipt when offset changes', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.kinematic });
    world
      .addComponent(entity as never, {
        component: CharacterController as never,
        data: { offset: 0.02 },
      })
      .unwrap();
    registerPhysicsSystems(world);
    runPhysicsTicks(world);
    pw.moveAndSlide(entity, Float32Array.of(0, 0, 0) as never);

    const body = rapierBodyFor(pw, entity);
    // biome-ignore lint/suspicious/noExplicitAny: test-only inspection of the backend receipt cache.
    const receipts = (pw as any).kccCache as Map<number, unknown>;
    // biome-ignore lint/suspicious/noExplicitAny: test-only inspection of the backend receipt cache.
    const offsets = (pw as any).kccOffsets as Map<number, number>;
    const receipt = receipts.get(entity);
    const removeEntitySpy = vi.spyOn(pw, 'removeEntity');
    const ensureBodySpy = vi.spyOn(pw, 'ensureBody');

    world.set(entity as never, CharacterController as never, { offset: 0.5 }).unwrap();
    runPhysicsTicks(world);

    expect(rapierBodyFor(pw, entity)).toBe(body);
    expect(removeEntitySpy).not.toHaveBeenCalled();
    expect(ensureBodySpy).not.toHaveBeenCalled();
    expect(receipts.get(entity)).not.toBe(receipt);
    expect(offsets.get(entity)).toBeCloseTo(0.5, 5);
  });

  it('rebuilds the cached character controller receipt from a same-tick remove and add', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.kinematic });
    world
      .addComponent(entity as never, {
        component: CharacterController as never,
        data: { offset: 0.02 },
      })
      .unwrap();
    registerPhysicsSystems(world);
    runPhysicsTicks(world);
    pw.moveAndSlide(entity, Float32Array.of(0, 0, 0) as never);

    const body = rapierBodyFor(pw, entity);
    // biome-ignore lint/suspicious/noExplicitAny: test-only inspection of the backend receipt cache.
    const receipts = (pw as any).kccCache as Map<number, unknown>;
    // biome-ignore lint/suspicious/noExplicitAny: test-only inspection of the backend receipt cache.
    const offsets = (pw as any).kccOffsets as Map<number, number>;
    const receipt = receipts.get(entity);
    const removeEntitySpy = vi.spyOn(pw, 'removeEntity');
    const ensureBodySpy = vi.spyOn(pw, 'ensureBody');

    world.removeComponent(entity as never, CharacterController as never).unwrap();
    world
      .addComponent(entity as never, {
        component: CharacterController as never,
        data: { offset: 0.4 },
      })
      .unwrap();
    runPhysicsTicks(world);

    expect(rapierBodyFor(pw, entity)).toBe(body);
    expect(removeEntitySpy).not.toHaveBeenCalled();
    expect(ensureBodySpy).not.toHaveBeenCalled();
    expect(receipts.get(entity)).not.toBe(receipt);
    expect(offsets.get(entity)).toBeCloseTo(0.4, 5);
  });

  it('keeps the cached character controller receipt for grounded-only writes', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world, { bodyType: RigidBodyTypeValue.kinematic });
    world
      .addComponent(entity as never, {
        component: CharacterController as never,
        data: { offset: 0.02 },
      })
      .unwrap();
    registerPhysicsSystems(world);
    runPhysicsTicks(world);
    pw.moveAndSlide(entity, Float32Array.of(0, 0, 0) as never);
    runPhysicsTicks(world);

    // biome-ignore lint/suspicious/noExplicitAny: test-only inspection of the backend receipt cache.
    const receipts = (pw as any).kccCache as Map<number, unknown>;
    const receipt = receipts.get(entity);
    const body = rapierBodyFor(pw, entity);
    const removeEntitySpy = vi.spyOn(pw, 'removeEntity');
    const ensureBodySpy = vi.spyOn(pw, 'ensureBody');

    world.set(entity as never, CharacterController as never, { grounded: true }).unwrap();
    runPhysicsTicks(world);

    expect(rapierBodyFor(pw, entity)).toBe(body);
    expect(removeEntitySpy).not.toHaveBeenCalled();
    expect(ensureBodySpy).not.toHaveBeenCalled();
    expect(receipts.get(entity)).toBe(receipt);
  });

  it('removes the old generation and creates the final entity after same-slot reuse', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const previous = spawnBox(world, { pos: [1, 0, 0] });
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    world.despawn(previous as never).unwrap();
    const replacement = spawnBox(world, { pos: [11, 0, 0] });
    expect(replacement).not.toBe(previous);
    expect(replacement & 0x00ffffff).toBe(previous & 0x00ffffff);
    runPhysicsTicks(world);

    expect(pw.hasBody(previous)).toBe(false);
    expect(pw.hasBody(replacement)).toBe(true);
    expect(pw.getBodyCount()).toBe(1);
    expect(rapierBodyFor(pw, replacement)?.translation().x).toBeCloseTo(11, 5);
  });

  it('coalesces more than 65k writes into one final component-version sync', {
    timeout: 20_000,
  }, async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const entity = spawnBox(world);
    registerPropagateTransforms(world);
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    const removeSpy = vi.spyOn(pw, 'removeEntity');
    const ensureSpy = vi.spyOn(pw, 'ensureBody');
    const syncSpy = vi.spyOn(pw, 'syncAuthoredPose');
    let finalX = 0;
    for (let index = 0; index <= 65_536; index += 1) {
      finalX = index % 19;
      world.set(entity as never, Transform as never, { pos: [finalX, 0, 0] }).unwrap();
    }
    runPhysicsTicks(world);

    expect(removeSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(pw.getBodyCount()).toBe(1);
    expect(rapierBodyFor(pw, entity)?.translation().x).toBeCloseTo(finalX, 5);
  });

  it('retains only an existing fixed Transform-less body and never creates one without Transform', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    const fixed = spawnBox(world);
    const dynamic = spawnBox(world, { bodyType: RigidBodyTypeValue.dynamic });
    registerPhysicsSystems(world);
    runPhysicsTicks(world);

    world.removeComponent(fixed as never, Transform as never).unwrap();
    world.removeComponent(dynamic as never, Transform as never).unwrap();
    const neverMaterialized = world
      .spawn({
        component: Collider as never,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
      })
      .unwrap() as unknown as number;
    runPhysicsTicks(world);

    expect(pw.hasBody(fixed)).toBe(true);
    expect(pw.hasBody(dynamic)).toBe(false);
    expect(pw.hasBody(neverMaterialized)).toBe(false);
    expect(pw.getBodyCount()).toBe(1);
  });
});

// ─── feat-20260617 M2 moveAndSlide (kinematic character controller) ───
//
// Shared scene builder: spawns a kinematic capsule character (RigidBody +
// Collider + CharacterController) plus optional static geometry, drives one
// world.update(1 / 60).unwrap() to push the bodies into the Rapier world, then returns the
// handles so each test can call pw.moveAndSlide(entity, delta) directly.

{
  describe('moveAndSlide.test.ts', () => {
    type Vec3Tuple = readonly [number, number, number];

    interface StaticBox {
      readonly pos: Vec3Tuple;
      readonly halfExtents: Vec3Tuple;
      readonly rotXDeg?: number;
    }

    async function loadOrNull() {
      const RAPIER = await loadRapier3D();
      if ('code' in RAPIER) {
        expect(RAPIER.code).toBe('wasm-load-failed');
        return undefined;
      }
      return RAPIER;
    }

    function spawnCharacter(
      world: World,
      pos: Vec3Tuple,
      cc?: Record<string, number>,
      bodyType: number = RigidBodyTypeValue.kinematic,
    ): number {
      const entity = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [pos[0], pos[1], pos[2]] } },
        { component: RigidBody as never, data: { type: bodyType } },
        {
          component: Collider as never,
          data: { shape: 2, radius: 0.3, halfHeight: 0.5, friction: 0.5, restitution: 0 },
        },
        { component: CharacterController as never, data: cc ?? {} },
      ).unwrap();
      return entity as unknown as number;
    }

    function spawnStaticBox(world: World, box: StaticBox): number {
      const data: Record<string, number | readonly number[]> = {
        shape: 0,
        halfExtents: [box.halfExtents[0], box.halfExtents[1], box.halfExtents[2]],
        friction: 0.5,
        restitution: 0,
      };
      const entity = spawnPairedEntity(
        world,
        {
          component: Transform as never,
          data: { pos: [box.pos[0], box.pos[1], box.pos[2]] },
        },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
        { component: Collider as never, data },
      ).unwrap();
      return entity as unknown as number;
    }

    function tfPos(world: World, entity: number): { x: number; y: number; z: number } {
      const r = world.get(entity as never, Transform as never);
      if (!r.ok) throw new Error('transform missing');
      const v = r.value as { pos: Float32Array };
      return { x: v.pos[0] as number, y: v.pos[1] as number, z: v.pos[2] as number };
    }

    function ccGrounded(world: World, entity: number): boolean {
      const r = world.get(entity as never, CharacterController as never);
      if (!r.ok) throw new Error('CharacterController missing');
      // `grounded` is a `bool` schema field; world.get materializes it as a JS
      // boolean (not a 0/1 number), so compare against `true` directly. A prior
      // `!== 0` check compared a boolean to a number and was always truthy.
      return (r.value as Record<string, boolean>).grounded === true;
    }

    describe('moveAndSlide basic motion (AC-01/02/03)', () => {
      it('teleport places a kinematic character before a same-tick slide', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        const character = spawnCharacter(world, [0, 1, 0]);
        runPhysicsTicks(world, 1);
        const body = rapierBodyFor(pw, character);
        expect(body).toBeDefined();

        pw.teleport(character, Float32Array.of(10, 1, 10) as never);
        expect(body.translation()).toMatchObject({ x: 10, y: 1, z: 10 });
        expect(body.collider(0).translation()).toMatchObject({ x: 10, y: 1, z: 10 });
        expect(tfPos(world, character)).toMatchObject({ x: 10, y: 1, z: 10 });

        const actual = pw.moveAndSlide(character, Float32Array.of(0, 0, -1) as never);
        expect(actual[2]).toBeCloseTo(-1, 3);
        expect(body.translation().z).toBeCloseTo(9, 3);
        expect(body.collider(0).translation().z).toBeCloseTo(9, 3);
        world.update(1 / 60).unwrap();
        expect(body.translation()).toMatchObject({ x: 10, y: 1, z: 9 });
        pw.dispose();
      });

      it('teleport moves a dynamic body and its offset collider immediately', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const pw = createRapier3DPhysicsWorld(RAPIER);
        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
        const collider = pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.25).setTranslation(1, 0, 0),
          body,
        );
        pw.registerBody(101, body.handle);
        body.setLinvel({ x: 4, y: 0, z: 0 }, true);

        pw.teleport(101, Float32Array.of(10, 1, 10) as never);
        expect(body.translation()).toMatchObject({ x: 10, y: 1, z: 10 });
        expect(collider.translation()).toMatchObject({ x: 11, y: 1, z: 10 });
        expect(body.linvel()).toMatchObject({ x: 0, y: 0, z: 0 });
        expect(() => pw.teleport(999, Float32Array.of(0, 0, 0) as never)).toThrowError(
          PhysicsError,
        );
        expect(() => pw.teleport(101, Float32Array.of(Number.NaN, 0, 0) as never)).toThrowError(
          PhysicsError,
        );
        pw.dispose();
      });

      it('slides against geometry at the teleport destination', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        spawnStaticBox(world, { pos: [10, 1, 9.1], halfExtents: [1, 1, 0.1] });
        const character = spawnCharacter(world, [0, 1, 0]);
        runPhysicsTicks(world, 1);

        pw.teleport(character, Float32Array.of(10, 1, 10) as never);
        const actual = pw.moveAndSlide(character, Float32Array.of(0, 0, -1) as never);
        expect(actual[2]).toBeGreaterThan(-0.7);
        expect(tfPos(world, character).z).toBeGreaterThan(9.3);
        pw.dispose();
      });

      it('writes a parented character teleport as local Transform position', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        const parent = world.spawn({ component: Transform, data: { pos: [5, 0, 0] } }).unwrap();
        const child = spawnPairedEntity(
          world,
          { component: Transform, data: { pos: [0, 1, 0] } },
          { component: ChildOf, data: { parent } },
          { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
          {
            component: Collider,
            data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
          },
          { component: CharacterController, data: {} },
        ).unwrap() as number;
        registerPropagateTransforms(world);
        registerPhysicsSystems(world);
        runPhysicsTicks(world, 1);

        pw.teleport(child, Float32Array.of(10, 1, 0) as never);
        expect(tfPos(world, child)).toMatchObject({ x: 5, y: 1, z: 0 });
        pw.moveAndSlide(child, Float32Array.of(1, 0, 0) as never);
        expect(tfPos(world, child).x).toBeCloseTo(6, 3);
        world.update(1 / 60).unwrap();
        expect(rapierBodyFor(pw, child).translation().x).toBeCloseTo(11, 3);
        pw.dispose();
      });

      it('teleport moves a static body and its offset collider immediately', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const pw = createRapier3DPhysicsWorld(RAPIER);
        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1, 0));
        const collider = pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.25).setTranslation(1, 0, 0),
          body,
        );
        pw.registerBody(102, body.handle);
        pw.teleport(102, Float32Array.of(10, 1, 10) as never);
        expect(body.translation()).toMatchObject({ x: 10, y: 1, z: 10 });
        expect(collider.translation()).toMatchObject({ x: 11, y: 1, z: 10 });
        pw.step(1 / 60);
        expect(body.translation()).toMatchObject({ x: 10, y: 1, z: 10 });
        pw.dispose();
      });

      it('unparented KCC motion does not manufacture component absence errors', async () => {
        const RAPIER = await loadOrNull();
        expect(RAPIER).toBeDefined();
        if (!RAPIER) throw new Error('Real Rapier is required for this regression');
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const character = spawnCharacter(world, [0, 0, 0]);
        runPhysicsTicks(world, 2);
        const reads = vi.spyOn(world, 'get');
        try {
          for (let step = 0; step < 20; step++) {
            pw.moveAndSlide(character, Float32Array.of(0.05, -0.01, 0) as never);
          }
          expect(tfPos(world, character).x).toBeGreaterThan(0.9);
          const missing = reads.mock.results.filter(
            (result) =>
              result.type === 'return' &&
              !result.value.ok &&
              result.value.error.code === 'component-not-present',
          );
          expect(missing).toHaveLength(0);
        } finally {
          reads.mockRestore();
          pw.dispose();
        }
      });

      it('AC-01 flat walk: actualDelta tracks desiredDelta and grounded=true', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Ground under the character so it is grounded.
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(actual[0]).toBeCloseTo(1, 1);
        expect(Math.abs(actual[2] ?? 0)).toBeLessThan(0.05);
        expect(ccGrounded(world, char)).toBe(true);
        expect(tfPos(world, char).x).toBeCloseTo(1, 1);
      });

      it('AC-02 wall ahead: actualDelta.x clamped below requested and no clip-through', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        // Wall 0.5m ahead (character radius 0.3 → contact well before x=1).
        spawnStaticBox(world, { pos: [0.8, 0.5, 0], halfExtents: [0.1, 1, 2] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(actual[0]).toBeLessThan(1);
        // Character right edge must not pass the wall left face (~x=0.7).
        expect(tfPos(world, char).x).toBeLessThan(0.45);
      });

      it('AC-03 angled into wall: tangential motion survives, normal is eaten', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        // Wall facing -x at x≈0.8.
        spawnStaticBox(world, { pos: [0.8, 0.5, 0], halfExtents: [0.1, 1, 4] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // Push diagonally into the wall: +x (blocked) and +z (tangential, free).
        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 1) as never);
        expect(actual[2]).toBeGreaterThan(0.3); // tangential z preserved
        expect(actual[0]).toBeLessThan(1); // normal x absorbed
      });
    });

    describe('moveAndSlide multi-character (regression: two KCCs coexist)', () => {
      // A second KinematicCharacterController in the same world must not freeze
      // the first. Before the fix, the per-move propagateModifiedBodyPositionsToColliders
      // refresh of the shared query pipeline was skipped on the SECOND-and-later
      // call of a frame, so once a guardian KCC also moved, the player's
      // computeColliderMovement returned zero from the next frame onward (the
      // collectathon "character stuck, can't move while a guardian exists" bug).
      it('two characters far apart both keep moving across frames', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Shared ground; two characters 10m apart so they never interact.
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [30, 0.5, 30] });
        const a = spawnCharacter(world, [0, 0, 0]);
        const b = spawnCharacter(world, [10, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // Drive both KCCs every frame, mirroring player-move + guardian-ai.
        const startA = tfPos(world, a).x;
        for (let i = 0; i < 5; i++) {
          pw.moveAndSlide(a, Float32Array.of(0.1, -0.01, 0) as never);
          pw.moveAndSlide(b, Float32Array.of(-0.1, -0.01, 0) as never);
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        // Character A must have advanced well past a single frame's step
        // (~0.5 over 5 frames); the bug froze it at ~0.1 (one frame only).
        expect(tfPos(world, a).x - startA).toBeGreaterThan(0.3);
        // Character B moved the other way by a similar magnitude.
        expect(tfPos(world, b).x).toBeLessThan(10 - 0.3);
      });

      it('updates attached collider world positions without changing their local offsets', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld(),
          pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [30, 0.5, 30] });
        const character = spawnCharacter(world, [0, 0, 0]);
        runPhysicsTicks(world, 2);
        const body = rapierBodyFor(pw, character);
        const attached = pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.1).setTranslation(0, 3, 0).setSensor(true),
          body,
        );
        for (let step = 0; step < 5; step++) {
          pw.moveAndSlide(character, Float32Array.of(0.1, -0.01, 0) as never);
          pw.moveAndSlide(character, Float32Array.of(0.1, -0.01, 0) as never);
          expect(attached.translation().x).toBeCloseTo(body.translation().x, 5);
          expect(attached.translation().y - body.translation().y).toBeCloseTo(3, 5);
          expect(attached.translationWrtParent()).toEqual({ x: 0, y: 3, z: 0 });
          runPhysicsTicks(world);
          expect(attached.translation().x).toBeCloseTo(body.translation().x, 5);
        }
        expect(tfPos(world, character).x).toBeGreaterThan(0.8);
        pw.dispose();
      });

      it('overlapping SENSOR does not jam a grounded character (sensors are not obstacles)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [30, 0.5, 30] });
        const char = spawnCharacter(world, [0, 0, 0]);
        // A sensor sphere sitting exactly on the character spawn (mirrors the
        // collectathon guardian attack-sensor whose physics body stayed at world
        // origin). A sensor reports overlaps but must NEVER act as a solid wall
        // for the KCC -- before the fix this froze the character in place.
        spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
          {
            component: Collider as never,
            data: { shape: ColliderShapeValue.sphere, radius: 1.5, isSensor: 1 },
          },
        ).unwrap();

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        const start = tfPos(world, char).x;
        for (let i = 0; i < 5; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.01, 0) as never);
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }
        // The character must slide through the sensor, not be walled by it.
        expect(tfPos(world, char).x - start).toBeGreaterThan(0.3);
      });
    });

    // Slope geometry must be rotated, but the ECS bridge (ensureBody) only
    // applies translation. Build tilted ramps directly on the Rapier world;
    // the character still goes through the ECS path so moveAndSlide resolves it.
    // biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamic module
    function spawnRawRamp(pw: any, RAPIER: any, pos: Vec3Tuple, slopeDeg: number): void {
      const rad = (slopeDeg * Math.PI) / 180;
      // Rotation about z tilts the top face of a wide thin box around the x-axis
      // of travel; quaternion from axis-angle about z.
      const half = rad / 2;
      const body = pw.raw.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(pos[0], pos[1], pos[2])
          .setRotation({ x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }),
      );
      pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.5, 8).setFriction(0.5), body);
    }

    describe('moveAndSlide slope (AC-04/05)', () => {
      it('AC-04 gentle slope (< maxSlopeClimbDeg=45): y rises, not blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // 30deg ramp centered at x=2; the ramp surface at x≈0.8 is near y=0.
        spawnRawRamp(pw, RAPIER, [2, -0.85, 0], 30);
        const char = spawnCharacter(world, [0.7, 0.05, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        // gravity pulse to settle onto the ramp surface.
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        const before = tfPos(world, char).y;
        // Walk into the ramp repeatedly; a climbable slope lets the character ascend.
        for (let i = 0; i < 30; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.12, -0.01, 0) as never);
        }
        const after = tfPos(world, char).y;
        expect(after).toBeGreaterThan(before);
        expect(tfPos(world, char).x).toBeGreaterThan(0.5);
      });

      it('AC-05 steep slope (> maxSlopeClimbDeg=45): horizontal travel is blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // 60deg ramp centered at x=1.5 — steeper than default maxSlopeClimbDeg=45.
        spawnRawRamp(pw, RAPIER, [1.5, -0.85, 0], 60);
        const char = spawnCharacter(world, [0.7, 0.05, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        let totalX = 0;
        for (let i = 0; i < 30; i++) {
          const a = pw.moveAndSlide(char, Float32Array.of(0.1, -0.02, 0) as never);
          totalX += a[0] ?? 0;
        }
        // The character cannot climb a too-steep slope: forward progress stalls
        // well short of the unobstructed 30 * 0.1 = 3.0.
        expect(totalX).toBeLessThan(1.5);
      });
    });

    describe('moveAndSlide autostep (AC-06)', () => {
      it('AC-06a low step (0.2 < autoStepMaxHeight=0.3): character climbs it', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Ground box top at y=-0.35; the capsule (radius 0.3 + halfHeight 0.5)
        // has a half-total of 0.8, so it rests with its center at y=0.45.
        // Spawning at the resting height (not buried at y=0) is what lets KCC
        // autostep — a capsule penetrating the floor has a degenerate contact.
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 4] });
        // A 0.2m-tall step ledge at x=1..3 (top at y=-0.25).
        spawnStaticBox(world, { pos: [2, -0.45, 0], halfExtents: [1, 0.2, 4] });
        const char = spawnCharacter(world, [0, 0.45, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        const before = tfPos(world, char).y;
        // Walk toward and across the 0.2m ledge (x in [1,3]). Track the peak y
        // reached while on the ledge — the character steps up onto the ledge
        // top, traverses it, then steps back down off the far edge, so asserting
        // y at a fixed final iteration would read the post-ledge ground. The
        // peak captures the autostep climb regardless of where traversal ends.
        let peakY = before;
        let reachedLedge = false;
        for (let i = 0; i < 40; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.02, 0) as never);
          const p = tfPos(world, char);
          if (p.y > peakY) peakY = p.y;
          if (p.x > 1.5 && p.x < 2.5) reachedLedge = true;
        }
        // Auto-step lifted the character onto the 0.2m ledge top mid-traversal.
        expect(peakY).toBeGreaterThan(before + 0.05);
        expect(reachedLedge).toBe(true);
      });

      it('AC-06b high step (0.5 > autoStepMaxHeight=0.3): character is blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [4, 0.5, 4] });
        // A 0.5m-tall step ledge — too tall to auto-step.
        spawnStaticBox(world, { pos: [2, -0.05, 0], halfExtents: [2, 0.5, 4] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.05, 0) as never);
        }
        // Could not step up: stays low, blocked before the ledge top.
        expect(tfPos(world, char).y).toBeLessThan(0.2);
      });

      it('AC-06c autoStepMaxHeight=0 disables auto-step (low step now blocks)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [4, 0.5, 4] });
        spawnStaticBox(world, { pos: [2, -0.45, 0], halfExtents: [2, 0.2, 4] });
        const char = spawnCharacter(world, [0, 0, 0], { autoStepMaxHeight: 0 });

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.05, 0) as never);
        }
        // Auto-step off: the 0.2m ledge is no longer climbed.
        expect(tfPos(world, char).y).toBeLessThan(0.1);
      });
    });

    describe('moveAndSlide snap-to-ground (AC-07)', () => {
      it('AC-07a snap-to-ground keeps the character on a descending slope (pure horizontal move pulls y down)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Downhill ramp toward +x (top near origin, descending).
        spawnRawRamp(pw, RAPIER, [4, -1.0, 0], -20);
        const char = spawnCharacter(world, [0, 0.1, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        // Establish ground contact first.
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);
        const startY = tfPos(world, char).y;

        // Walk forward with NO vertical input. Without snap-to-ground the
        // character would travel level and lift off the descending surface;
        // snap pulls it back down onto the ramp, so y decreases monotonically
        // as x advances. (Rapier's computedGrounded() reads false while sliding
        // a slope in this build — the snap effect shows in the trajectory, not
        // the flag; the grounded flag itself is asserted on flat ground in
        // AC-01 and in the void in AC-07b.)
        for (let i = 0; i < 20; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.08, 0, 0) as never);
        }
        const endPos = tfPos(world, char);
        // The character followed the ramp down (snap kept it on the surface)
        // rather than flying off level.
        expect(endPos.x).toBeGreaterThan(0.5);
        expect(endPos.y).toBeLessThan(startY - 0.1);
      });

      it('AC-07b grounded flips false when the character walks off a ledge into open air', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // A short platform: top at y=0 (center -0.5, halfExtent 0.5), spanning
        // x in [-2, 1]. Nothing exists beyond x=1, so walking off the edge with
        // a downward bias drops the character into open air. The grounded flag
        // must follow: true on the platform, false once airborne. This is the
        // falsifiable counterpart to AC-07a (descending slope stays grounded) —
        // snap-to-ground keeps contact across surfaces, but a true void must
        // still report not-grounded. The capsule rests at y=0.8 (top 0 + 0.8).
        spawnStaticBox(world, { pos: [-0.5, -0.5, 0], halfExtents: [1.5, 0.5, 4] });
        const char = spawnCharacter(world, [-1, 0.8, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        // Settle on the platform first.
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);
        expect(ccGrounded(world, char)).toBe(true);

        // Walk toward +x and off the edge with a small gravity bias.
        let wentAirborne = false;
        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.15, -0.05, 0) as never);
          if (!ccGrounded(world, char)) wentAirborne = true;
        }
        // The character left the platform and fell, so grounded flipped to false.
        expect(wentAirborne).toBe(true);
        expect(ccGrounded(world, char)).toBe(false);
        expect(tfPos(world, char).x).toBeGreaterThan(1);
        expect(tfPos(world, char).y).toBeLessThan(0.8);
      });

      it('AC-07c pure horizontal move on flat ground stays grounded', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);

        const actual = pw.moveAndSlide(char, Float32Array.of(0.5, 0, 0) as never);
        // Flat ground: horizontal travel preserved, still grounded.
        expect(actual[0]).toBeCloseTo(0.5, 1);
        expect(ccGrounded(world, char)).toBe(true);
      });
    });

    describe('moveAndSlide error codes (AC-08/09)', () => {
      it('AC-08a dynamic body: throws controller-requires-kinematic with detail', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        const char = spawnCharacter(world, [0, 0, 0], {}, RigidBodyTypeValue.dynamic);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        let caught: unknown;
        try {
          pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('controller-requires-kinematic');
        expect(err.detail?.code).toBe('controller-requires-kinematic');
        if (err.detail?.code === 'controller-requires-kinematic') {
          expect(err.detail.entity).toBe(char);
          expect(err.detail.bodyType).toBe('dynamic');
        }
      });

      it('AC-08b static body: throws controller-requires-kinematic', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        const char = spawnCharacter(world, [0, 0, 0], {}, RigidBodyTypeValue.static);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        let caught: unknown;
        try {
          pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect((caught as PhysicsError).code).toBe('controller-requires-kinematic');
        expect((caught as PhysicsError).detail?.code).toBe('controller-requires-kinematic');
      });

      it('AC-09a unregistered entity: throws body-not-found with detail.entity', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const pw = createRapier3DPhysicsWorld(RAPIER);

        let caught: unknown;
        try {
          pw.moveAndSlide(12345, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('body-not-found');
        if (err.detail?.code === 'body-not-found') {
          expect(err.detail.entity).toBe(12345);
        }
      });

      it('AC-09b kinematic body with no collider: throws collider-not-found (D-2)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const pw = createRapier3DPhysicsWorld(RAPIER);

        // Register a kinematic body directly with NO collider attached.
        const body = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
        );
        body.userData = 7;
        pw.registerBody(7, body.handle);

        let caught: unknown;
        try {
          pw.moveAndSlide(7, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('collider-not-found');
        if (err.detail?.code === 'collider-not-found') {
          expect(err.detail.entity).toBe(7);
        }
      });
    });

    // Read the Rapier body translation for an entity by scanning userData;
    // entityMap is private, so this is the test-side reverse lookup.
    function rapierBodyPos(
      // biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamic module
      pw: any,
      entity: number,
    ): { x: number; y: number; z: number } | undefined {
      let found: { x: number; y: number; z: number } | undefined;
      pw.raw.bodies.forEach(
        (body: { userData: number; translation(): { x: number; y: number; z: number } }) => {
          if (body.userData === entity) {
            const t = body.translation();
            found = { x: t.x, y: t.y, z: t.z };
          }
        },
      );
      return found;
    }

    describe('moveAndSlide syncBackend split (AC-10)', () => {
      it('AC-10a kinematic platform without CharacterController is mirrored', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        // The kinematic mirror drives the collider from GlobalTransform.world (so a
        // ChildOf collider follows its parent), which propagateTransforms
        // populates; register it (createApp always does, and physicsSyncBackend
        // declares `after: propagateTransforms`). For this root platform
        // world == compose(local), so x ends at 5 either way once propagate runs.
        registerPropagateTransforms(world);
        registerPhysicsSystems(world);

        // Platform: kinematic body + collider, NO CharacterController.
        const platform = spawnPairedEntity(
          world,
          { component: Transform as never, data: { pos: [0, 0, 0] } },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
          {
            component: Collider as never,
            data: { shape: 0, halfExtents: [1, 0.5, 1] },
          },
        ).unwrap() as unknown as number;

        // Move the platform via Transform; syncBackend should mirror it.
        world.set(platform as never, Transform as never, { pos: [5, 2, 0] });
        for (let i = 0; i < 30; i++) {
          world.update(1 / 60).unwrap();
          world.update(1 / 60).unwrap();
        }

        const pos = rapierBodyPos(pw, platform);
        expect(pos).toBeDefined();
        expect(pos?.x).toBeCloseTo(5, 0);
        expect(pos?.y).toBeCloseTo(2, 0);
      });

      it('AC-10b kinematic character with CharacterController is NOT mirrored', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        // First update creates the body at origin.
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // moveAndSlide drives the character to ~x=1; syncBackend must not then
        // overwrite the Rapier body back to the (stale) Transform from a prior
        // frame. Set the ECS Transform to a bogus far value to prove the split:
        // a mirroring syncBackend would push the kinematic body to x=99.
        pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        const afterMove = tfPos(world, char).x;

        world.set(char as never, Transform as never, { pos: [99, 99, 99] });
        // Run a tick: if the character row were mirrored, the body would target 99.
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        for (let i = 0; i < 10; i++) pw.step(1 / 60);

        const pos = rapierBodyPos(pw, char);
        expect(pos).toBeDefined();
        // Character body must NOT have been mirrored to the bogus 99.
        expect(pos?.x).toBeLessThan(5);
        expect(afterMove).toBeCloseTo(1, 1);
      });
    });

    describe('moveAndSlide despawn cleanup (AC-11)', () => {
      it('AC-11a despawn clears KCC and caches on the next tick', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // moveAndSlide lazily builds + caches a KCC for this character.
        pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(pw.raw.characterControllers.size).toBe(1);
        expect(pw.kccCache.size).toBe(1);

        // Physics owns cleanup through the next query membership diff; structural
        // despawn does not execute a user callback inside the commit.
        world.despawn(char as never);
        world.update(1 / 60).unwrap();
        expect(pw.raw.characterControllers.size).toBe(0);
        expect(pw.kccCache.size).toBe(0);
      });

      it('AC-11b despawn a character that never moved: removeEntity does not throw', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // No moveAndSlide -> no cached KCC. Despawn must still clean the body.
        const before = pw.getBodyCount();
        expect(before).toBeGreaterThan(0);
        expect(() => world.despawn(char as never)).not.toThrow();
        world.update(1 / 60).unwrap();
        expect(pw.kccCache.size).toBe(0);
      });
    });

    describe('moveAndSlide self-exclude (D-1)', () => {
      it('character does not collide with its own collider', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;

        // The self-exclude predicate omits the character's own collider, so on
        // flat ground a full horizontal request is delivered intact (no
        // self-collision eating the movement).
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);

        expect(actual[0]).toBeCloseTo(1, 1);
      });
    });

    describe('hasBody readiness query', () => {
      it('returns false before the body is built, true after', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = prepareWorld();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        // Before the first physicsSyncBackend tick the body has not been built.
        expect(pw.hasBody(char)).toBe(false);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();

        // After the tick, ensureBody has run and the body exists.
        expect(pw.hasBody(char)).toBe(true);
      });
    });
  });
}

{
  // ─── colliding-entities.test.ts (feat-20260626 M3 engine fix) ───
  //
  // The CollidingEntities component is documented as the contact/sensor set-query
  // path but was never populated: the event queue was constructed + drained on
  // overflow only, and colliders carried no activeEvents/activeCollisionTypes.
  // These tests prove the PhysicsCollisionSync system now writes the overlap set
  // -- specifically the kinematic-sensor vs kinematic-body case the collectathon
  // Core pickup needs (DEFAULT active-collision-types omits KINEMATIC_KINEMATIC).

  describe('colliding-entities.test.ts', () => {
    async function loadOrNull() {
      const RAPIER = await loadRapier3D();
      if ('code' in RAPIER) {
        expect(RAPIER.code).toBe('wasm-load-failed');
        return null;
      }
      return RAPIER;
    }

    it('a kinematic sensor overlapping a kinematic body populates CollidingEntities both ways', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier3DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems(world);

      // A "player" kinematic body + CollidingEntities, sitting at the origin.
      const player = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        },
        { component: CollidingEntities as never, data: { entities: [] } },
      ).unwrap();

      // A "Core" kinematic SENSOR overlapping the player.
      const core = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.sphere, radius: 0.35, isSensor: true },
        },
        { component: CollidingEntities as never, data: { entities: [] } },
      ).unwrap();

      world.update(1 / 60).unwrap();
      // A few ticks: tick 1 builds bodies (ensureBody), the next steps + drains.
      for (let i = 0; i < 4; i++) world.update(1 / 60).unwrap();

      const playerSet = world.get(player, CollidingEntities as never);
      const coreSet = world.get(core, CollidingEntities as never);
      expect(playerSet.ok).toBe(true);
      expect(coreSet.ok).toBe(true);
      if (!playerSet.ok || !coreSet.ok) return;
      expect(Array.from(playerSet.value.entities as Uint32Array)).toContain(core as number);
      expect(Array.from(coreSet.value.entities as Uint32Array)).toContain(player as number);
    });

    it('skips collision participants without CollidingEntities without reading a missing component', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier3DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems(world);

      const subscriber = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        { component: Collider as never, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
        { component: CollidingEntities as never, data: { entities: [] } },
      ).unwrap();
      const plain = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.sphere, radius: 0.5, isSensor: true },
        },
      ).unwrap();

      for (let i = 0; i < 5; i++) world.update(1 / 60).unwrap();
      expect(pw.getCollisionPairs().get(subscriber)).toContain(plain);
      expect(world.hasComponent(plain, CollidingEntities)).toBe(false);

      const get = vi.spyOn(world, 'get');
      pw.writebackCollidingEntities(world, CollidingEntities as never);
      expect(get).not.toHaveBeenCalledWith(plain, CollidingEntities);
      get.mockRestore();
      const colliding = world.get(subscriber, CollidingEntities as never);
      expect(colliding.ok && Array.from(colliding.value.entities as Uint32Array)).toContain(plain);
    });

    it('despawning a collided sensor clears it from the survivor CollidingEntities', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier3DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems(world);

      const player = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        },
        { component: CollidingEntities as never, data: { entities: [] } },
      ).unwrap();
      const core = spawnPairedEntity(
        world,
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.sphere, radius: 0.35, isSensor: true },
        },
        { component: CollidingEntities as never, data: { entities: [] } },
      ).unwrap();

      world.update(1 / 60).unwrap();
      for (let i = 0; i < 4; i++) world.update(1 / 60).unwrap();
      const before = world.get(player, CollidingEntities as never);
      expect(before.ok && Array.from(before.value.entities as Uint32Array)).toContain(
        core as number,
      );

      world.despawn(core);
      for (let i = 0; i < 2; i++) world.update(1 / 60).unwrap();
      const after = world.get(player, CollidingEntities as never);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(Array.from(after.value.entities as Uint32Array)).not.toContain(core as number);
    });
  });
}
