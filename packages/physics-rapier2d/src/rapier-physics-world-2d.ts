import { componentDefinition, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
// @forgeax/engine-physics-rapier2d — RapierPhysicsWorld2D class and three-phase
// tick systems (syncBackend / stepSimulation / writeback).
//
// Mirrors packages/physics-rapier3d/ with 2D adaptations (research Finding 12):
//   - Vec2 instead of Vec3 for translations
//   - scalar angle instead of Quat for rotation
//   - Rapier2D world.step() (no z-axis)
//
// Three-phase pipeline (plan-strategy D-1):
//   1. syncBackend: reconcile authored bodies and kinematic positions.
//   2. stepSimulation: call rapierWorld.step(eventQueue).
//   3. writeback: read Rapier body positions (dynamic only).

import type { Component, EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { mat4, quat, type Vec2, type Vec3Like, vec2, vec3 } from '@forgeax/engine-math';
import type {
  ColliderData,
  ColliderSnapshot,
  PhysicsWorld2D,
  RaycastHit2D,
} from '@forgeax/engine-physics';
import {
  CharacterController,
  type CharacterControllerData,
  Collider,
  CollidingEntities,
  colliderShapeFromF32,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  PhysicsSet,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
  snapshotCollider,
  validateAdditionalSolverIterations,
} from '@forgeax/engine-physics';
import { ChildOf, GlobalTransform } from '@forgeax/engine-scene';
import type { Rapier2DModule } from './wasm-loader';

interface Rapier2DKinematicControllerState {
  readonly entity: number;
  readonly offset: number;
}

interface PhysicsEntityRecord {
  bodyHandle: number;
}

interface PhysicsTransform2D {
  readonly position: { readonly x: number; readonly y: number };
  readonly rotation: number;
  readonly scale: { readonly x: number; readonly y: number };
}

export interface Rapier2DCollisionEvent {
  readonly type: 'started' | 'stopped';
  readonly entityA: number;
  readonly entityB: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierWorld2D = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierEventQueue = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierRigidBody2D = any;

const DEG_TO_RAD = Math.PI / 180;

function localPositionForWorld2D(
  world: World,
  entity: EntityHandle,
  transform: Component,
  target: { readonly x: number; readonly y: number },
): ReturnType<typeof vec3.create> {
  const read = world.get(entity, transform);
  const current = read.ok ? (read.value as unknown as { pos: ArrayLike<number> }) : undefined;
  const local = vec3.create(target.x, target.y, current?.pos[2] ?? 0);
  if (!world.hasComponent(entity, ChildOf)) return local;
  const child = world.get(entity, ChildOf).unwrap();
  const parent = world.get(child.parent as EntityHandle, GlobalTransform).unwrap().world;
  const currentWorld = vec3.create();
  mat4.transformPoint(
    currentWorld,
    parent,
    vec3.create(current?.pos[0] ?? 0, current?.pos[1] ?? 0, current?.pos[2] ?? 0),
  );
  local[2] = currentWorld[2] ?? 0;
  const inverse = mat4.create();
  mat4.invert(inverse, parent);
  mat4.transformPoint(local, inverse, local);
  return local;
}

/**
 * Re-apply all KCC setters from the component tuning every call (plan-strategy
 * D-7: full reset, no dirty tracking). Mirrors the 3D applyKccTuning; the KCC
 * API is dimension-agnostic. Degrees -> radians for the two slope setters;
 * offset / autostep / snap pass through as world units. A zero value for
 * auto-step / snap calls `disable*()` rather than `enable*(0)`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
function applyKccTuning(ctrl: any, cc: CharacterControllerData): void {
  ctrl.setMaxSlopeClimbAngle(cc.maxSlopeClimbDeg * DEG_TO_RAD);
  ctrl.setMinSlopeSlideAngle(cc.minSlopeSlideDeg * DEG_TO_RAD);
  ctrl.setSlideEnabled(true);
  ctrl.setApplyImpulsesToDynamicBodies(true);
  if (cc.autoStepMaxHeight === 0) {
    ctrl.disableAutostep();
  } else {
    ctrl.enableAutostep(cc.autoStepMaxHeight, cc.autoStepMinWidth, false); // D-7: includeDynamicBodies=false
  }
  if (cc.snapToGroundDist === 0) {
    ctrl.disableSnapToGround();
  } else {
    ctrl.enableSnapToGround(cc.snapToGroundDist);
  }
}

/**
 * Map a Rapier 2D RigidBodyType enum value to the engine's string union for the
 * `controller-requires-kinematic` error detail.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier module enum from dynamic module
function rapierBodyTypeToString(rapier: any, bodyType: number): string {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}

export class RapierPhysicsWorld2D implements PhysicsWorld2D {
  raw: RapierWorld2D;

  private readonly rapierModule: Rapier2DModule;

  /** Entity (raw number) -> PhysicsEntityRecord mapping. */
  private readonly entityMap = new Map<number, PhysicsEntityRecord>();

  /**
   * Entities whose dynamic pose is written back at the next writeback even if
   * Rapier no longer reports them active: bodies awake at the previous
   * writeback (their final pose before sleeping), newly registered bodies, and
   * dynamic bodies whose ECS Transform was overwritten (Rapier owns that pose).
   */
  private poseWritebackEntities = new Set<number>();
  private activeWritebackEntities = new Set<number>();
  private poseEdits:
    | { readonly world: World; readonly query: Iterable<{ entity: EntityHandle }> }
    | undefined;

  private eventQueue: RapierEventQueue;

  private readonly collisionPairs = new Map<number, Set<number>>();

  private readonly pendingCollisionEvents: Rapier2DCollisionEvent[] = [];

  private readonly collisionEventHistory: Rapier2DCollisionEvent[] = [];

  private currentGravity: { x: number; y: number };

  /**
   * Lazily-built Rapier KinematicCharacterController per character entity
   * (plan-strategy D-1/D-3, 2D variant). `moveAndSlide` creates one on first
   * call; the `Collider.onRemove` hook clears it on despawn. Public so AC-12
   * despawn tests can assert `kccCache.size === 0`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  readonly kccCache = new Map<number, any>();

  private readonly kccOffsets = new Map<number, number>();

  /**
   * ECS World + components wired in by `registerPhysicsSystems2D`, so
   * `moveAndSlide` can read CharacterController tuning and write Transform +
   * grounded back. Undefined until systems are registered — the input-validation
   * error paths fire before these are read, so direct `pw.moveAndSlide()` calls
   * in error tests need no World.
   */
  private moveContext: { world: World; transform: Component } | undefined;

  constructor(rapier: Rapier2DModule) {
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81 }) as RapierWorld2D;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81 };
  }

  // ─── PhysicsWorld2D interface ──────────────────────────────────────────

  setGravity(gravity: Vec2): void {
    const x = gravity[0] ?? 0;
    const y = gravity[1] ?? 0;
    this.raw.gravity = { x, y };
    this.currentGravity = { x, y };
  }

  getGravity(): Vec2 {
    const { x, y } = this.currentGravity;
    return vec2.create(x, y);
  }

  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined {
    const RAPIER = this.rapierModule;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
    const RayCtor = (RAPIER as any).Ray as new (
      origin: { x: number; y: number },
      dir: { x: number; y: number },
    ) => { pointAt(t: number): { x: number; y: number } };
    const ray = new RayCtor(
      { x: origin[0] ?? 0, y: origin[1] ?? 0 },
      { x: direction[0] ?? 0, y: direction[1] ?? 0 },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal (2D)
    const hit = (this.raw as any).castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      filterMask,
    ) as {
      collider: { parent(): { userData: number } | null };
      timeOfImpact: number;
      normal: { x: number; y: number };
    } | null;

    if (hit === null) return undefined;

    const point = ray.pointAt(hit.timeOfImpact);
    // `hit.collider.parent()` already returns the owning RigidBody OBJECT (compat
    // build), whose userData holds the ECS entity — read it directly. The prior
    // code treated the object as a body HANDLE and re-resolved it via
    // `bodies.get(...)`, which returned a DIFFERENT body → the wrong entity
    // (identical bug + fix as the 3D backend, solo round-22).
    const colliderParentBody = hit.collider.parent();
    const entity = colliderParentBody !== null ? colliderParentBody.userData : 0;

    return {
      entity,
      point: vec2.create(point.x, point.y),
      normal: vec2.create(hit.normal.x, hit.normal.y),
      timeOfImpact: hit.timeOfImpact,
    };
  }

  teleport(entity: number, position: Vec2, rotation: number): void {
    const record = this.entityMap.get(entity);
    const body =
      record === undefined
        ? null
        : (this.raw.bodies.get(record.bodyHandle) as RapierRigidBody2D | null);
    if (!body) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    if (
      position.length !== 2 ||
      !Array.from(position).every(Number.isFinite) ||
      !Number.isFinite(rotation)
    ) {
      throw new PhysicsError({
        code: 'invalid-body-config',
        expected: 'a finite 2D teleport position and rotation',
        hint: PHYSICS_ERROR_HINTS['invalid-body-config'],
        detail: {
          code: 'invalid-body-config',
          field: 'teleport',
          value: { position: Array.from(position), rotation },
        },
      });
    }
    const target = { x: position[0] ?? 0, y: position[1] ?? 0 };
    // Compute the ECS local pose before mutating native state.
    const ctx = this.moveContext;
    const local = ctx
      ? localPositionForWorld2D(ctx.world, entity as EntityHandle, ctx.transform, target)
      : vec3.create(target.x, target.y, 0);
    const localRotation = quat.fromAxisAngle(quat.create(), vec3.create(0, 0, 1), rotation);
    if (ctx?.world.hasComponent(entity as EntityHandle, ChildOf)) {
      const child = ctx.world.get(entity as EntityHandle, ChildOf).unwrap();
      const parent = ctx.world.get(child.parent as EntityHandle, GlobalTransform).unwrap().world;
      const parentPosition = vec3.create();
      const parentRotation = quat.create();
      const parentScale = vec3.create();
      mat4.decompose(parentPosition, parentRotation, parentScale, parent);
      quat.invert(parentRotation, parentRotation);
      quat.multiply(localRotation, parentRotation, localRotation);
    }

    if (body.bodyType() === this.rapierModule.RigidBodyType.KinematicPositionBased) {
      body.setNextKinematicTranslation(target);
      body.setNextKinematicRotation(rotation);
    }
    body.setTranslation(target, true);
    body.setRotation(rotation, true);
    if (body.bodyType() !== this.rapierModule.RigidBodyType.Fixed) {
      body.setLinvel({ x: 0, y: 0 }, false);
      body.setAngvel(0, false);
    }
    // Project only this body's attached colliders; a teleport can run every
    // fixed tick, so a world-wide modified-body propagation is too broad.
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    for (let index = 0; index < body.numColliders(); index++) {
      const attached = body.collider(index);
      const offset = attached.translationWrtParent();
      const relativeRotation = attached.rotationWrtParent();
      if (offset === null || relativeRotation === null) continue;
      attached.setTranslation({
        x: target.x + c * offset.x - s * offset.y,
        y: target.y + s * offset.x + c * offset.y,
      });
      attached.setRotation(rotation + relativeRotation);
    }
    if (ctx)
      ctx.world
        .set(entity as EntityHandle, ctx.transform, { pos: local, quat: localRotation })
        .unwrap();
    if (body.isDynamic()) this.poseWritebackEntities.add(entity);
  }

  step(deltaTime: number): void {
    void deltaTime;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
    (this.raw as any).step(this.eventQueue);
    this.drainRapierCollisionEvents();
  }

  private drainRapierCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      const entityA = this.colliderHandleToEntity(handle1);
      const entityB = this.colliderHandleToEntity(handle2);
      if (entityA === undefined || entityB === undefined) return;
      const changed = started
        ? this.addCollisionPair(entityA, entityB)
        : this.removeCollisionPair(entityA, entityB);
      if (!changed) return;
      this.pushCollisionEvent({
        type: started ? 'started' : 'stopped',
        entityA,
        entityB,
      });
    });
  }

  private colliderHandleToEntity(colliderHandle: number): number | undefined {
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.getCollider from dynamically loaded module
    const collider = (this.raw as any).getCollider(colliderHandle) as {
      parent(): { userData: number } | null;
    } | null;
    const body = collider?.parent();
    return body?.userData;
  }

  private addCollisionPair(entityA: number, entityB: number): boolean {
    let first = this.collisionPairs.get(entityA);
    if (!first) {
      first = new Set<number>();
      this.collisionPairs.set(entityA, first);
    }
    if (first.has(entityB)) return false;
    first.add(entityB);
    let second = this.collisionPairs.get(entityB);
    if (!second) {
      second = new Set<number>();
      this.collisionPairs.set(entityB, second);
    }
    second.add(entityA);
    return true;
  }

  private removeCollisionPair(entityA: number, entityB: number): boolean {
    const first = this.collisionPairs.get(entityA);
    const second = this.collisionPairs.get(entityB);
    const firstChanged = first?.delete(entityB) === true;
    const secondChanged = second?.delete(entityA) === true;
    if (!first) this.collisionPairs.set(entityA, new Set());
    if (!second) this.collisionPairs.set(entityB, new Set());
    return firstChanged || secondChanged;
  }

  private pushCollisionEvent(event: Rapier2DCollisionEvent): void {
    this.pendingCollisionEvents.push(event);
    this.collisionEventHistory.push(event);
  }

  drainCollisionEvents(): Rapier2DCollisionEvent[] {
    return this.pendingCollisionEvents.splice(0);
  }

  getCollisionPairs(): Map<number, Set<number>> {
    return new Map([...this.collisionPairs].map(([entity, others]) => [entity, new Set(others)]));
  }

  getCollisionEventHistory(): readonly Rapier2DCollisionEvent[] {
    return [...this.collisionEventHistory];
  }

  getKinematicControllerStates(): readonly Rapier2DKinematicControllerState[] {
    return [...this.kccOffsets]
      .sort(([first], [second]) => first - second)
      .map(([entity, offset]) => ({ entity, offset }));
  }

  dispose(): void {
    if (typeof this.raw.free === 'function') this.raw.free();
    if (typeof this.eventQueue.free === 'function') this.eventQueue.free();
    this.kccCache.clear();
    this.kccOffsets.clear();
  }

  writebackCollidingEntities(world: World, component: Component = CollidingEntities): void {
    for (const [entity, others] of this.collisionPairs) {
      const handle = entity as EntityHandle;
      if (!world.hasComponent(handle, component)) continue;
      world.set(handle, component, { entities: [...others] });
    }
  }

  getBodyCount(): number {
    return this.entityMap.size;
  }

  hasBody(entity: number): boolean {
    return this.entityMap.has(entity);
  }

  /**
   * Wire the ECS World + Transform / CharacterController components needed by
   * `moveAndSlide` to read tuning and write back pose + grounded. Called once by
   * `registerPhysicsSystems2D` (plan-strategy D-1/D-7).
   */
  setMoveContext(world: World, transform: Component): void {
    this.moveContext = { world, transform };
  }

  moveAndSlide(entity: number, desiredDelta: Vec2): Vec2 {
    return this.computeMove(entity, desiredDelta);
  }

  /**
   * Shared moveAndSlide core (plan-strategy D-1/D-2/D-4/D-6/D-7), 2D variant.
   * Mirrors the 3D computeMove with Vec2 movement (x, y only — no z).
   *
   * The three Fail-Fast entry checks (body / collider / kinematic) throw
   * structured PhysicsError before the World is read, so error-path tests can
   * call this without registered systems.
   */
  private computeMove(entity: number, desiredDelta: Vec3Like): Vec2 {
    // ── Fail-Fast entry checks (charter P3) ──
    const record = this.entityMap.get(entity);
    if (!record) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
    if (!body) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    if (body.numColliders() === 0) {
      // D-2: body exists but carries no collider — more precise than body-not-found.
      throw new PhysicsError({
        code: 'collider-not-found',
        expected: 'a Collider attached to this entity body',
        hint: PHYSICS_ERROR_HINTS['collider-not-found'],
        detail: { code: 'collider-not-found', entity },
      });
    }
    const RAPIER = this.rapierModule;
    if (body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) {
      throw new PhysicsError({
        code: 'controller-requires-kinematic',
        expected: "RigidBody.type === 'kinematic'",
        hint: PHYSICS_ERROR_HINTS['controller-requires-kinematic'],
        detail: {
          code: 'controller-requires-kinematic',
          entity,
          bodyType: rapierBodyTypeToString(RAPIER, body.bodyType()),
        },
      });
    }

    const collider = body.collider(0); // D-4: zero-schema reverse lookup

    // ── Read CharacterController tuning + lazily build/configure the KCC ──
    const cc = this.readCharacterController(entity);
    const ctrl = this.ensureKcc(entity, cc.offset);
    applyKccTuning(ctrl, cc);

    // ── Step 1: solve collisions (D-1 self-exclude predicate) ──
    // Rapier's filter predicate returns true to INCLUDE a collider as a
    // potential obstacle, false to skip it; this excludes the character's own
    // collider so it never collides with itself.
    const delta = { x: desiredDelta[0] ?? 0, y: desiredDelta[1] ?? 0 };
    ctrl.computeColliderMovement(
      collider,
      delta,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Rapier Collider in filter predicate
      (other: any) => other.handle !== collider.handle,
    );

    // ── Step 2/3: read corrected movement + grounded ──
    const movement = ctrl.computedMovement() as { x: number; y: number };
    const grounded = ctrl.computedGrounded() as boolean;

    // ── Write back: push the kinematic body + ECS Transform + grounded ──
    const t = body.translation();
    const next = { x: t.x + movement.x, y: t.y + movement.y };
    // setNextKinematicTranslation feeds the physics step pipeline; setTranslation
    // advances the body + its collider immediately so consecutive moveAndSlide
    // calls (without an intervening world.step) see the updated pose for the next
    // collision solve + grounded check.
    body.setNextKinematicTranslation(next);
    body.setTranslation(next, true);
    // setTranslation marks the body modified but does not re-place its collider
    // in the collider set; propagate so the next computeColliderMovement
    // shape-casts the character from its updated pose.
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.propagateModifiedBodyPositionsToColliders
    (this.raw as any).propagateModifiedBodyPositionsToColliders();

    const ctx = this.moveContext;
    if (ctx) {
      // D-6: writeback Result ignored — entry checks already guard liveness.
      ctx.world.set(entity as EntityHandle, ctx.transform, {
        pos: localPositionForWorld2D(ctx.world, entity as EntityHandle, ctx.transform, next),
      });
      ctx.world.set(entity as EntityHandle, CharacterController, { grounded });
    }

    return vec2.create(movement.x, movement.y);
  }

  /**
   * Read CharacterController tuning fields for an entity from the ECS World,
   * falling back to schema defaults when the World is not wired (defensive;
   * the kinematic check upstream means a valid character always has the World).
   */
  private readCharacterController(entity: number): CharacterControllerData {
    const r = this.moveContext?.world.get(entity as EntityHandle, CharacterController);
    if (r?.ok) return r.value;
    // The ECS token owns the defaults; keep the defensive no-context path on
    // that projection so 2D cannot drift from the shared CharacterController schema.
    return componentDefinition(CharacterController).defaults as unknown as CharacterControllerData;
  }

  /**
   * Lazily build a Rapier 2D KinematicCharacterController for `entity` (cached).
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  private ensureKcc(entity: number, offset: number): any {
    const cached = this.kccCache.get(entity);
    if (cached) return cached;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCharacterController
    const ctrl = (this.raw as any).createCharacterController(offset);
    this.kccCache.set(entity, ctrl);
    this.kccOffsets.set(entity, offset);
    return ctrl;
  }

  /**
   * Remove an entity's cached KCC and unregister it from the Rapier world
   * (plan-strategy D-3). Idempotent — safe for entities that never moved.
   */
  removeKccController(entity: number): void {
    const ctrl = this.kccCache.get(entity);
    this.kccOffsets.delete(entity);
    if (!ctrl) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeCharacterController
    (this.raw as any).removeCharacterController(ctrl);
    this.kccCache.delete(entity);
  }

  // ─── ECS->Rapier bridge (D-2, 2D variant) ────────────────────────────

  /**
   * Ensure a Rapier 2D body and collider exist for an ECS entity (idempotent).
   *
   * 2D variant of the M1 3D ensureBody: Vec2 {x,y} instead of Vec3 {x,y,z},
   * Rapier2D ColliderDesc.{cuboid(hx,hy), ball(radius), capsule(halfHeight,radius)},
   * scalar rotation from transform quat (extracted via atan2 for z-axis angle).
   *
   * Plan-strategy C-3 symmetry with M1, D-2 + D-5 2D adaptations.
   */
  ensureBody(
    entity: number,
    transform: PhysicsTransform2D,
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
      additionalSolverIterations?: number;
    },
    collider: ColliderSnapshot,
  ): void {
    const solverIterations = validateAdditionalSolverIterations(
      rigidBody.additionalSolverIterations ?? 0,
    );
    const existing = this.entityMap.get(entity);
    if (existing) {
      const body = this.raw.getRigidBody(existing.bodyHandle);
      if (body.additionalSolverIterations() !== solverIterations)
        body.setAdditionalSolverIterations(solverIterations);
      return;
    }
    if (collider.shape > 2)
      throw new PhysicsError({
        code: 'invalid-body-config',
        expected: 'a 2D collider shape',
        hint: 'Use rapier-3d for 3D collision shapes.',
        detail: { code: 'invalid-body-config', field: 'shape', value: collider.shape },
      });

    const RAPIER = this.rapierModule;

    // ── Create RigidBodyDesc (2D) ──
    const rbType = rigidBodyTypeFromF32(rigidBody.type);
    let body: RapierRigidBody2D;
    switch (rbType) {
      case 'dynamic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.dynamic()
          .setTranslation(transform.position.x, transform.position.y)
          .setRotation(transform.rotation)
          .setLinearDamping(rigidBody.linearDamping)
          .setAngularDamping(rigidBody.angularDamping)
          .setGravityScale(rigidBody.gravityScale);
        if (rigidBody.mass > 0) {
          desc.setAdditionalMass(rigidBody.mass);
        }
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'static': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.fixed()
          .setTranslation(transform.position.x, transform.position.y)
          .setRotation(transform.rotation);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'kinematic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased()
          .setTranslation(transform.position.x, transform.position.y)
          .setRotation(transform.rotation);
        // CCD sweeps the collider along its per-step kinematic translation so a
        // fast mover reliably contacts dynamics instead of tunneling through
        // them on discrete steps.
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
    }

    body.setAdditionalSolverIterations(solverIterations);
    body.userData = entity;
    this.registerBody(entity, body.handle);

    // ── Create ColliderDesc (2D) ──
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    const cShape = colliderShapeFromF32(collider.shape);
    switch (cShape) {
      case 'cylinder':
      case 'cone':
      case 'convexHull':
      case 'trimesh':
        throw new PhysicsError({
          code: 'invalid-body-config',
          expected: 'Rapier2D Collider uses cuboid, sphere or capsule',
          hint: 'Use rapier-3d for 3D collision shapes.',
          detail: { code: 'invalid-body-config', field: 'shape', value: collider.shape },
        });
      case 'cuboid': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.cuboid(
          collider.halfExtents[0] * scaleX,
          collider.halfExtents[1] * scaleY,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'sphere': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.ball(collider.radius * Math.max(scaleX, scaleY))
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'capsule': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.capsule(
          collider.halfHeight * scaleY,
          collider.radius * scaleX,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
    }
  }

  /** Synchronize a static or kinematic Rapier body from its resolved 2D Transform pose. */
  syncAuthoredPose(
    entity: number,
    transform: PhysicsTransform2D,
    collider: ColliderSnapshot,
    bodyType: 'static' | 'kinematic',
  ): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
    if (!body) return;

    if (bodyType === 'static') {
      body.setTranslation(transform.position, true);
      body.setRotation(transform.rotation, true);
    } else {
      body.setNextKinematicTranslation(transform.position);
      body.setNextKinematicRotation(transform.rotation);
    }

    const rapierCollider = body.collider(0);
    if (!rapierCollider) return;
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    switch (colliderShapeFromF32(collider.shape)) {
      case 'cylinder':
      case 'cone':
      case 'convexHull':
      case 'trimesh':
        throw new PhysicsError({
          code: 'invalid-body-config',
          expected: 'Rapier2D Collider uses cuboid, sphere or capsule',
          hint: 'Use rapier-3d for 3D collision shapes.',
          detail: { code: 'invalid-body-config', field: 'shape', value: collider.shape },
        });
      case 'cuboid':
        rapierCollider.setHalfExtents({
          x: collider.halfExtents[0] * scaleX,
          y: collider.halfExtents[1] * scaleY,
        });
        break;
      case 'sphere':
        rapierCollider.setRadius(collider.radius * Math.max(scaleX, scaleY));
        break;
      case 'capsule':
        rapierCollider.setHalfHeight(collider.halfHeight * scaleY);
        rapierCollider.setRadius(collider.radius * scaleX);
        break;
    }
  }

  // ─── ECS integration helpers ───────────────────────────────────────────

  registerBody(entity: number, bodyHandle: number): void {
    this.entityMap.set(entity, { bodyHandle });
    this.poseWritebackEntities.add(entity);
  }

  /**
   * Queue writeback for bodies whose ECS Transform changed since the previous
   * sync, so an ECS write to a sleeping dynamic body is still replaced by the
   * Rapier-owned pose. Cost follows the changed Transform blocks, not the body
   * count.
   */
  collectTransformEdits(world: World, transform: Component): void {
    if (this.poseEdits?.world !== world) {
      this.poseEdits = {
        world,
        query: world.query({ read: [transform], with: [RigidBody], changed: [transform] }).unwrap(),
      };
    }
    for (const row of this.poseEdits.query) {
      if (this.entityMap.has(row.entity)) this.poseWritebackEntities.add(row.entity);
    }
  }

  setKinematicPosition(entity: number, pos: { x: number; y: number }, rotation?: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y });
    if (rotation !== undefined) {
      body.setNextKinematicRotation(rotation);
    }
  }

  writebackDynamicBodies(): Array<{
    entity: number;
    pos: { x: number; y: number };
    rotation: number;
  }> {
    const results: Array<{
      entity: number;
      pos: { x: number; y: number };
      rotation: number;
    }> = [];
    const pending = this.poseWritebackEntities;
    const active = this.activeWritebackEntities;
    this.raw.forEachActiveRigidBody((body: { userData: unknown; handle: number }) => {
      const entity = body.userData as number;
      if (this.entityMap.get(entity)?.bodyHandle !== body.handle) return;
      active.add(entity);
      pending.add(entity);
    });
    for (const entity of pending) {
      const record = this.entityMap.get(entity);
      if (record === undefined) continue;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
      if (!body) continue;
      if (body.bodyType() !== this.rapierModule.RigidBodyType.Dynamic) continue;
      const translation = body.translation();
      const rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y },
        rotation,
      });
    }
    pending.clear();
    this.poseWritebackEntities = active;
    this.activeWritebackEntities = pending;
    return results;
  }

  /** Remove backend rows whose Collider disappeared from the World query. */
  pruneMissingEntities(active: ReadonlySet<number>): void {
    for (const entity of this.entityMap.keys()) {
      if (!active.has(entity)) this.removeEntity(entity);
    }
  }

  removeEntity(entity: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    const ownPairs = [...(this.collisionPairs.get(entity) ?? [])];
    for (const other of ownPairs) {
      if (this.removeCollisionPair(entity, other)) {
        this.pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
      }
    }
    this.removeKccController(entity); // D-3: clear cached KCC before body removal
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
    (this.raw as any).removeRigidBody({
      handle: record.bodyHandle,
    } as RapierRigidBody2D);
    this.entityMap.delete(entity);
    this.collisionPairs.delete(entity);
  }
}

export function createRapier2DPhysicsWorld(rapier: Rapier2DModule): RapierPhysicsWorld2D {
  return new RapierPhysicsWorld2D(rapier);
}

function hasResolvedWorldPose(world: Float32Array | undefined, base: number): boolean {
  if (!world) return false;
  return (
    world[base] !== 1 ||
    world[base + 5] !== 1 ||
    world[base + 10] !== 1 ||
    world[base + 15] !== 1 ||
    world[base + 1] !== 0 ||
    world[base + 2] !== 0 ||
    world[base + 4] !== 0 ||
    world[base + 6] !== 0 ||
    world[base + 8] !== 0 ||
    world[base + 9] !== 0 ||
    world[base + 12] !== 0 ||
    world[base + 13] !== 0 ||
    world[base + 14] !== 0
  );
}

/** dt upper bound (plan-strategy D-4): skip step if dt exceeds this. */
const PHYSICS_DT_MAX = 0.1;
const poseScratchPosition2D = vec3.create();
const poseScratchRotation2D = quat.create();
const poseScratchScale2D = vec3.create();
const poseScratchWorld2D = new Float32Array(16);

/**
 * Register three-phase physics tick systems into an ECS World (2D variant).
 *
 * Mirrors registerPhysicsSystems from physics-rapier3d with 2D adaptations
 * (plan-strategy C-3 symmetry):
 *   - physicsSyncBackend2D:  after propagateTransforms — query (Transform,
 *     RigidBody, Collider) and call RapierPhysicsWorld2D.ensureBody for each.
 *   - physicsStepSimulation2D: after physicsSyncBackend2D — read FixedTime.delta and
 *     call pw.step() with dt-gating.
 *   - physicsWriteback2D: after physicsStepSimulation2D — call
 *     pw.writebackDynamicBodies() and write positions + rotation back to ECS
 *     Transform (2D scalar angle -> quat via quat.fromAxisAngle z-axis).
 *
 * @param world              ECS World instance.
 * @param transformComponent The Transform component schema (from
 *                           @forgeax/engine-runtime, passed by caller to
 *                           avoid adding a runtime dependency to this package).
 */
// ── System name constants (2D suffix keeps diagnostics distinct from 3D) ──
const PHYSICS_SYNC_BACKEND_2D = 'physicsSyncBackend2D' as const;
const PHYSICS_STEP_SIMULATION_2D = 'physicsStepSimulation2D' as const;
const PHYSICS_WRITEBACK_2D = 'physicsWriteback2D' as const;
const PHYSICS_COLLISION_SYNC_2D = 'physicsCollisionSync2D' as const;

/**
 * Resolve the runtime `Transform` component token from the ECS component
 * vocabulary (M2 — full resource-ification, D-3). Mirrors the 3D variant:
 * physics already depends on `@forgeax/engine-ecs`, so the token lookup
 * introduces no new dependency and replaces the closure-captured
 * `transformComponent` second parameter.
 */
function resolveTransform(world: World): Component | undefined {
  return world.components.resolve('Transform');
}

/**
 * `physicsSyncBackend2D` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms — query entities with (Transform, Collider) and
 * call ensureBody for each. `RigidBody` is OPTIONAL: an entity with a Collider
 * but no RigidBody is treated as a STATIC collider (Rapier-native — a collider
 * without a parent body is fixed), matching the Collider docstring and how
 * static level geometry is authored. The 2D suffix keeps the name distinct from
 * the 3D system in the shared schedule (D-5).
 */
export const PhysicsSyncBackend2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_SYNC_BACKEND_2D,
  queries: [],
  after: ['propagateTransformsFixed'],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    const globalTransformComponent = world.components.resolve('GlobalTransform');
    if (transformComponent === undefined || globalTransformComponent === undefined) return;
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    const queryResult = world.query({
      read: [Collider, transformComponent, globalTransformComponent],
      optional: [RigidBody, CharacterController],
    });
    if (!queryResult.ok) return;

    const activeEntities = new Set<number>();
    for (const queryRow of queryResult.value) {
      const rowView = queryRow as unknown as {
        readonly entity: EntityHandle;
        has(component: Component): boolean;
        get(component: Component): Record<string, unknown>;
      };
      const colliderData = rowView.get(Collider) as unknown as ColliderData;
      const transformData = rowView.get(transformComponent) as unknown as {
        pos: Float32Array;
        quat: Float32Array;
        scale: Float32Array;
      };
      const globalTransformData = rowView.get(globalTransformComponent) as unknown as {
        world: Float32Array;
      };
      const rigidBodyData = rowView.has(RigidBody)
        ? (rowView.get(RigidBody) as unknown as {
            type: number;
            mass: number;
            linearDamping: number;
            angularDamping: number;
            gravityScale: number;
            ccdEnabled: number;
            additionalSolverIterations: number;
          })
        : undefined;
      const hasCharacterController = rowView.has(CharacterController);
      const rbType =
        rigidBodyData === undefined ? undefined : new Float32Array([rigidBodyData.type]);
      const rbMass =
        rigidBodyData === undefined ? undefined : new Float32Array([rigidBodyData.mass]);
      const rbLinDamp =
        rigidBodyData === undefined ? undefined : new Float32Array([rigidBodyData.linearDamping]);
      const rbAngDamp =
        rigidBodyData === undefined ? undefined : new Float32Array([rigidBodyData.angularDamping]);
      const rbGravScale =
        rigidBodyData === undefined ? undefined : new Float32Array([rigidBodyData.gravityScale]);
      const rbCcd =
        rigidBodyData === undefined ? undefined : new Uint32Array([rigidBodyData.ccdEnabled]);
      const tfPos = transformData.pos;
      const tfQuat = transformData.quat;
      const tfScale = transformData.scale;
      const tfWorld = globalTransformData.world;

      // rb* views are intentionally NOT guarded here: a bare-Collider archetype
      // has no RigidBody column, so they are legitimately undefined and the
      // per-row rigidBody below falls back to a static default. Only the
      // Transform columns are required; Collider is a required query term.
      if (!tfPos || !tfQuat || !tfScale) {
        continue;
      }

      {
        const row = 0;
        const entity = rowView.entity;
        activeEntities.add(entity);

        const localBase = row * 3;
        const quatBase = row * 4;
        const worldBase = row * 16;
        const useWorldPose = hasResolvedWorldPose(tfWorld, worldBase);
        if (useWorldPose && tfWorld) {
          for (let lane = 0; lane < 16; lane++) {
            poseScratchWorld2D[lane] = tfWorld[worldBase + lane] ?? 0;
          }
          mat4.decompose(
            poseScratchPosition2D,
            poseScratchRotation2D,
            poseScratchScale2D,
            poseScratchWorld2D,
          );
        } else {
          poseScratchPosition2D[0] = tfPos[localBase] ?? 0;
          poseScratchPosition2D[1] = tfPos[localBase + 1] ?? 0;
          poseScratchPosition2D[2] = tfPos[localBase + 2] ?? 0;
          poseScratchRotation2D[0] = tfQuat[quatBase] ?? 0;
          poseScratchRotation2D[1] = tfQuat[quatBase + 1] ?? 0;
          poseScratchRotation2D[2] = tfQuat[quatBase + 2] ?? 0;
          poseScratchRotation2D[3] = tfQuat[quatBase + 3] ?? 1;
          poseScratchScale2D[0] = tfScale[localBase] ?? 1;
          poseScratchScale2D[1] = tfScale[localBase + 1] ?? 1;
          poseScratchScale2D[2] = tfScale[localBase + 2] ?? 1;
        }
        const transform: PhysicsTransform2D = {
          position: { x: poseScratchPosition2D[0] ?? 0, y: poseScratchPosition2D[1] ?? 0 },
          rotation: 2 * Math.atan2(poseScratchRotation2D[2] ?? 0, poseScratchRotation2D[3] ?? 1),
          scale: { x: poseScratchScale2D[0] ?? 1, y: poseScratchScale2D[1] ?? 1 },
        };

        // Bare-Collider (no RigidBody) → synthesize a STATIC body. The `static`
        // ensureBody arm reads only `type`, so mass/damping/gravity/ccd defaults
        // are inert; this matches Rapier's "collider without a parent body is
        // fixed" semantics and the Collider component docstring.
        const rigidBody: {
          type: number;
          mass: number;
          linearDamping: number;
          angularDamping: number;
          gravityScale: number;
          ccdEnabled: number;
          additionalSolverIterations?: number;
        } = rbType
          ? {
              type: rbType[row] as number,
              mass: (rbMass?.[row] ?? 0) as number,
              linearDamping: (rbLinDamp?.[row] ?? 0) as number,
              angularDamping: (rbAngDamp?.[row] ?? 0) as number,
              gravityScale: (rbGravScale?.[row] ?? 1) as number,
              ccdEnabled: (rbCcd?.[row] ?? 0) as number,
              additionalSolverIterations: rigidBodyData?.additionalSolverIterations ?? 0,
            }
          : {
              type: RIGID_BODY_TYPE_STATIC,
              mass: 0,
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 1,
              ccdEnabled: 0,
            };

        const collider = snapshotCollider(colliderData);

        pw.ensureBody(entity, transform, rigidBody, collider);

        const rbTypeVal = rigidBodyTypeFromF32(rigidBody.type);
        if (rbTypeVal === 'static') {
          pw.syncAuthoredPose(entity, transform, collider, 'static');
        } else if (rbTypeVal === 'kinematic' && !hasCharacterController) {
          pw.syncAuthoredPose(entity, transform, collider, 'kinematic');
        }
      }
    }
    pw.pruneMissingEntities(activeEntities);
    pw.collectTransformEdits(world, transformComponent);
  },
});

/**
 * `physicsStepSimulation2D` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend2D — read FixedTime.delta and call pw.step() with dt-gating.
 */
export const PhysicsStepSimulation2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_STEP_SIMULATION_2D,
  queries: [],
  after: [PHYSICS_SYNC_BACKEND_2D],
  fn: (world) => {
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const dt = world.getResource(FixedTime).delta;
    if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal delta

    pw.step(dt);
  },
});

/**
 * `physicsWriteback2D` system token (M2 — full resource-ification, D-4).
 *
 * After physicsStepSimulation2D — call pw.writebackDynamicBodies() and write
 * positions + rotation back to ECS Transform (resolved from the ECS
 * component vocabulary, D-3; 2D scalar angle -> quat via quat.fromAxisAngle z-axis).
 */
export const PhysicsWriteback2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_WRITEBACK_2D,
  queries: [],
  after: [PHYSICS_STEP_SIMULATION_2D],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const results = pw.writebackDynamicBodies();
    for (const r of results) {
      const entity = r.entity as EntityHandle;
      // D-5 2D variant: pos from {x,y}, rotation from scalar angle -> quat
      const outQuat = quat.create();
      // biome-ignore lint/suspicious/noExplicitAny: quat accepts Vec3 array
      quat.fromAxisAngle(outQuat, [0, 0, 1] as any as Vec3Like, r.rotation);
      const current = world.get(entity, transformComponent);
      const stored = current.ok
        ? (current.value as unknown as { pos?: ArrayLike<number>; quat?: ArrayLike<number> })
        : undefined;
      // Component order [x, y, z, w] (E6). `?? 0/1` narrows the
      // noUncheckedIndexedAccess undefined out of the quat elements.
      const nextQuat = [outQuat[0] ?? 0, outQuat[1] ?? 0, outQuat[2] ?? 0, outQuat[3] ?? 1];
      // Skipping a bit-identical write keeps an unchanged pose out of `changed`
      // filters, so downstream transform propagation stays O(moving bodies).
      if (
        stored?.pos?.[0] === Math.fround(r.pos.x) &&
        stored.pos[1] === Math.fround(r.pos.y) &&
        stored.quat !== undefined &&
        nextQuat.every((value, index) => stored.quat?.[index] === value)
      ) {
        continue;
      }
      world.set(entity, transformComponent, {
        pos: [r.pos.x, r.pos.y, stored?.pos?.[2] ?? 0],
        quat: nextQuat,
      });
    }
  },
});

export const PhysicsCollisionSync2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_COLLISION_SYNC_2D,
  queries: [],
  after: [PHYSICS_WRITEBACK_2D],
  fn: (world) => {
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return;
    }
    pw.writebackCollidingEntities(world);
  },
});

/**
 * Register three-phase physics tick systems into an ECS World (2D variant).
 *
 * Mirrors registerPhysicsSystems from physics-rapier3d with 2D adaptations
 * (plan-strategy C-3 symmetry). The three systems
 * ({@link PhysicsSyncBackend2D} / {@link PhysicsStepSimulation2D} /
 * {@link PhysicsWriteback2D}) are module-level `defineSystem` tokens; this
 * helper wires the moveAndSlide context + despawn cleanup hook, then adds the
 * three tokens to the schedule.
 *
 * Transform is resolved from the World-local ECS component catalog,
 * D-3) — the previous `transformComponent` second parameter is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems2D(world: World): () => void {
  const releaseComponents = registerPhysicsComponents(world);
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform(world);
  try {
    const pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent);
    }
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world
    .addSystems(FixedUpdate, PhysicsSet, [
      PhysicsSyncBackend2D,
      PhysicsStepSimulation2D,
      PhysicsWriteback2D,
      PhysicsCollisionSync2D,
    ])
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, PHYSICS_COLLISION_SYNC_2D);
    world.removeSystem(FixedUpdate, PHYSICS_WRITEBACK_2D);
    world.removeSystem(FixedUpdate, PHYSICS_STEP_SIMULATION_2D);
    world.removeSystem(FixedUpdate, PHYSICS_SYNC_BACKEND_2D);
    releaseComponents();
  };
}
