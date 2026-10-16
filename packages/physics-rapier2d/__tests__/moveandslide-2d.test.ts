// packages/physics-rapier2d/__tests__/moveandslide-2d.test.ts
//
// feat-20260617-kinematic-character-controller-move-and-slide . M3 . AC-12
//
// 2D mirror of the 3D moveAndSlide unit tests (physics-rapier3d.unit.test.ts).
// Covers the 2D-symmetric subset: flat walk + grounded, wall block, wall slide,
// gentle/steep slope, autostep, snap-to-ground trajectory + grounded transition,
// error codes, syncBackend split, despawn cleanup, and the D-1 self-exclude
// falsification. 2D differences from 3D: Vec2 deltas (x, y), gravity on -y, the
// "vertical" axis is y and the "ground" is a wide thin box below the character.
//
// Lessons baked in from M2 (see physics-rapier3d.unit.test.ts):
//   - Spawn the capsule at its RESTING height (ground top + half-total), never
//     buried in the floor, or KCC autostep / contact degrade.
//   - `grounded` is a bool schema field -> world.get materializes it as a JS
//     boolean; compare `=== true`, never `!== 0`.
//   - Rapier's computedGrounded() reads false while sliding a continuous slope;
//     the snap effect shows in the trajectory (y tracks the surface), not the
//     flag. The flag is asserted on flat ground (true) and in the void (false).

import { World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  PhysicsError,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { ChildOf, GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../src/rapier-physics-world-2d';
import { loadRapier2D } from '../src/wasm-loader';

type Vec2Tuple = [number, number];

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

describe('moveAndSlide 2D (AC-12)', () => {
  async function loadOrNull() {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return undefined;
    }
    return RAPIER;
  }

  // Capsule character: radius 0.3 + halfHeight 0.5 -> half-total 0.8.
  function spawnCharacter(
    world: World,
    pos: Vec2Tuple,
    cc?: Record<string, number>,
    bodyType: number = RigidBodyTypeValue.kinematic,
  ): number {
    const entity = spawnPairedEntity(world,
        { component: Transform as never, data: { pos: [pos[0], pos[1], 0]} },
        { component: RigidBody as never, data: { type: bodyType } },
        {
          component: Collider as never,
          data: { shape: 2, radius: 0.3, halfHeight: 0.5, friction: 0.5, restitution: 0 },
        },
        { component: CharacterController as never, data: cc ?? {} },
      )
      .unwrap();
    return entity as unknown as number;
  }

  function spawnStaticBox(world: World, pos: Vec2Tuple, halfExtents: Vec2Tuple): number {
    const entity = spawnPairedEntity(world,
        { component: Transform as never, data: { pos: [pos[0], pos[1], 0]} },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
        {
          component: Collider as never,
          data: {
            shape: 0,
            halfExtents: [halfExtents[0], halfExtents[1]],
            friction: 0.5,
            restitution: 0,
          },
        },
      )
      .unwrap();
    return entity as unknown as number;
  }

  // A fixed ramp (raw Rapier body) tilted `slopeDeg` about z, descending toward
  // +x for negative angles. Mirrors the 3D spawnRawRamp.
  // biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamic module
  function spawnRawRamp(pw: any, RAPIER: any, pos: Vec2Tuple, slopeDeg: number): void {
    const rad = (slopeDeg * Math.PI) / 180;
    const body = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pos[0], pos[1]).setRotation(rad),
    );
    pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.5).setFriction(0.5), body);
  }

  function tfPos(world: World, entity: number): { x: number; y: number } {
    const r = world.get(entity as never, Transform as never);
    if (!r.ok) throw new Error('transform missing');
    const v = r.value as { pos: Float32Array };
    return { x: v.pos[0] as number, y: v.pos[1] as number };
  }

  function ccGrounded(world: World, entity: number): boolean {
    const r = world.get(entity as never, CharacterController as never);
    if (!r.ok) throw new Error('CharacterController missing');
    // bool schema field -> JS boolean; compare directly (not `!== 0`).
    return (r.value as Record<string, boolean>).grounded === true;
  }

  describe('basic motion (AC-12: flat / wall / slide)', () => {
    it('teleport places a kinematic character before a same-tick slide', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) throw new Error('Real Rapier is required for this regression');
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);
      const character = spawnCharacter(world, [0, 1]);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      let body: ReturnType<typeof pw.raw.bodies.get> | undefined;
      pw.raw.bodies.forEach((candidate: typeof body) => {
        if (candidate?.userData === character) body = candidate;
      });
      expect(body).toBeDefined();

      pw.teleport(character, Float32Array.of(10, 1) as never, Math.PI / 4);
      expect(body!.translation()).toMatchObject({ x: 10, y: 1 });
      expect(body!.collider(0).translation()).toMatchObject({ x: 10, y: 1 });
      expect(body!.rotation()).toBeCloseTo(Math.PI / 4, 3);
      expect(tfPos(world, character)).toMatchObject({ x: 10, y: 1 });

      const actual = pw.moveAndSlide(character, Float32Array.of(0, -1) as never);
      expect(actual[1]).toBeCloseTo(-1, 3);
      expect(body!.translation().y).toBeCloseTo(0, 3);
      expect(body!.collider(0).translation().y).toBeCloseTo(0, 3);
      world.update(1 / 60).unwrap();
      expect(body!.translation()).toMatchObject({ x: 10, y: 0 });
      pw.dispose();
    });

    it('teleport rotates and moves an offset dynamic collider immediately', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) throw new Error('Real Rapier is required for this regression');
      const pw = createRapier2DPhysicsWorld(RAPIER);
      const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1));
      const collider = pw.raw.createCollider(
        RAPIER.ColliderDesc.ball(0.25).setTranslation(1, 0), body,
      );
      pw.registerBody(101, body.handle);
      body.setLinvel({ x: 4, y: 0 }, true);

      pw.teleport(101, Float32Array.of(10, 1) as never, Math.PI / 2);
      expect(body.translation()).toMatchObject({ x: 10, y: 1 });
      expect(collider.translation().x).toBeCloseTo(10, 3);
      expect(collider.translation().y).toBeCloseTo(2, 3);
      expect(body.linvel()).toMatchObject({ x: 0, y: 0 });
      expect(() => pw.teleport(999, Float32Array.of(0, 0) as never, 0)).toThrowError(PhysicsError);
      expect(() => pw.teleport(101, Float32Array.of(0, 0) as never, Number.NaN)).toThrowError(PhysicsError);
      pw.dispose();
    });

    it('slides against geometry at the teleport destination', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) throw new Error('Real Rapier is required for this regression');
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);
      spawnStaticBox(world, [10.7, 1], [0.1, 1]);
      const character = spawnCharacter(world, [0, 1]);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();

      pw.teleport(character, Float32Array.of(10, 1) as never, 0);
      const actual = pw.moveAndSlide(character, Float32Array.of(1, 0) as never);
      expect(actual[0]).toBeLessThan(0.5);
      expect(tfPos(world, character).x).toBeLessThan(10.5);
      pw.dispose();
    });

    it('writes a parented character teleport as local Transform position', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) throw new Error('Real Rapier is required for this regression');
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      const parent = world.spawn({ component: Transform, data: { pos: [5, 0, 0] } }).unwrap();
      const child = spawnPairedEntity(world,
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: ChildOf, data: { parent } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
        { component: Collider, data: { shape: 2, radius: 0.3, halfHeight: 0.5 } },
        { component: CharacterController, data: {} },
      ).unwrap() as number;
      registerPropagateTransforms(world);
      registerPhysicsSystems2D(world);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();

      pw.teleport(child, Float32Array.of(10, 1) as never, 0);
      expect(tfPos(world, child)).toMatchObject({ x: 5, y: 1 });
      pw.moveAndSlide(child, Float32Array.of(1, 0) as never);
      expect(tfPos(world, child).x).toBeCloseTo(6, 3);
      world.update(1 / 60).unwrap();
      let bodyX: number | undefined;
      pw.raw.bodies.forEach((body: { userData: number; translation(): { x: number } }) => {
        if (body.userData === child) bodyX = body.translation().x;
      });
      expect(bodyX).toBeCloseTo(11, 3);
      pw.dispose();
    });

    it('teleport moves and rotates a static body with its offset collider', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) throw new Error('Real Rapier is required for this regression');
      const pw = createRapier2DPhysicsWorld(RAPIER);
      const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1));
      const collider = pw.raw.createCollider(
        RAPIER.ColliderDesc.ball(0.25).setTranslation(1, 0), body,
      );
      pw.registerBody(102, body.handle);
      pw.teleport(102, Float32Array.of(10, 1) as never, Math.PI / 2);
      expect(body.translation()).toMatchObject({ x: 10, y: 1 });
      expect(body.rotation()).toBeCloseTo(Math.PI / 2, 3);
      expect(collider.translation().x).toBeCloseTo(10, 3);
      expect(collider.translation().y).toBeCloseTo(2, 3);
      pw.step(1 / 60);
      expect(body.translation()).toMatchObject({ x: 10, y: 1 });
      pw.dispose();
    });

    it('AC-12a flat walk: actualDelta tracks desiredDelta and grounded=true', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // Ground top at y=-0.35 -> rest center y=0.45.
      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      const char = spawnCharacter(world, [0, 0.45]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      const actual = pw.moveAndSlide(char, Float32Array.of(1, 0) as never);

      expect(actual[0]).toBeGreaterThan(0.9);
      expect(Math.abs(actual[1] ?? 0)).toBeLessThan(0.05);
      expect(ccGrounded(world, char)).toBe(true);
      expect(tfPos(world, char).x).toBeGreaterThan(0.9);
    });

    it('AC-12b walking into a wall is blocked (x barely advances)', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      // Vertical wall just ahead of the character (left face at x=0.7).
      spawnStaticBox(world, [0.8, 0.5], [0.1, 1]);
      const char = spawnCharacter(world, [0, 0.45]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.1) as never);

      let totalX = 0;
      for (let i = 0; i < 20; i++) {
        const a = pw.moveAndSlide(char, Float32Array.of(0.1, 0) as never);
        totalX += a[0] ?? 0;
      }
      // The wall stops forward progress well short of the unobstructed 20*0.1=2.
      expect(totalX).toBeLessThan(0.6);
    });

    it('AC-12c sliding along a wall: blocked x but free perpendicular motion', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      // Tall wall whose left face is at x=0.4; character (radius 0.3) spawned at
      // x=0.1 is already in contact, so any +x push is immediately blocked.
      spawnStaticBox(world, [1.4, 0.5], [1, 2]);
      const char = spawnCharacter(world, [0.1, 0.45]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      // Press into the wall so the character settles flush against it.
      pw.moveAndSlide(char, Float32Array.of(0.3, 0) as never);

      // Diagonal into the wall: x is blocked, y slides freely.
      const a = pw.moveAndSlide(char, Float32Array.of(0.5, 0.5) as never);
      expect(a[0] ?? 0).toBeLessThan(0.2); // x mostly blocked
      expect(a[1] ?? 0).toBeGreaterThan(0.3); // y slides
    });
  });

  describe('slope (AC-12: gentle / steep)', () => {
    it('AC-12d gentle slope (< maxSlopeClimbDeg=45): y rises, not blocked', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // 30deg ramp ascending toward +x; surface near x≈0.8 is around y=0.
      spawnRawRamp(pw, RAPIER, [2, -0.85], 30);
      const char = spawnCharacter(world, [0.7, 0.05]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.15) as never);

      const before = tfPos(world, char).y;
      for (let i = 0; i < 30; i++) {
        pw.moveAndSlide(char, Float32Array.of(0.12, -0.01) as never);
      }
      const after = tfPos(world, char).y;
      expect(after).toBeGreaterThan(before);
      expect(tfPos(world, char).x).toBeGreaterThan(0.5);
    });

    it('AC-12e steep slope (> maxSlopeClimbDeg=45): horizontal travel is blocked', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // 60deg ramp — steeper than default maxSlopeClimbDeg=45.
      spawnRawRamp(pw, RAPIER, [1.5, -0.85], 60);
      const char = spawnCharacter(world, [0.7, 0.05]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.15) as never);

      let totalX = 0;
      for (let i = 0; i < 30; i++) {
        const a = pw.moveAndSlide(char, Float32Array.of(0.1, -0.02) as never);
        totalX += a[0] ?? 0;
      }
      // Cannot climb a too-steep slope: forward progress stalls well short of 3.0.
      expect(totalX).toBeLessThan(1.5);
    });
  });

  describe('autostep + snap-to-ground (AC-12)', () => {
    it('AC-12f low step (0.2 < autoStepMaxHeight=0.3): character climbs it', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // Ground top at y=-0.35 -> rest center 0.45; ledge top at y=-0.25.
      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      spawnStaticBox(world, [2, -0.45], [1, 0.2]);
      const char = spawnCharacter(world, [0, 0.45]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.15) as never);

      const before = tfPos(world, char).y;
      let peakY = before;
      let reachedLedge = false;
      for (let i = 0; i < 40; i++) {
        pw.moveAndSlide(char, Float32Array.of(0.1, -0.02) as never);
        const p = tfPos(world, char);
        if (p.y > peakY) peakY = p.y;
        if (p.x > 1.5 && p.x < 2.5) reachedLedge = true;
      }
      expect(peakY).toBeGreaterThan(before + 0.05);
      expect(reachedLedge).toBe(true);
    });

    it('AC-12g high step (0.5 > autoStepMaxHeight=0.3): character is blocked', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [4, 0.5]);
      spawnStaticBox(world, [2, -0.05], [2, 0.5]); // 0.5m-tall ledge top
      const char = spawnCharacter(world, [0, 0.45]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.15) as never);

      for (let i = 0; i < 25; i++) {
        pw.moveAndSlide(char, Float32Array.of(0.1, -0.05) as never);
      }
      // Could not step up the 0.5m ledge — stays near the lower ground.
      expect(tfPos(world, char).y).toBeLessThan(0.7);
    });

    it('AC-12h snap-to-ground keeps the character on a descending slope (pure horizontal move pulls y down)', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnRawRamp(pw, RAPIER, [4, -1.0], -20);
      const char = spawnCharacter(world, [0, 0.1]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.1) as never);
      const startY = tfPos(world, char).y;

      // Walk forward with NO vertical input — snap pulls the character down the
      // ramp, so y decreases as x advances (see header note on grounded flag).
      for (let i = 0; i < 20; i++) {
        pw.moveAndSlide(char, Float32Array.of(0.08, 0) as never);
      }
      const endPos = tfPos(world, char);
      expect(endPos.x).toBeGreaterThan(0.5);
      expect(endPos.y).toBeLessThan(startY - 0.1);
    });

    it('AC-12i grounded flips false when the character walks off a ledge into open air', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // Short platform: top at y=0 (center -0.5), spanning x in [-2, 1].
      spawnStaticBox(world, [-0.5, -0.5], [1.5, 0.5]);
      const char = spawnCharacter(world, [-1, 0.8]);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.1) as never);
      expect(ccGrounded(world, char)).toBe(true);

      let wentAirborne = false;
      for (let i = 0; i < 25; i++) {
        pw.moveAndSlide(char, Float32Array.of(0.15, -0.05) as never);
        if (!ccGrounded(world, char)) wentAirborne = true;
      }
      expect(wentAirborne).toBe(true);
      expect(ccGrounded(world, char)).toBe(false);
      expect(tfPos(world, char).x).toBeGreaterThan(1);
      expect(tfPos(world, char).y).toBeLessThan(0.8);
    });
  });

  describe('error codes (AC-12)', () => {
    it('AC-12j moveAndSlide on a non-kinematic body throws controller-requires-kinematic', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      const char = spawnCharacter(world, [0, 0.45], {}, RigidBodyTypeValue.dynamic);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();

      try {
        pw.moveAndSlide(char, Float32Array.of(0.1, 0) as never);
        expect.unreachable('moveAndSlide should throw on a dynamic body');
      } catch (e) {
        expect(e).toBeInstanceOf(PhysicsError);
        expect((e as PhysicsError).code).toBe('controller-requires-kinematic');
      }
    });

    it('AC-12k moveAndSlide on an unregistered entity throws body-not-found', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      try {
        pw.moveAndSlide(99999, Float32Array.of(0.1, 0) as never);
        expect.unreachable('moveAndSlide should throw on an unregistered entity');
      } catch (e) {
        expect(e).toBeInstanceOf(PhysicsError);
        expect((e as PhysicsError).code).toBe('body-not-found');
      }
    });
  });

  describe('syncBackend split + despawn cleanup (AC-12)', () => {
    it('AC-12l a non-character kinematic body still mirrors via syncBackend (no regression)', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      // Plain kinematic body (no CharacterController) — Transform drives it.
      const platform = spawnPairedEntity(world,
          { component: Transform as never, data: { pos: [5, 2, 0]} },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
          { component: Collider as never, data: { shape: 0, halfExtents: [1, 0.2] } },
        )
        .unwrap() as unknown as number;

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();

      const record = (pw as unknown as { entityMap: Map<number, { bodyHandle: number }> }).entityMap.get(
        platform,
      );
      expect(record).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API
      const body = (pw.raw as any).bodies.get(record?.bodyHandle);
      const t = body.translation();
      expect(t.x).toBeCloseTo(5, 1);
      expect(t.y).toBeCloseTo(2, 1);
    });

    it('AC-12m despawning a character clears its cached KCC on the next tick', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      const char = spawnCharacter(world, [0, 0.45]);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0.1, 0) as never);

      expect(pw.kccCache.size).toBe(1);
      world.despawn(char as never);
      // Physics owns cleanup through the next query membership diff; structural
      // despawn does not execute a user callback inside the commit.
      world.update(1 / 60).unwrap();
      expect(pw.kccCache.size).toBe(0);
      expect(pw.getBodyCount()).toBe(1); // only the static ground remains
    });
  });

  describe('D-1 self-exclude (AC-12)', () => {
    it('AC-12n character does not collide with its own collider', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      const char = spawnCharacter(world, [0, 0.45]);
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      pw.moveAndSlide(char, Float32Array.of(0, -0.1) as never);

      // The self-exclude predicate omits the character's own collider, so a
      // horizontal request on flat ground is delivered intact.
      const prod = pw.moveAndSlide(char, Float32Array.of(0.1, 0) as never);
      expect(prod[0] ?? 0).toBeGreaterThan(0.05);
    });
  });

  describe('hasBody readiness query (2D)', () => {
    it('returns false before the body is built, true after', async () => {
      const RAPIER = await loadOrNull();
      if (!RAPIER) return;
      const world = prepareWorld();
      const pw = createRapier2DPhysicsWorld(RAPIER);
      world.insertResource('PhysicsWorld', pw);
      registerPhysicsSystems2D(world);

      spawnStaticBox(world, [0, -0.85], [10, 0.5]);
      const char = spawnCharacter(world, [0, 0.45]);

      // Before the first physicsSyncBackend tick the body has not been built.
      expect(pw.hasBody(char)).toBe(false);

      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();

      // After the tick, ensureBody has run and the body exists.
      expect(pw.hasBody(char)).toBe(true);
    });
  });
});
