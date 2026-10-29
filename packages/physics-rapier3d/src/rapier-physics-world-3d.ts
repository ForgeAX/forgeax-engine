import { componentDefinition, Disabled, Entity, FixedTime } from '@forgeax/engine-ecs';
import type { ColliderDesc, Collider as RapierCollider } from '../pkg/rapier.mjs';
import {
  type BodyActivationCommand,
  changeBodyActivation,
  readBodyConstraintCount,
} from './body-activation.js';
import { readContactObservation } from './contact-observation.js';
import { orderDerivedCandidateGroups } from './derived-admission-order.js';
import {
  applyDerivedMotion,
  captureDerivedBodyState,
  type DerivedAdmissionUndo,
  derivedBodyStateRestored,
} from './derived-admission-undo.js';
import { derivedRosterRefusal, derivedShapeHandles } from './derived-candidate-records.js';
import { restoreDerivedDensities } from './derived-density.js';
import { GroupedContactEvents } from './grouped-contact-events.js';
import { primeGroupedContacts } from './prime-grouped-contacts.js';
// Three-phase pipeline (plan-strategy D-1):
//   1. syncBackend: reconcile authored bodies and kinematic positions.
//   2. stepSimulation: call rapierWorld.step(eventQueue).
//   3. writeback: read Rapier body positions (dynamic only).
//
// Entity-to-body mapping (plan-strategy D-7): Rapier RigidBody.userData holds
// the ECS entity raw value for reverse lookup in collision events.
//
// Despawn cleanup (plan-strategy D-5): removeEntity() removes the Rapier body
// and colliders from the physics world.

import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { type Vec3, vec3 } from '@forgeax/engine-math';
import {
  type BodyMotion,
  CharacterController,
  type CharacterControllerData,
  Collider,
  ColliderShapeValue,
  type ColliderSnapshot,
  cloneDerivedPhysicsInput,
  colliderShapeFromF32,
  createTerrainHeightfieldSync,
  DERIVED_PHYSICS_LIMITS,
  type DerivedBodyTypeCandidateInput,
  type DerivedPhysicsAdmissionGuard,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  DerivedPhysicsError,
  type DerivedPhysicsFailure,
  type DerivedPhysicsMotion,
  type DerivedPhysicsPublication,
  type DerivedPhysicsSnapshot,
  type DerivedShapeInput,
  type DerivedShapeState,
  estimateDerivedPhysicsInputBytes,
  finitePhysicsVector,
  type ManagedJointBinding,
  type ManagedJointInput,
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  PairIsolationError,
  type PairIsolationInput,
  type PairIsolationLease,
  PHYSICS_ERROR_HINTS,
  type PhysicsConstraintInput,
  type PhysicsContactNeighborsSnapshot,
  type PhysicsContactNormalFilter,
  type PhysicsContactObservation,
  type PhysicsContactSnapshot,
  PhysicsError,
  type PhysicsMassProperties,
  type PhysicsOptions,
  type PhysicsVector,
  type PhysicsWorld,
  preserveCenterOfMassVelocity,
  type RaycastHit,
  RigidBody,
  rigidBodyTypeFromF32,
  unitPhysicsQuaternion,
  validateAdditionalSolverIterations,
  validateManagedJoints,
  validateMassProperties,
  validateSolverIterations,
} from '@forgeax/engine-physics';
import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result, type RigidBodyType } from '@forgeax/engine-types';
import { localPositionForWorld3D, translateAttachedColliders3D } from './body-pose.js';
import { rapierBodyTypeFromString, rapierBodyTypeToString } from './body-type.js';
import { applyKccTuning } from './character-controller-tuning.js';
import {
  currentContactOwner,
  queryContactManifolds,
  queryContactNeighbors,
  readContactQuery,
} from './contact-query.js';
import {
  copyDerivedShapeInputs,
  currentDerivedAdmission,
  describeDerivedConstraints,
  describeDerivedShapes,
  preflightDerivedBatch,
  projectPendingDerivedSources,
  queueGuardedDerivedAdmission,
  readNativeBodyMotion,
  readNativeDerivedMotion,
  revalidatePendingDerivedCandidates,
} from './derived-admission-preflight.js';
import {
  candidateNativeColliders,
  candidateShapeRecords,
  prepareDerivedBodyTypes,
  retainedDerivedGeometryCurrent,
} from './derived-body-type.js';
import type {
  DerivedAdmissionBatch,
  DerivedAdmissionProjection,
  DerivedBodyRecord,
  DerivedBodySource,
  DerivedCandidateRecord,
  DerivedConstraintRecord,
  DerivedShapeRecord,
} from './derived-candidate-records.js';
import { createDerivedColliderGroup, stageDerivedColliders } from './derived-collider.js';
import { createDerivedJointData, validateConstraintInput } from './derived-constraint.js';
import { createManagedJointData } from './managed-joint-data.js';
import {
  type IsolatedPair,
  isolationKey,
  type PhysicsEntityRecord,
  type Rapier3DCollisionEvent,
  type Rapier3DKinematicControllerState,
  type RapierEventQueue,
  type RapierRigidBody,
  type RapierWorld,
} from './physics-entity-records.js';
import {
  PHYSICS_DT_MAX,
  type PhysicsSyncDescriptor,
  type PhysicsSyncQuery,
  type PhysicsSyncQueryRow,
  type PhysicsSyncState,
  type PhysicsTransform3D,
  physicsRowIsStatic,
  readPhysicsSyncDescriptor,
  sameColliderScale,
  samePhysicsValue,
} from './physics-sync.js';
import { SharedCollisionGeometry } from './shared-collision-geometry.js';
import type { Rapier3DModule } from './wasm-loader.js';

const EMPTY_CONTACT_OBSERVATIONS: readonly PhysicsContactObservation[] = Object.freeze([]);

export class RapierPhysicsWorld3D implements PhysicsWorld {
  /** Rapier 3D World instance owning all bodies, colliders, and pipeline. */
  raw: RapierWorld;

  private readonly rapierModule: Rapier3DModule;

  private readonly entityMap = new Map<number, PhysicsEntityRecord>();
  private readonly dirtyPairPolicies = new Map<number, PhysicsEntityRecord>();
  private readonly isolatedPairs = new Map<string, IsolatedPair>();
  private isolationLeaseCount = 0;
  /** Native collider identity prepared by its owner; callbacks never reenter native or ECS. */
  private readonly isolationColliderOwners = new Map<number, number>();
  private nativeExecuting = false;
  private activeDerivedPreflight = false;
  private readonly pairHooks = {
    filterContactPair: (a: number, b: number) =>
      this.colliderPairIsolated(a, b) ? null : this.rapierModule.SolverFlags.COMPUTE_IMPULSE,
    filterIntersectionPair: (a: number, b: number) => !this.colliderPairIsolated(a, b),
  };

  /**
   * Entities whose dynamic pose is written back at the next writeback even if
   * Rapier no longer reports them active: bodies awake at the previous
   * writeback (their final pose before sleeping), newly registered bodies, and
   * dynamic bodies whose ECS Transform was overwritten (Rapier owns that pose).
   */
  private poseWritebackEntities = new Set<number>();
  private activeWritebackEntities = new Set<number>();

  private eventQueue: RapierEventQueue;

  /**
   * Active overlap set per entity, maintained by draining the event queue each
   * step. `started` events add the pair both ways; `stopped` events remove it.
   * Read out into each entity's `CollidingEntities` component by
   * `writebackCollidingEntities`. Covers both solid contacts and sensor
   * intersections (Rapier emits CollisionEvent for both).
   */
  private readonly collisionPairs = new Map<number, Set<number>>();

  /** Removed authored handles remain event-resolvable until the next native drain. */
  private readonly retiredColliderOwners = new Map<number, number>();

  private readonly pendingCollisionEvents: Rapier3DCollisionEvent[] = [];

  private readonly collisionEventHistory: Rapier3DCollisionEvent[] = [];

  /** One backend owns every derived shape; these maps are not a second world. */
  private readonly derivedBodies = new Map<number, DerivedBodyRecord>();
  private readonly derivedCandidates = new Map<string, DerivedCandidateRecord>();
  private readonly pendingDerivedCandidates = new Set<string>();
  private readonly retiredDerivedBodies: DerivedBodyRecord[] = [];
  private readonly derivedColliderToShape = new Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >();
  private readonly groupedContactEvents = new GroupedContactEvents();
  private readonly derivedConstraints = new Map<string, DerivedConstraintRecord>();
  private readonly derivedBodySources = new Map<number, DerivedBodySource>();
  private readonly derivedPublications = new Map<number, DerivedPhysicsPublication>();
  private readonly derivedFailures = new Map<number, DerivedPhysicsFailure>();
  private readonly derivedContacts: PhysicsContactObservation[] = [];
  private derivedContactPublication: readonly PhysicsContactObservation[] | undefined;
  private readonly derivedPoisonedEntities = new Set<number>();
  private readonly physicsOwner = {};
  private candidateSequence = 0;
  private derivedCandidateBytes = 0;
  private backendGeneration = 1;
  private fixedStep = 0;
  private contactDeltaTime = 0;
  private derivedPublicationPending = false;
  private worldIdentity: World | undefined;
  private activeDerivedAdmission: DerivedCandidateRecord | undefined;

  private currentGravity: { x: number; y: number; z: number };

  /**
   * Lazily-built Rapier KinematicCharacterController per character entity
   * (plan-strategy D-1/D-3). `moveAndSlide` creates one on first call; the
   * `Collider.onRemove` hook (registerPhysicsSystems) clears it on despawn.
   * Public so AC-11 despawn tests can assert `kccCache.size === 0`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  readonly kccCache = new Map<number, any>();

  private readonly kccOffsets = new Map<number, number>();

  /**
   * ECS World + components wired in by `registerPhysicsSystems`, so
   * `moveAndSlide` can read CharacterController tuning and write Transform +
   * grounded back. Undefined until systems are registered — the input-validation
   * error paths (body / collider) fire before these are read, so direct
   * `pw.moveAndSlide()` calls in error tests need no World.
   */
  private moveContext: { world: World; transform: Component } | undefined;

  /** Persistent ECS query + projection cursor for incremental backend sync. */
  private syncState: PhysicsSyncState | undefined;

  private disposed = false;

  constructor(rapier: Rapier3DModule, options: PhysicsOptions = {}) {
    const solverIterations = validateSolverIterations(options.solverIterations);
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81, z: 0 }) as RapierWorld;
    this.raw.integrationParameters.numSolverIterations = solverIterations;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81, z: 0 };
  }

  // ─── PhysicsWorld interface ────────────────────────────────────────────

  acquirePairIsolation(input: PairIsolationInput): Result<PairIsolationLease, PairIsolationError> {
    const refuse = (
      code: PairIsolationError['code'],
      expected: string,
      hint: string,
      detail: { reason?: string; used?: number; limit?: number } = {},
    ) =>
      err(
        new PairIsolationError(code, expected, hint, {
          entityA: input.entityA,
          entityB: input.entityB,
          ...detail,
        }),
      );
    if (this.worldIdentity === undefined || input.worldIdentity !== this.worldIdentity)
      return refuse(
        'pair-isolation-world-mismatch',
        'the currently attached ECS World',
        'use the PhysicsWorld attached to the supplied World',
      );
    const world = this.worldIdentity;
    if (
      !Number.isSafeInteger(input.entityA) ||
      !Number.isSafeInteger(input.entityB) ||
      input.entityA < 0 ||
      input.entityB < 0 ||
      input.entityA > 0xffffffff ||
      input.entityB > 0xffffffff ||
      input.entityA === input.entityB ||
      !world.hasComponent(input.entityA as EntityHandle, Entity) ||
      !world.hasComponent(input.entityB as EntityHandle, Entity)
    )
      return refuse(
        'pair-isolation-entity-invalid',
        'two distinct live complete entity handles',
        'resolve the current physics entities in the owning World',
      );
    if (this.disposed || this.recoveryBlocked())
      return refuse(
        'pair-isolation-backend-unavailable',
        'a healthy live physics backend',
        'rebuild and attach a healthy PhysicsWorld',
      );
    if (this.nativeExecuting || this.activeDerivedAdmission !== undefined)
      return refuse(
        'pair-isolation-busy',
        'physics outside native execution and paired admission',
        'acquire between completed physics operations',
      );
    const bodyA = this.entityMap.get(input.entityA),
      bodyB = this.entityMap.get(input.entityB);
    if (
      world.hasComponent(input.entityA as EntityHandle, Disabled) ||
      world.hasComponent(input.entityB as EntityHandle, Disabled)
    )
      return refuse(
        'pair-isolation-body-unavailable',
        'two enabled ECS bodies',
        'enable and sync both bodies before acquiring',
      );
    for (const record of [bodyA, bodyB]) {
      const body = record === undefined ? undefined : this.raw.getRigidBody(record.bodyHandle);
      if (
        record?.worldIdentity !== world ||
        body === undefined ||
        body === null ||
        !body.isEnabled() ||
        body.numColliders() === 0 ||
        !this.bodyColliders(body).some((collider) => collider.isEnabled())
      )
        return refuse(
          'pair-isolation-body-unavailable',
          'two enabled bodies with committed colliders',
          'sync both bodies and their colliders before acquiring',
        );
    }
    if (bodyA === undefined || bodyB === undefined)
      return refuse(
        'pair-isolation-body-unavailable',
        'two registered bodies',
        'sync physics before acquiring',
      );
    const key = isolationKey(input.entityA, input.entityB);
    const existing = this.isolatedPairs.get(key);
    // Preflight is read-only; retiring stale references belongs to lifecycle sync.
    if (
      this.isolationLeaseCount >= 512 ||
      (existing === undefined && this.isolatedPairs.size >= 128)
    )
      return refuse(
        'pair-isolation-budget-exceeded',
        'at most 128 pairs and 512 outstanding leases',
        'release outstanding leases before retrying',
        this.isolationLeaseCount >= 512
          ? { reason: 'leases', used: this.isolationLeaseCount, limit: 512 }
          : { reason: 'pairs', used: this.isolatedPairs.size, limit: 128 },
      );
    const pair = existing ?? {
      input: Object.freeze({ ...input }),
      generation: this.backendGeneration,
      bodyA,
      bodyB,
      leases: new Set<object>(),
    };
    const identity = {};
    const lease: PairIsolationLease = {
      release: () => {
        if (!pair.leases.has(identity) || this.isolatedPairs.get(key) !== pair)
          return ok(undefined);
        if (this.nativeExecuting || this.activeDerivedAdmission !== undefined)
          return refuse(
            'pair-isolation-busy',
            'release outside native execution and paired admission',
            'release between completed physics operations',
          );
        pair.leases.delete(identity);
        this.isolationLeaseCount -= 1;
        if (pair.leases.size === 0) this.retireIsolatedPair(key, pair);
        return ok(undefined);
      },
    };
    pair.leases.add(identity);
    this.isolationLeaseCount += 1;
    if (existing === undefined) {
      this.contactDeltaTime = 0;
      this.isolatedPairs.set(key, pair);
      this.markPairPolicyDirty(input.entityA, bodyA);
      this.markPairPolicyDirty(input.entityB, bodyB);
    }
    return ok(lease);
  }

  private retireIsolatedPair(key: string, pair: IsolatedPair): void {
    this.contactDeltaTime = 0;
    this.isolationLeaseCount -= pair.leases.size;
    pair.leases.clear();
    this.isolatedPairs.delete(key);
    this.markPairPolicyDirty(pair.input.entityA, pair.bodyA);
    this.markPairPolicyDirty(pair.input.entityB, pair.bodyB);
  }

  private clearPairIsolation(): void {
    for (const [key, pair] of this.isolatedPairs) this.retireIsolatedPair(key, pair);
  }

  private bindIsolationWorld(world: World): void {
    if (this.sharedGeometry !== undefined && this.sharedGeometry.owner !== world.assets)
      this.colliderFailure('a native shared geometry owner cannot move between asset realms');
    if (this.worldIdentity !== world) this.clearPairIsolation();
    this.worldIdentity = world;
  }

  private markPairPolicyDirty(entity: number, record: PhysicsEntityRecord): void {
    // A released stale lease must not overwrite a replacement Body's work.
    if (this.entityMap.get(entity) === record) this.dirtyPairPolicies.set(entity, record);
  }

  private preparePairIsolation(refreshContacts: boolean): void {
    const world = this.worldIdentity;
    for (const [key, pair] of this.isolatedPairs) {
      if (
        pair.input.worldIdentity !== world ||
        pair.generation !== this.backendGeneration ||
        this.entityMap.get(pair.input.entityA) !== pair.bodyA ||
        this.entityMap.get(pair.input.entityB) !== pair.bodyB ||
        world === undefined ||
        !world.hasComponent(pair.input.entityA as EntityHandle, Entity) ||
        !world.hasComponent(pair.input.entityB as EntityHandle, Entity)
      )
        this.retireIsolatedPair(key, pair);
    }
    if (!refreshContacts) return;
    for (const [entity, record] of this.dirtyPairPolicies) {
      if (this.entityMap.get(entity) !== record) {
        this.dirtyPairPolicies.delete(entity);
        continue;
      }
      const body = this.raw.getRigidBody(record.bodyHandle);
      if (body === undefined || body === null) continue;
      for (const collider of this.bodyColliders(body)) {
        this.syncIsolationCollider(collider, entity);
        if (collider.isEnabled()) {
          // Mark position dirty without changing geometry or authored groups.
          // Rapier reruns narrow-phase filters for this collider on the next step.
          collider.setTranslation(collider.translation());
        }
      }
      body.wakeUp();
      if (this.dirtyPairPolicies.get(entity) === record) this.dirtyPairPolicies.delete(entity);
    }
  }

  private syncIsolationCollider(collider: RapierCollider, entity: number): void {
    this.isolationColliderOwners.set(collider.handle, entity);
    const record = this.entityMap.get(entity);
    const mask =
      this.rapierModule.ActiveHooks.FILTER_CONTACT_PAIRS |
      this.rapierModule.ActiveHooks.FILTER_INTERSECTION_PAIRS;
    let hooks = collider.activeHooks() & ~mask;
    for (const pair of this.isolatedPairs.values()) {
      if (pair.bodyA === record || pair.bodyB === record) {
        hooks |= mask;
        break;
      }
    }
    // Rapier disables native contact recycling even when flagged hooks have no callback.
    if (collider.activeHooks() !== hooks) {
      collider.setActiveHooks(hooks);
      if (record !== undefined) this.markPairPolicyDirty(entity, record);
    }
  }

  private colliderPairIsolated(a: number, b: number): boolean {
    if (this.isolatedPairs.size === 0) return false;
    const entityA = this.isolationColliderOwners.get(a),
      entityB = this.isolationColliderOwners.get(b);
    return (
      entityA !== undefined &&
      entityB !== undefined &&
      this.isolatedPairs.has(isolationKey(entityA, entityB))
    );
  }

  setGravity(gravity: Vec3): void {
    this.assertActive('setGravity');
    this.contactDeltaTime = 0;
    const x = gravity[0] ?? 0;
    const y = gravity[1] ?? 0;
    const z = gravity[2] ?? 0;
    this.raw.gravity = { x, y, z };
    this.currentGravity = { x, y, z };
  }

  getGravity(): Vec3 {
    const { x, y, z } = this.currentGravity;
    return vec3.create(x, y, z);
  }

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit | undefined {
    this.assertActive('raycast');
    if (this.recoveryBlocked()) {
      throw new DerivedPhysicsError(
        'derived-recovery-invalid',
        'raycasts observe a complete healthy physics state',
        'rebuild the PhysicsWorld before querying after an unrecoverable admission',
        {},
      );
    }
    const RAPIER = this.rapierModule;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
    const RayCtor = (RAPIER as any).Ray as new (
      origin: { x: number; y: number; z: number },
      dir: { x: number; y: number; z: number },
    ) => { pointAt(t: number): { x: number; y: number; z: number } };
    const ray = new RayCtor(
      { x: origin[0] ?? 0, y: origin[1] ?? 0, z: origin[2] ?? 0 },
      { x: direction[0] ?? 0, y: direction[1] ?? 0, z: direction[2] ?? 0 },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal
    const hit = (this.raw as any).castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      filterMask,
    ) as {
      collider: { parent(): { userData: number } | null };
      timeOfImpact: number;
      normal: { x: number; y: number; z: number };
    } | null;

    if (hit === null) return undefined;

    const point = ray.pointAt(hit.timeOfImpact);
    // `hit.collider.parent()` already returns the owning RigidBody OBJECT (compat
    // build), whose userData holds the ECS entity — read it directly, mirroring
    // `colliderHandleToEntity` (the proven CollidingEntities path). The prior code
    // treated the object as a body HANDLE and re-resolved it via `bodies.get(...)`,
    // which returned a DIFFERENT body → raycast reported the wrong entity.
    const colliderParentBody = hit.collider.parent();
    const entity = colliderParentBody !== null ? colliderParentBody.userData : 0;

    return {
      entity,
      point: vec3.create(point.x, point.y, point.z),
      normal: vec3.create(hit.normal.x, hit.normal.y, hit.normal.z),
      timeOfImpact: hit.timeOfImpact,
    };
  }

  teleport(entity: number, position: Vec3): void {
    this.assertActive('teleport');
    const body = this.bodyForEntity(entity);
    if (!body) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    if (position.length !== 3 || !Array.from(position).every(Number.isFinite)) {
      throw new PhysicsError({
        code: 'invalid-body-config',
        expected: 'a finite 3D teleport position',
        hint: PHYSICS_ERROR_HINTS['invalid-body-config'],
        detail: { code: 'invalid-body-config', field: 'position', value: Array.from(position) },
      });
    }
    const target = { x: position[0] ?? 0, y: position[1] ?? 0, z: position[2] ?? 0 };
    const before = body.translation();
    const delta = { x: target.x - before.x, y: target.y - before.y, z: target.z - before.z };
    const ctx = this.moveContext;
    const local = ctx
      ? localPositionForWorld3D(ctx.world, entity as EntityHandle, target)
      : undefined;

    this.contactDeltaTime = 0;
    if (body.bodyType() === this.rapierModule.RigidBodyType.KinematicPositionBased) {
      body.setNextKinematicTranslation(target);
    }
    body.setTranslation(target, true);
    if (body.bodyType() !== this.rapierModule.RigidBodyType.Fixed) {
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    }
    translateAttachedColliders3D(body, delta);
    if (ctx && local) ctx.world.set(entity as EntityHandle, ctx.transform, { pos: local }).unwrap();
    if (body.isDynamic()) this.poseWritebackEntities.add(entity);
  }

  step(deltaTime: number): void {
    this.assertActive('step');
    if (!Number.isFinite(deltaTime) || deltaTime <= 0 || deltaTime > PHYSICS_DT_MAX) return;
    this.contactDeltaTime = 0;
    try {
      // Native integration must consume the same fixed delta as force controllers.
      (this.raw as { timestep: number }).timestep = deltaTime;
      const geometryCommitted = this.processDerivedCandidates();
      // A failed native rollback is an explicit rebuild boundary. Physics does
      // not advance or publish a mixed state after this point.
      if (this.derivedPoisonedEntities.size > 0) return;
      // Geometry commits may replace ordinary ECS terrain after the scheduled
      // sync. Consume those changes before collision detection can see both
      // the old source and its newly admitted fragment.
      if (geometryCommitted && this.syncState !== undefined) {
        const { world, transformComponent, globalTransformComponent } = this.syncState;
        this._syncFromEcs(world, transformComponent, globalTransformComponent);
      }
      this.nativeExecuting = true;
      this.preparePairIsolation(true);
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
      (this.raw as any).step(
        this.eventQueue,
        this.isolatedPairs.size === 0 ? undefined : this.pairHooks,
      );
      this.nativeExecuting = false;
      this.fixedStep = this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1;
      this.drainRapierCollisionEvents();
      this.derivedPublicationPending = true;
      // Direct PhysicsWorld consumers do not have ECS writeback systems. Keep
      // that public path useful while ECS-bound worlds finalize after writeback
      // and collision component synchronization below.
      if (this.syncState === undefined) this.finalizeDerivedFixedStep();
    } catch (cause) {
      // A native step or contact drain may have advanced before throwing.
      // Geometry may already be committed; neither domain can claim LKG.
      const error = new DerivedPhysicsError(
        'derived-backend-failed',
        'native fixed-step execution and publication complete together',
        'rebuild the World and PhysicsWorld from the last committed snapshot',
        { reason: cause instanceof Error ? cause.message : String(cause) },
        { cause },
      );
      for (const entity of this.entityMap.keys()) this.derivedPoisonedEntities.add(entity);
      this.derivedPublicationPending = false;
      this.derivedPublications.clear();
      for (const record of this.derivedCandidates.values()) {
        this.rememberDerivedFailure(record, error, 'rebuild-required');
      }
      throw error;
    } finally {
      this.nativeExecuting = false;
    }
  }

  /** Publish only after the fixed-step ECS writeback/contact boundary. */
  finalizeDerivedFixedStep(): void {
    if (this.activeDerivedPreflight) this.assertActive('finalizeDerivedFixedStep');
    if (!this.derivedPublicationPending) return;
    this.derivedPublicationPending = false;
    if (this.derivedPoisonedEntities.size > 0) return;
    this.publishDerivedCandidates();
    this.retireDerivedBodies();
    this.contactDeltaTime = this.raw.timestep;
  }

  /**
   * Drain the Rapier event queue into `collisionPairs`. Each event names two
   * collider handles + a `started` flag; we resolve each collider to its owning
   * entity (collider.parent() -> body.userData) and add/remove the symmetric
   * pair. This is what populates `CollidingEntities` for sensor pickup + contact
   * queries (the queue is otherwise drained-on-overflow and never observed).
   */
  private drainRapierCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      const a = this.colliderHandleToEntity(handle1);
      const b = this.colliderHandleToEntity(handle2);
      const shapeA = this.derivedColliderToShape.get(handle1);
      const shapeB = this.derivedColliderToShape.get(handle2);
      const grouped =
        this.groupedContactEvents.active || shapeA?.grouped || shapeB?.grouped
          ? this.groupedContactEvents.consume(
              handle1,
              handle2,
              started,
              a === undefined ? undefined : { entity: a, ...shapeA },
              b === undefined ? undefined : { entity: b, ...shapeB },
            )
          : false;
      if (a === undefined || b === undefined) return;
      if (!grouped)
        this.recordContactObservation(
          {
            phase: started ? 'started' : 'stopped',
            fixedStep: this.fixedStep,
            entityA: a,
            entityB: b,
            ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
            ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
          },
          handle1,
          handle2,
        );
      const changed = started
        ? this.addPair(a, b)
        : this.collisionPairs.get(a)?.has(b) === true &&
          !this.bodiesShareCollision(a, b) &&
          this.removePair(a, b);
      if (!changed) return;
      this.pushCollisionEvent({
        type: started ? 'started' : 'stopped',
        entityA: a,
        entityB: b,
        fixedStep: this.fixedStep,
        ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
        ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
      });
    });
    this.groupedContactEvents.drain(this.fixedStep, (observation, a, b) =>
      this.recordContactObservation(observation, a, b),
    );
    this.retiredColliderOwners.clear();
  }

  private recordContactObservation(
    observation: PhysicsContactObservation,
    handleA: number,
    handleB: number,
  ): void {
    this.derivedContacts.push(
      readContactObservation(this.raw, this.rapierModule, observation, handleA, handleB),
    );
    this.derivedContactPublication = undefined;
    if (this.derivedContacts.length > 256)
      this.derivedContacts.splice(0, this.derivedContacts.length - 256);
  }

  /** Resolve a Rapier collider handle to its owning ECS entity, or undefined. */
  private colliderHandleToEntity(colliderHandle: number): number | undefined {
    // getCollider(handle).parent() returns the owning RigidBody (compat build),
    // whose userData holds the ECS entity raw value (set in ensureBody).
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.getCollider from dynamic module
    const collider = (this.raw as any).getCollider(colliderHandle) as {
      readonly handle: number;
      parent(): { userData: number } | null;
    } | null;
    if (collider === null || collider === undefined || collider.handle !== colliderHandle) {
      const owner = this.retiredColliderOwners.get(colliderHandle);
      return owner !== undefined && this.entityMap.has(owner) ? owner : undefined;
    }
    const body = collider.parent();
    if (body === null || body === undefined) return undefined;
    return body.userData;
  }

  private addPair(a: number, b: number): boolean {
    let setA = this.collisionPairs.get(a);
    if (!setA) {
      setA = new Set<number>();
      this.collisionPairs.set(a, setA);
    }
    if (setA.has(b)) return false;
    setA.add(b);
    let setB = this.collisionPairs.get(b);
    if (!setB) {
      setB = new Set<number>();
      this.collisionPairs.set(b, setB);
    }
    setB.add(a);
    return true;
  }

  private removePair(a: number, b: number): boolean {
    const removedA = this.collisionPairs.get(a)?.delete(b) ?? false;
    const removedB = this.collisionPairs.get(b)?.delete(a) ?? false;
    return removedA || removedB;
  }

  private bodiesShareCollision(entityA: number, entityB: number): boolean {
    const bodyA = this.bodyForEntity(entityA);
    const bodyB = this.bodyForEntity(entityB);
    if (bodyA === undefined || bodyB === undefined) return false;
    const raw = this.raw as RapierWorld;
    // Symmetric contact existence only needs the smaller collider roster.
    const smaller = bodyA.numColliders() <= bodyB.numColliders() ? bodyA : bodyB;
    const otherEntity = smaller === bodyA ? entityB : entityA;
    for (const colliderA of this.bodyColliders(smaller)) {
      let hasContact = false;
      raw.intersectionPairsWith(colliderA, (other: RapierWorld) => {
        if (
          !hasContact &&
          this.colliderHandleToEntity(other.handle) === otherEntity &&
          raw.intersectionPair(colliderA, other)
        )
          hasContact = true;
      });
      if (hasContact) return true;
      raw.contactPairsWith(colliderA, (other: RapierWorld) => {
        if (hasContact || this.colliderHandleToEntity(other.handle) !== otherEntity) return;
        raw.contactPair(colliderA, other, () => {
          hasContact = true;
        });
      });
      if (hasContact) return true;
    }
    return false;
  }

  private retireRemovedColliderPairs(entity: number): void {
    for (const other of [...(this.collisionPairs.get(entity) ?? [])]) {
      if (this.bodiesShareCollision(entity, other)) continue;
      if (this.removePair(entity, other)) {
        this.pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
      }
    }
  }

  private pushCollisionEvent(event: Rapier3DCollisionEvent): void {
    const ordered =
      event.entityA <= event.entityB
        ? event
        : {
            type: event.type,
            entityA: event.entityB,
            entityB: event.entityA,
            ...(event.fixedStep === undefined ? {} : { fixedStep: event.fixedStep }),
            ...(event.shapeB === undefined ? {} : { shapeA: event.shapeB }),
            ...(event.shapeA === undefined ? {} : { shapeB: event.shapeA }),
          };
    this.pendingCollisionEvents.push(ordered);
    this.collisionEventHistory.push(ordered);
  }

  /**
   * Write the current overlap set into each entity's `CollidingEntities`
   * component (entities that carry it). Called by the PhysicsCollisionSync
   * system after writeback. Entities with no current overlaps get an empty set,
   * so a Core that the player has left clears correctly. Only entities that own
   * a CollidingEntities component are written (others are skipped).
   */
  writebackCollidingEntities(world: World, collidingComponent: Component): void {
    for (const [entity, others] of this.collisionPairs) {
      const handle = entity as EntityHandle;
      if (!world.hasComponent(handle, collidingComponent)) continue;
      world.set(handle, collidingComponent, { entities: [...others] });
    }
  }

  drainCollisionEvents(): Rapier3DCollisionEvent[] {
    return this.pendingCollisionEvents.splice(0);
  }

  getCollisionPairs(): Map<number, Set<number>> {
    return new Map([...this.collisionPairs].map(([entity, others]) => [entity, new Set(others)]));
  }

  getCollisionEventHistory(): readonly Rapier3DCollisionEvent[] {
    return [...this.collisionEventHistory];
  }

  /** Immutable detached contact publication; no Rapier manifolds or handles escape. */
  getContactObservations(): readonly PhysicsContactObservation[] {
    if (this.recoveryBlocked()) return EMPTY_CONTACT_OBSERVATIONS;
    this.derivedContactPublication ??= Object.freeze([...this.derivedContacts]);
    return this.derivedContactPublication;
  }

  private currentContactStepAvailable(): boolean {
    return !(
      this.disposed ||
      this.recoveryBlocked() ||
      this.nativeExecuting ||
      this.activeDerivedAdmission !== undefined ||
      this.derivedPublicationPending ||
      this.contactDeltaTime <= 0 ||
      (this.syncState && this.fixedStep !== this.syncState.world.getResource(FixedTime).tick)
    );
  }

  /** Conservative completed-step contact prefilter without detached manifold publication. */
  hasManagedContactPair(entity: number, other: number): boolean | undefined {
    if (!this.currentContactStepAvailable()) return undefined;
    if (!this.entityMap.has(entity) || !this.entityMap.has(other)) return undefined;
    // Event membership can admit a pair cheaply. Its absence cannot reject raw
    // native colliders: those may not emit events, so consult native adjacency.
    return (
      this.collisionPairs.get(entity)?.has(other) === true ||
      this.bodiesShareCollision(entity, other)
    );
  }

  private readonly currentContactOwner = (collider: number, parent: RapierRigidBody | null) =>
    currentContactOwner(
      collider,
      parent,
      this.entityMap,
      this.worldIdentity,
      this.derivedColliderToShape,
    );

  getCurrentContacts(
    entity: number,
    filterMask?: number,
  ): Result<PhysicsContactSnapshot, ManagedPhysicsFailure> {
    return readContactQuery(
      this.currentContactStepAvailable(),
      entity,
      () => this.bodyForEntity(entity),
      (body) => ({
        fixedStep: this.fixedStep,
        deltaTime: this.contactDeltaTime,
        manifolds: queryContactManifolds(
          this.raw,
          body,
          this.currentContactOwner,
          entity,
          filterMask,
        ),
      }),
    );
  }

  getCurrentContactNeighbors(
    entity: number,
    filterMask?: number,
    normalFilter?: PhysicsContactNormalFilter,
  ): Result<PhysicsContactNeighborsSnapshot, ManagedPhysicsFailure> {
    return readContactQuery(
      this.currentContactStepAvailable(),
      entity,
      () => this.bodyForEntity(entity),
      (body) => ({
        fixedStep: this.fixedStep,
        deltaTime: this.contactDeltaTime,
        entities: queryContactNeighbors(
          this.raw,
          body,
          this.currentContactOwner,
          entity,
          filterMask,
          normalFilter,
        ),
      }),
    );
  }

  wakeBody(entity: number): Result<void, ManagedPhysicsFailure> {
    return this.bodyActivation(entity, 'wake');
  }
  sleepBody(entity: number): Result<void, ManagedPhysicsFailure> {
    return this.bodyActivation(entity, 'sleep');
  }
  getBodyConstraintCount(entity: number): Result<number, ManagedPhysicsFailure> {
    return readBodyConstraintCount(
      entity,
      this.disposed ||
        this.recoveryBlocked() ||
        this.nativeExecuting ||
        this.activeDerivedAdmission !== undefined,
      () =>
        this.worldIdentity !== undefined &&
        !this.worldIdentity.hasComponent(entity as EntityHandle, Entity)
          ? undefined
          : this.bodyForEntity(entity),
      (handle, count) => {
        this.raw.impulseJoints.forEachJointHandleAttachedToRigidBody(handle, count);
        this.raw.multibodyJoints.forEachJointHandleAttachedToRigidBody(handle, count);
      },
    );
  }
  private bodyActivation(
    entity: number,
    command: BodyActivationCommand,
  ): Result<void, ManagedPhysicsFailure> {
    return changeBodyActivation(
      entity,
      command,
      this.disposed ||
        this.recoveryBlocked() ||
        this.nativeExecuting ||
        this.activeDerivedAdmission !== undefined,
      () =>
        this.worldIdentity !== undefined &&
        !this.worldIdentity.hasComponent(entity as EntityHandle, Entity)
          ? undefined
          : this.bodyForEntity(entity),
      () => {
        this.contactDeltaTime = 0;
      },
    );
  }
  /** Prepare disabled native shapes for one entity without changing queries. */
  prepareDerivedShapeCandidate(
    input: DerivedPhysicsCandidateInput,
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>> {
    this.assertActive('prepareDerivedShapeCandidate');
    return this.prepareDerivedShapeCandidateInternal(input);
  }

  /** Prepare one indivisible roster using the existing disabled-native owner. */
  prepareDerivedShapeCandidates(
    inputs: readonly DerivedPhysicsCandidateInput[],
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidates']>> {
    this.assertActive('prepareDerivedShapeCandidates');
    const records: DerivedCandidateRecord[] = [];
    const batch: DerivedAdmissionBatch = Object.freeze({ records });
    let complete = false;
    // Reuse the native execution fence while caller inputs are copied and
    // disabled colliders are allocated; no partial roster can be observed.
    this.nativeExecuting = true;
    try {
      const count = Array.isArray(inputs) ? inputs.length : 0;
      if (
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        count > DERIVED_PHYSICS_LIMITS.maxBatchCandidates
      )
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            `one preparation declares 1 to ${DERIVED_PHYSICS_LIMITS.maxBatchCandidates} bodies`,
            'submit one bounded complete replacement roster',
          ),
        );
      const entities = new Set<number>();
      const constraints = new Set<string>();
      for (let index = 0; index < count; index++) {
        const input = inputs[index];
        if (input === undefined)
          return err(
            new DerivedPhysicsError(
              'derived-candidate-invalid',
              'every declared batch member is present',
              'submit a complete dense input roster',
            ),
          );
        if (entities.has(input.entity))
          return err(
            new DerivedPhysicsError(
              'derived-candidate-invalid',
              'one preparation names each body once',
              'combine each body replacement before preparation',
              { entity: input.entity },
            ),
          );
        const prepared = this.prepareDerivedShapeCandidateInternal(input, batch);
        if (!prepared.ok) return prepared;
        const record = this.derivedCandidates.get(prepared.value.candidateId);
        if (record === undefined)
          return err(
            new DerivedPhysicsError(
              'derived-candidate-not-found',
              'the prepared member remains owned by this PhysicsWorld',
              'prepare the complete group after native ownership is restored',
            ),
          );
        records.push(record);
        entities.add(record.input.entity);
        for (const constraint of record.input.constraints ?? []) {
          if (constraints.has(constraint.id))
            return err(
              new DerivedPhysicsError(
                'derived-candidate-invalid',
                'one preparation names each constraint update once',
                'combine constraint updates in the complete roster',
                { constraintId: constraint.id },
              ),
            );
          constraints.add(constraint.id);
        }
      }
      Object.freeze(records);
      complete = true;
      return ok(Object.freeze(records.map((record) => record.token)));
    } finally {
      try {
        if (!complete)
          for (const record of records) {
            for (const collider of record.nativeColliders)
              this.removeNativeCollider(collider.handle);
            record.state = 'cancelled';
            this.releaseDerivedCandidate(record.token.candidateId);
          }
      } finally {
        this.nativeExecuting = false;
      }
    }
  }

  prepareDerivedBodyTypeCandidates(
    inputs: readonly DerivedBodyTypeCandidateInput[],
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedBodyTypeCandidates']>> {
    this.assertActive('prepareDerivedBodyTypeCandidates');
    this.nativeExecuting = true;
    try {
      return prepareDerivedBodyTypes(
        {
          identity: this.physicsOwner,
          generation: this.backendGeneration,
          healthy: !this.recoveryBlocked(),
          bodies: this.derivedBodies,
          publications: this.derivedPublications,
          candidates: this.derivedCandidates,
          pending: this.pendingDerivedCandidates,
          hasBody: (entity) => this.bodyForEntity(entity) !== undefined,
          nextId: (entity, revision) =>
            `derived:${this.backendGeneration}:${entity}:${++this.candidateSequence}:${revision}`,
          retain: (record) => {
            if (
              this.derivedCandidateBytes + record.bytes >
              DERIVED_PHYSICS_LIMITS.maxCandidateBytes
            )
              return err(
                new DerivedPhysicsError(
                  'derived-candidate-budget-exceeded',
                  'type-only tokens share the existing candidate byte budget',
                  'publish or cancel another preparation',
                  { reason: 'in-flight' },
                ),
              );
            this.derivedCandidates.set(record.token.candidateId, record);
            this.derivedCandidateBytes += record.bytes;
            return ok(undefined);
          },
          release: (id) => this.releaseDerivedCandidate(id),
        },
        inputs,
      );
    } finally {
      this.nativeExecuting = false;
    }
  }

  private prepareDerivedShapeCandidateInternal(
    input: DerivedPhysicsCandidateInput,
    batch?: DerivedAdmissionBatch,
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>> {
    if (input.worldIdentity !== undefined && input.worldIdentity !== this.worldIdentity) {
      return err(
        new DerivedPhysicsError(
          'derived-world-mismatch',
          'candidate belongs to the ECS World bound to this PhysicsWorld',
          'submit the candidate to the PhysicsWorld that owns its entity',
          { entity: input.entity },
        ),
      );
    }
    const hasEntityBody = this.entityMap.has(input.entity);
    if (hasEntityBody) {
      if (this.derivedPoisonedEntities.has(input.entity)) {
        return err(
          new DerivedPhysicsError(
            'derived-recovery-invalid',
            'the entity has a recoverable committed native PhysicsWorld state',
            'rebuild the PhysicsWorld from the last portable snapshot before retrying',
            { entity: input.entity },
          ),
        );
      }
      const active = this.derivedBodies.get(input.entity);
      if (active !== undefined && input.revision <= active.revision) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-stale',
            'candidate revision is newer than the committed derived shape revision',
            'read the latest publication and advance the consumer revision',
            { entity: input.entity, actual: input.revision, expected: `>${active.revision}` },
          ),
        );
      }
      for (const pendingId of this.pendingDerivedCandidates) {
        const pending = this.derivedCandidates.get(pendingId);
        if (pending?.input.entity === input.entity) {
          return err(
            new DerivedPhysicsError(
              'derived-candidate-pending',
              'one body has at most one queued derived-shape candidate',
              'cancel or let the current candidate publish before preparing another',
              { entity: input.entity, candidateId: pendingId },
            ),
          );
        }
      }
    }
    const copied = cloneDerivedPhysicsInput(input);
    if (!copied.ok) return copied;
    const mass = validateMassProperties(copied.value.massProperties);
    if (!mass.ok) return mass;
    if (!hasEntityBody) {
      return err(
        new DerivedPhysicsError(
          'derived-body-not-found',
          'candidate entity has a committed body in this PhysicsWorld',
          'wait for physics reconciliation before preparing derived shapes',
          { entity: input.entity },
        ),
      );
    }
    const candidateBytes = estimateDerivedPhysicsInputBytes(copied.value);
    if (this.derivedCandidateBytes + candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-budget-exceeded',
          `candidate source and native geometry POD fit ${DERIVED_PHYSICS_LIMITS.maxCandidateBytes} bytes`,
          'publish or cancel another candidate, or reduce the candidate geometry',
          {
            entity: input.entity,
            actual: this.derivedCandidateBytes + candidateBytes,
            reason:
              candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes ? 'oversized' : 'in-flight',
          },
        ),
      );
    }
    const body = this.bodyForEntity(input.entity);
    if (body === undefined) {
      return err(
        new DerivedPhysicsError(
          'derived-body-not-found',
          'candidate entity resolves to a live native body',
          'wait for the next ECS physics sync',
          { entity: input.entity },
        ),
      );
    }
    // Recheck the group's preparation credit after potentially reentrant getters.
    const first = batch?.records[0];
    if (
      first === undefined ||
      this.derivedCandidates.get(first.token.candidateId) !== first ||
      first.batch !== batch
    ) {
      const preparations = new Set(
        [...this.derivedCandidates.values()].map((record) => record.batch ?? record),
      );
      if (
        (batch === undefined || !preparations.has(batch)) &&
        preparations.size >= DERIVED_PHYSICS_LIMITS.maxCandidates
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-budget-exceeded',
            `this PhysicsWorld keeps at most ${DERIVED_PHYSICS_LIMITS.maxCandidates} in-flight preparations`,
            'cancel or publish an existing candidate before preparing another',
            { entity: input.entity, actual: preparations.size, reason: 'in-flight' },
          ),
        );
      }
    }
    const candidateInput = Object.freeze({
      ...copied.value,
      ...(mass.value === undefined ? {} : { massProperties: mass.value }),
    });
    const privateInput = candidateInput; // Admission retains the detached first copy.
    // Publication checks read entity/revision, not geometry. Keep their public
    // metadata detached, but copy the already isolated Shape buffers only if
    // a caller actually inspects them. Admission always owns privateInput.
    const publicInput = cloneDerivedPhysicsInput({ ...privateInput, shapes: [] });
    if (!publicInput.ok) return publicInput;
    let inspectedShapes: DerivedPhysicsCandidateInput['shapes'] | undefined;
    const tokenInput = Object.freeze({
      ...publicInput.value,
      get shapes() {
        inspectedShapes ??= cloneDerivedPhysicsInput({
          entity: privateInput.entity,
          revision: privateInput.revision,
          sourceKey: privateInput.sourceKey,
          shapes: privateInput.shapes,
        }).unwrap().shapes;
        return inspectedShapes;
      },
    });
    let staged: ReturnType<typeof stageDerivedColliders>;
    try {
      staged = stageDerivedColliders(
        privateInput.shapes,
        this.derivedBodies.get(input.entity),
        (shape, previous) =>
          this.createDerivedCollider(
            body,
            shape,
            previous,
            privateInput.bodyType === 'dynamic' && privateInput.massProperties?.mode === 'explicit',
          ),
        (handle) =>
          (!this.derivedColliderToShape.get(handle)?.grouped ||
            (privateInput.bodyType === 'dynamic' &&
              privateInput.massProperties?.mode === 'explicit')) &&
          this.raw.colliders.contains(handle) &&
          this.raw.getCollider(handle)?.handle === handle &&
          this.raw.getCollider(handle)?.parent()?.handle === body.handle,
        (handle) => this.removeNativeCollider(handle),
      );
    } catch (cause) {
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'Rapier can create every candidate collider while it remains disabled',
          'reduce the candidate or rebuild the PhysicsWorld after a native failure',
          { entity: input.entity, reason: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
    }
    const candidateId = `derived:${this.backendGeneration}:${input.entity}:${++this.candidateSequence}:${input.revision}`;
    const token: DerivedPhysicsCandidate = Object.freeze({
      candidateId,
      generation: this.backendGeneration,
      owner: this.physicsOwner,
      input: tokenInput,
      state: 'ready',
    });
    this.derivedCandidates.set(candidateId, {
      token,
      ...staged,
      input: privateInput,
      bytes: candidateBytes,
      state: 'ready',
      ...(batch === undefined ? {} : { batch }),
    });
    this.derivedCandidateBytes += candidateBytes;
    return ok(token);
  }

  /** Queue a prepared candidate for the next call to `step()`. */
  admitDerivedShapeCandidate(
    candidate: DerivedPhysicsCandidate,
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
    this.assertActive('admitDerivedShapeCandidate');
    const prepared = this.derivedCandidates.get(candidate.candidateId);
    if (prepared?.batch !== undefined && candidate.owner === this.physicsOwner)
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'a declared preparation is admitted as one complete group',
          'pass every returned member to admitDerivedShapeCandidates',
        ),
      );
    const admitted = this.admitDerivedShapeCandidateInternal(candidate);
    if (admitted.ok && commitGeometry !== undefined) {
      const record = this.derivedCandidates.get(candidate.candidateId);
      if (record !== undefined) record.commitGeometry = commitGeometry;
    }
    return admitted;
  }

  /**
   * Queue the union of complete declared preparation groups as one bounded
   * replacement. Each group is exactly the roster of one
   * prepareDerivedShapeCandidates call, so a caller can spread native shape
   * preparation over several ticks and still admit, commit and roll back the
   * whole replacement atomically.
   */
  admitDerivedShapeCandidateGroups(
    groups: readonly (readonly DerivedPhysicsCandidate[])[],
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidateGroups']>> {
    this.assertActive('admitDerivedShapeCandidateGroups');
    const candidates: DerivedPhysicsCandidate[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!Array.isArray(group) || group.length === 0)
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'every admitted preparation group is one nonempty returned roster',
            'pass each prepareDerivedShapeCandidates result as one group',
          ),
        );
      candidates.push(...group);
    }
    return this.admitDerivedShapeCandidates(candidates, commitGeometry, true);
  }

  /**
   * Queue one complete declared preparation group (or up to maxCandidates
   * individually prepared candidates). `unionOfGroups` is the internal mode
   * of admitDerivedShapeCandidateGroups.
   */
  admitDerivedShapeCandidates(
    candidates: readonly DerivedPhysicsCandidate[],
    commitGeometry?: () => Result<void, Error>,
    unionOfGroups = false,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidates']>> {
    if (!unionOfGroups) this.assertActive('admitDerivedShapeCandidates');
    const records: DerivedCandidateRecord[] = [];
    const sources = new Map<number, DerivedBodySource>();
    const constraints = new Set<string>();
    const invalid = (reason: string) =>
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'one bounded admission contains distinct prepared bodies and constraint updates',
        'prepare one candidate per body and submit the complete replacement together',
        { reason },
      );
    if (candidates.length === 0 || candidates.length > DERIVED_PHYSICS_LIMITS.maxBatchCandidates)
      return err(invalid('invalid batch size'));
    // Resolve credentials before mutating the queue. Never use caller input as
    // the source projection or invalidate another owner's matching token ID.
    for (const candidate of candidates) {
      const record = this.derivedCandidates.get(candidate.candidateId);
      if (
        record === undefined ||
        candidate.owner !== this.physicsOwner ||
        candidate.generation !== this.backendGeneration ||
        record.state !== 'ready'
      )
        return err(invalid('batch member is not a current prepared candidate'));
      if (sources.has(record.input.entity)) return err(invalid('duplicate body'));
      for (const constraint of record.input.constraints ?? []) {
        if (constraints.has(constraint.id)) return err(invalid('duplicate constraint update'));
        constraints.add(constraint.id);
      }
      records.push(record);
      sources.set(record.input.entity, {
        sourceKey: record.input.sourceKey,
        revision: record.input.revision,
      });
    }
    const first = records[0];
    if (first === undefined) return err(invalid('empty preparation group'));
    const refusal = derivedRosterRefusal(records, unionOfGroups);
    if (refusal !== undefined) return err(invalid(refusal));
    // All caller credentials have been resolved. Frozen owned tokens keep
    // the following synchronous validation and enqueue free of caller getters.
    const queuedSources = this.pendingDerivedSources();
    for (const [entity, source] of queuedSources)
      if (!sources.has(entity)) sources.set(entity, source);
    const projection = { sources, queuedSources };
    for (const record of records) {
      const checked = this.admitDerivedShapeCandidateInternal(record.token, projection, true);
      if (!checked.ok) {
        for (const record of records) {
          if (this.derivedCandidates.has(record.token.candidateId))
            this.rejectPreparedCandidate(record, checked.error);
        }
        return checked;
      }
    }
    const batch: DerivedAdmissionBatch = Object.freeze({
      records: Object.freeze(records),
      ...(commitGeometry === undefined ? {} : { commitGeometry }),
    });
    for (const record of records) record.batch = batch;
    const queued: DerivedPhysicsCandidate[] = [];
    for (const record of records) {
      const admitted = this.admitDerivedShapeCandidateInternal(record.token, projection);
      if (!admitted.ok) {
        this.rejectPreparedCandidate(first, admitted.error);
        return admitted;
      }
      queued.push(admitted.value);
    }
    const queueError = this.revalidatePendingDerivedCandidates(first);
    if (queueError !== undefined) return err(queueError);
    return ok(Object.freeze(queued));
  }

  admitDerivedShapeCandidatesGuarded(
    candidates: readonly DerivedPhysicsCandidate[],
    guard: DerivedPhysicsAdmissionGuard,
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidatesGuarded']>> {
    this.assertActive('admitDerivedShapeCandidatesGuarded');
    return queueGuardedDerivedAdmission(
      guard,
      () => this.admitDerivedShapeCandidates(candidates, commitGeometry),
      this.derivedCandidates,
    );
  }
  private preflightDerivedBatch(
    group: readonly DerivedCandidateRecord[],
  ): DerivedPhysicsError | undefined {
    const guard = group[0]?.batch?.preflight;
    if (guard === undefined) return;
    return preflightDerivedBatch(group, {
      generation: this.backendGeneration,
      bodies: this.derivedBodies,
      records: this.derivedCandidates,
      pending: this.pendingDerivedCandidates,
      body: (entity) => this.bodyForEntity(entity),
      execute: (states) => {
        this.activeDerivedPreflight = true;
        this.nativeExecuting = true;
        try {
          return guard(states);
        } finally {
          this.activeDerivedPreflight = false;
          this.nativeExecuting = false;
        }
      },
      validate: (record) =>
        this.validateDerivedAdmission(record.input, this.pendingDerivedSources()),
    });
  }
  getDerivedAdmission(
    entity?: number,
  ):
    | { readonly entity: number; readonly revision: number; readonly fixedStep: number }
    | undefined {
    return currentDerivedAdmission(
      this.activeDerivedAdmission,
      entity,
      () => this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1,
    );
  }

  private admitDerivedShapeCandidateInternal(
    candidate: DerivedPhysicsCandidate,
    projection?: DerivedAdmissionProjection,
    validateOnly = false,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
    this.assertActive('admitDerivedShapeCandidate');
    const record = this.derivedCandidates.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== this.physicsOwner ||
      record.token.owner !== candidate.owner ||
      candidate.generation !== this.backendGeneration
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-not-found',
          'candidate belongs to the current PhysicsWorld generation',
          'discard stale candidate credentials and prepare from committed input again',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    if (this.derivedPoisonedEntities.has(record?.input.entity ?? -1)) {
      return err(
        new DerivedPhysicsError(
          'derived-recovery-invalid',
          'the candidate entity is stopped after an unrecoverable native admission failure',
          'rebuild the PhysicsWorld from its portable snapshot before retrying',
          { entity: record?.input.entity, candidateId: candidate.candidateId },
        ),
      );
    }
    if (record.state === 'cancelled' || record.state === 'invalidated') {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-cancelled',
          'candidate has not been cancelled or invalidated',
          'prepare a new candidate from the latest committed revision',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    if (record.state !== 'ready') {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-pending',
          'a prepared candidate is admitted at most once',
          'retain the returned queued receipt and wait for fixed-step publication',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    const queuedSources = projection?.queuedSources ?? this.pendingDerivedSources();
    const newestPendingRevision = queuedSources.get(record.input.entity)?.revision;
    const pendingSources =
      projection?.sources ??
      new Map(queuedSources).set(record.input.entity, {
        sourceKey: record.input.sourceKey,
        revision: record.input.revision,
      });
    const admissionError = this.validateDerivedAdmission(record.input, pendingSources);
    if (admissionError !== undefined) {
      this.rejectPreparedCandidate(record, admissionError);
      return err(admissionError);
    }
    const active = this.derivedBodies.get(record.input.entity);
    if (
      (record.sharedGeometry !== undefined && active !== record.sharedGeometry.owner) ||
      (record.retainedGeometry !== undefined
        ? active !== record.retainedGeometry
        : active !== undefined && record.input.revision <= active.revision)
    ) {
      const stale = new DerivedPhysicsError(
        'derived-candidate-stale',
        'candidate revision is newer than the committed shape revision',
        'advance the consumer revision before admission',
        { entity: record.input.entity, candidateId: candidate.candidateId },
      );
      this.rejectPreparedCandidate(record, stale);
      return err(stale);
    }
    if (newestPendingRevision !== undefined && record.input.revision <= newestPendingRevision) {
      const stale = new DerivedPhysicsError(
        'derived-candidate-stale',
        'candidate revision advances every already queued revision for the body',
        'admit only the newest body revision at a fixed-step boundary',
        {
          entity: record.input.entity,
          candidateId: candidate.candidateId,
          expected: `>${newestPendingRevision}`,
          actual: record.input.revision,
        },
      );
      this.rejectPreparedCandidate(record, stale);
      return err(stale);
    }
    if (validateOnly) return ok(record.token);
    record.state = 'queued';
    this.pendingDerivedCandidates.add(candidate.candidateId);
    const queued = Object.freeze({ ...record.token, state: 'queued' as const });
    record.token = queued;
    // A batch already projects its complete source roster. Revalidate after
    // the whole synchronous enqueue, rather than after each partial prefix.
    if (projection === undefined) {
      const queueError = this.revalidatePendingDerivedCandidates(record);
      if (queueError !== undefined) return err(queueError);
    }
    return ok(queued);
  }

  private revalidatePendingDerivedCandidates(
    admitted: DerivedCandidateRecord,
  ): DerivedPhysicsError | undefined {
    return revalidatePendingDerivedCandidates(
      this.pendingDerivedCandidates,
      this.derivedCandidates,
      admitted,
      (record, sources) => this.validateDerivedAdmission(record.input, sources),
      (record, error) => this.rejectPreparedCandidate(record, error),
    );
  }

  /** Cancel candidate-native resources; the committed state remains untouched. */
  cancelDerivedShapeCandidate(
    candidate: DerivedPhysicsCandidate,
  ): ReturnType<NonNullable<PhysicsWorld['cancelDerivedShapeCandidate']>> {
    this.assertActive('cancelDerivedShapeCandidate');
    const record = this.derivedCandidates.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== this.physicsOwner ||
      this.derivedBodies.get(record.input.entity)?.candidateId === candidate.candidateId
    ) {
      if (
        candidate.owner === this.physicsOwner &&
        [...this.derivedBodies.values()].some((body) => body.candidateId === candidate.candidateId)
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-cancelled',
            'a published candidate remains the committed result until replaced',
            'submit a newer candidate instead of cancelling committed state',
            { candidateId: candidate.candidateId },
          ),
        );
      }
      return err(
        new DerivedPhysicsError(
          'derived-candidate-not-found',
          'candidate belongs to the current PhysicsWorld',
          'ignore already-retired credentials and prepare again when needed',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    for (const member of record.batch?.records ?? [record]) {
      this.pendingDerivedCandidates.delete(member.token.candidateId);
      for (const collider of member.nativeColliders) this.removeNativeCollider(collider.handle);
      member.state = 'cancelled';
      this.releaseDerivedCandidate(member.token.candidateId);
    }
    return ok(undefined);
  }

  /** Reject all in-flight derived work while preserving the last publication. */
  invalidateDerivedShapeCandidates(reason = 'consumer-invalidated'): void {
    if (this.activeDerivedPreflight) this.assertActive('invalidateDerivedShapeCandidates');
    const committedCandidateIds = new Set(
      [...this.derivedBodies.values()].map((body) => body.candidateId),
    );
    for (const [id, record] of this.derivedCandidates) {
      if (record.state === 'published' || committedCandidateIds.has(id)) continue;
      record.state = 'invalidated';
      for (const collider of record.nativeColliders) this.removeNativeCollider(collider.handle);
      this.releaseDerivedCandidate(id);
    }
    this.pendingDerivedCandidates.clear();
    void reason;
  }

  getTerrainAssetVersion(
    entity: number,
  ): { readonly asset: number; readonly version: number } | undefined {
    this.assertActive('getTerrainAssetVersion');
    if (this.recoveryBlocked()) return undefined;
    const binding = this.terrainColliders.get(entity);
    const version = binding === undefined ? undefined : this.sharedGeometry?.version(binding.asset);
    return binding === undefined || version === undefined
      ? undefined
      : { asset: binding.asset, version };
  }

  getDerivedPublication(entity: number): DerivedPhysicsPublication | undefined {
    this.assertActive('getDerivedPublication');
    if (this.recoveryBlocked()) return undefined;
    return this.derivedPublications.get(entity);
  }

  getDerivedFailure(entity: number): DerivedPhysicsFailure | undefined {
    const failure = this.derivedFailures.get(entity);
    return failure === undefined ? undefined : { ...failure };
  }

  getDerivedBodyType(entity: number): RigidBodyType | undefined {
    this.assertActive('getDerivedBodyType');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    return rapierBodyTypeToString(this.rapierModule, body.bodyType());
  }

  getDerivedBodyMass(entity: number): number | undefined {
    this.assertActive('getDerivedBodyMass');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    return body === undefined ? undefined : body.mass();
  }

  getDerivedMotion(entity: number): DerivedPhysicsMotion | undefined {
    this.assertActive('getDerivedMotion');
    if (this.recoveryBlocked() || !this.derivedBodies.has(entity)) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    return readNativeDerivedMotion(body);
  }

  applyDerivedImpulse(
    input: Parameters<NonNullable<PhysicsWorld['applyDerivedImpulse']>>[0],
  ): Result<void, DerivedPhysicsError> {
    this.assertActive('applyDerivedImpulse');
    const refuse = (code: DerivedPhysicsError['code'], expected: string) =>
      err(
        new DerivedPhysicsError(
          code,
          expected,
          'read the committed dynamic body and submit a finite impulse outside pending admission',
          { entity: input.entity },
        ),
      );
    if (this.recoveryBlocked())
      return refuse('derived-recovery-invalid', 'PhysicsWorld is healthy');
    const record = this.derivedBodies.get(input.entity);
    const body = this.bodyForEntity(input.entity);
    if (record === undefined || body === undefined)
      return refuse('derived-body-not-found', 'a committed derived body exists');
    if (record.sourceKey !== input.sourceKey || record.revision !== input.revision)
      return refuse(
        'derived-candidate-stale',
        'impulse identity matches the committed body revision',
      );
    if (
      this.derivedPublicationPending ||
      [...this.pendingDerivedCandidates].some(
        (id) => this.derivedCandidates.get(id)?.input.entity === input.entity,
      )
    )
      return refuse('derived-candidate-pending', 'the body has no unpublished native mutation');
    if (
      rapierBodyTypeToString(this.rapierModule, body.bodyType()) !== 'dynamic' ||
      ![input.impulse, input.point].every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length === 3 &&
          vector.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value))),
      )
    )
      return refuse(
        'derived-candidate-invalid',
        'a dynamic body receives finite Float32 world vectors',
      );
    try {
      this.contactDeltaTime = 0;
      body.applyImpulseAtPoint(
        { x: input.impulse[0], y: input.impulse[1], z: input.impulse[2] },
        { x: input.point[0], y: input.point[1], z: input.point[2] },
        true,
      );
      const linear = body.linvel(),
        angular = body.angvel();
      if (![linear.x, linear.y, linear.z, angular.x, angular.y, angular.z].every(Number.isFinite))
        throw new Error('native impulse produced non-finite motion');
      return ok(undefined);
    } catch (cause) {
      this.derivedPoisonedEntities.add(input.entity);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'native impulse completes with finite motion',
          'rebuild the World from a previously committed snapshot',
          { entity: input.entity, reason: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
    }
  }

  getDerivedRecoveryState(): 'ready' | 'rebuild-required' {
    return this.recoveryBlocked() ? 'rebuild-required' : 'ready';
  }

  getDerivedShapes(entity: number): readonly DerivedShapeState[] {
    this.assertActive('getDerivedShapes');
    if (this.recoveryBlocked()) return [];
    const body = this.derivedBodies.get(entity);
    if (body === undefined) return [];
    return describeDerivedShapes(body, entity);
  }

  getDerivedConstraintStates(): readonly Pick<
    PhysicsConstraintInput,
    'id' | 'revision' | 'bodyA' | 'bodyB'
  >[] {
    this.assertActive('getDerivedConstraintStates');
    return describeDerivedConstraints(this.derivedConstraints);
  }

  captureDerivedPhysicsState(): DerivedPhysicsSnapshot {
    this.assertActive('captureDerivedPhysicsState');
    return Object.freeze({
      generation: this.backendGeneration,
      fixedStep: this.fixedStep,
      bodies: Object.freeze(
        [...this.derivedBodies.values()].map((body) => ({
          entity: body.entity,
          revision: body.revision,
          sourceKey: body.sourceKey,
          ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType }),
          ...(body.velocityPolicy === undefined ? {} : { velocityPolicy: body.velocityPolicy }),
          shapes: copyDerivedShapeInputs(body),
          ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
          ...(() => {
            const motion = this.getDerivedMotion(body.entity);
            return motion === undefined ? {} : { motion };
          })(),
          constraints: Object.freeze(this.constraintsForBody(body.entity)),
        })),
      ),
    });
  }

  restoreDerivedPhysicsState(
    snapshot: DerivedPhysicsSnapshot,
  ): ReturnType<NonNullable<PhysicsWorld['restoreDerivedPhysicsState']>> {
    this.assertActive('restoreDerivedPhysicsState');
    const snapshotSources = new Map<number, DerivedBodySource>();
    for (const body of snapshot.bodies) {
      if (snapshotSources.has(body.entity)) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'a portable snapshot contains one committed body row per entity',
            'capture the snapshot from one PhysicsWorld without duplicate entities',
            { entity: body.entity },
          ),
        );
      }
      snapshotSources.set(body.entity, {
        sourceKey: body.sourceKey,
        revision: body.revision,
      });
    }
    const preparedCandidates: DerivedPhysicsCandidate[] = [];
    const restoredConstraintIds = new Set<string>();
    for (const body of snapshot.bodies) {
      const prepared = this.prepareDerivedShapeCandidate({
        entity: body.entity,
        revision: body.revision,
        sourceKey: body.sourceKey,
        shapes: body.shapes,
        ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType }),
        ...(body.velocityPolicy === undefined ? {} : { velocityPolicy: body.velocityPolicy }),
        ...(body.motion === undefined ? {} : { motion: body.motion }),
        ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
        constraints: body.constraints.filter((constraint) => {
          if (restoredConstraintIds.has(constraint.id)) return false;
          restoredConstraintIds.add(constraint.id);
          return true;
        }),
      });
      if (!prepared.ok) {
        for (const candidate of preparedCandidates) this.cancelDerivedShapeCandidate(candidate);
        return prepared;
      }
      preparedCandidates.push(prepared.value);
    }
    if (preparedCandidates.length === 0) return ok([]);
    return this.admitDerivedShapeCandidates(preparedCandidates);
  }

  createDerivedConstraint(
    input: PhysicsConstraintInput,
  ): ReturnType<NonNullable<PhysicsWorld['createDerivedConstraint']>> {
    return this.installDerivedConstraint(input, false);
  }

  updateDerivedConstraint(
    input: PhysicsConstraintInput,
  ): ReturnType<NonNullable<PhysicsWorld['updateDerivedConstraint']>> {
    return this.installDerivedConstraint(input, true);
  }

  removeDerivedConstraint(
    id: string,
  ): ReturnType<NonNullable<PhysicsWorld['removeDerivedConstraint']>> {
    this.assertActive('removeDerivedConstraint');
    const existing = this.derivedConstraints.get(id);
    if (existing === undefined) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-not-found',
          'constraint identity is currently committed',
          'ignore repeated cleanup or reconcile the owning constraint set',
          { constraintId: id },
        ),
      );
    }
    this.removeNativeConstraint(existing.handle);
    this.derivedConstraints.delete(id);
    return ok(undefined);
  }

  createManagedJoints(
    inputs: readonly ManagedJointInput[],
  ): Result<ManagedJointBinding, ManagedPhysicsFailure> {
    this.assertActive('createManagedJoints');
    const valid = validateManagedJoints(inputs);
    if (!valid.ok) return valid;
    for (const input of inputs)
      for (const entity of [input.bodyA, input.bodyB]) {
        if (this.bodyForEntity(entity) === undefined)
          return err(new ManagedPhysicsError('managed-body-missing', { entity }));
      }
    const handles: number[] = [];
    const release = (): boolean => {
      for (const handle of handles) this.removeNativeConstraint(handle);
      return handles.every((handle) => this.raw.getImpulseJoint(handle) == null);
    };
    try {
      for (const input of inputs) {
        const data = createManagedJointData(this.rapierModule, input);
        const joint = this.raw.createImpulseJoint(
          data,
          this.bodyForEntity(input.bodyA),
          this.bodyForEntity(input.bodyB),
          true,
        );
        handles.push(joint.handle);
        joint.setContactsEnabled(input.contactsEnabled ?? false);
        if (input.kind === 'hinge') joint.setLimits(input.limits[0], input.limits[1]);
      }
      let active = true;
      return ok({
        dispose: () => {
          if (!active) return;
          active = false;
          if (this.disposed) return;
          if (!release())
            throw new ManagedPhysicsError('managed-physics-failed', {
              reason: 'native managed joint cleanup failed',
              recovery: 'rebuild-required',
            });
        },
      });
    } catch (cause) {
      const released = release();
      return err(
        new ManagedPhysicsError('managed-physics-failed', {
          reason: cause instanceof Error ? cause.message : String(cause),
          recovery: released ? 'old-state-retained' : 'rebuild-required',
        }),
      );
    }
  }

  getJointCount(): number {
    this.assertActive('getJointCount');
    return this.raw.impulseJoints.len();
  }

  getBodyMotion(entity: number): Result<BodyMotion, ManagedPhysicsFailure> {
    this.assertActive('getBodyMotion');
    const body = this.bodyForEntity(entity);
    if (body === undefined) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    return ok(readNativeBodyMotion(body));
  }

  setBodyMotion(
    entity: number,
    motion: Omit<BodyMotion, 'sleeping'>,
  ): Result<void, ManagedPhysicsFailure> {
    this.assertActive('setBodyMotion');
    const body = this.bodyForEntity(entity);
    if (body === undefined) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    if (
      !finitePhysicsVector(motion.position, 3) ||
      !unitPhysicsQuaternion(motion.rotation) ||
      !finitePhysicsVector(motion.linearVelocity, 3) ||
      !finitePhysicsVector(motion.angularVelocity, 3)
    )
      return err(
        new ManagedPhysicsError('managed-joint-invalid', {
          index: -1,
          reason: 'finite pose/velocities and unit rotation required',
        }),
      );
    const vector = (value: readonly number[]) => ({ x: value[0], y: value[1], z: value[2] });
    try {
      this.contactDeltaTime = 0;
      body.setTranslation(vector(motion.position), true);
      body.setRotation({ ...vector(motion.rotation), w: motion.rotation[3] }, true);
      body.setLinvel(vector(motion.linearVelocity), true);
      body.setAngvel(
        this.entityMap.get(entity)?.lockRotation
          ? { x: 0, y: 0, z: 0 }
          : vector(motion.angularVelocity),
        true,
      );
      this.poseWritebackEntities.add(entity);
      return ok(undefined);
    } catch (cause) {
      return err(
        new ManagedPhysicsError('managed-physics-failed', {
          reason: String(cause),
          recovery: 'rebuild-required',
        }),
      );
    }
  }

  applyBodyImpulse(entity: number, impulse: PhysicsVector): Result<void, ManagedPhysicsFailure> {
    this.assertActive('applyBodyImpulse');
    const body = this.bodyForEntity(entity);
    if (body === undefined) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    if (!body.isDynamic() || !finitePhysicsVector(impulse, 3))
      return err(
        new ManagedPhysicsError('managed-joint-invalid', {
          index: -1,
          reason: 'finite impulse and dynamic body required',
        }),
      );
    try {
      this.contactDeltaTime = 0;
      body.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
      return ok(undefined);
    } catch (cause) {
      return err(
        new ManagedPhysicsError('managed-physics-failed', {
          reason: String(cause),
          recovery: 'rebuild-required',
        }),
      );
    }
  }

  private createDerivedCollider(
    body: RapierRigidBody,
    shape: DerivedShapeInput,
    previous?: DerivedShapeRecord,
    allowGroups = false,
  ): { readonly handle: number; readonly colliderHandles?: readonly number[] } {
    const { colliders } = createDerivedColliderGroup(
      this.rapierModule,
      this.raw,
      body,
      shape,
      previous,
      allowGroups,
    );
    try {
      for (const [groupIndex, collider] of colliders.entries()) {
        this.syncIsolationCollider(collider, body.userData);
        this.derivedColliderToShape.set(collider.handle, {
          entity: body.userData,
          id: shape.id,
          ...(colliders.length > 1 ? { grouped: true, groupIndex } : {}),
        });
      }
      const first = colliders[0];
      if (first === undefined) return this.colliderFailure('derived shape produced no collider');
      return {
        handle: first.handle,
        ...(colliders.length > 1
          ? {
              colliderHandles: Object.freeze(colliders.map((collider) => collider.handle)),
            }
          : {}),
      };
    } catch (error) {
      for (const collider of colliders) this.removeNativeCollider(collider.handle);
      throw error;
    }
  }

  private removeNativeCollider(handle: number): void {
    this.isolationColliderOwners.delete(handle);
    this.derivedColliderToShape.delete(handle);
    if (!this.raw.colliders.contains(handle)) return;
    try {
      const collider = (this.raw as RapierWorld).getCollider(handle);
      if (collider !== null && collider !== undefined && collider.handle === handle) {
        (this.raw as RapierWorld).removeCollider(collider, false);
      }
    } catch {
      // Native removal is idempotent from the Engine lifecycle perspective.
    }
  }

  private createNativeConstraint(
    input: PhysicsConstraintInput,
  ): Result<{ readonly handle: number }, DerivedPhysicsError> {
    let native: RapierWorld | undefined;
    try {
      const bodyA = this.bodyForEntity(input.bodyA);
      const bodyB = this.bodyForEntity(input.bodyB);
      if (bodyA === undefined || bodyB === undefined) {
        return err(
          new DerivedPhysicsError(
            'derived-body-not-found',
            'both constraint endpoints have committed bodies in this PhysicsWorld',
            'reconcile both entities before creating the constraint',
            { constraintId: input.id },
          ),
        );
      }
      const jointData = createDerivedJointData(this.rapierModule, input);
      native = this.raw.createImpulseJoint(jointData, bodyA, bodyB, true);
      if (input.kind === 'hinge' && input.limits !== undefined)
        native.setLimits(input.limits[0], input.limits[1]);
      return ok({ handle: native.handle });
    } catch (cause) {
      if (native !== undefined) this.removeNativeConstraint(native.handle);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'the selected Rapier joint can be created for both endpoint bodies',
          'repair endpoint state or use a supported spring/hinge input',
          {
            constraintId: input.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
  }

  private rememberDerivedFailure(
    record: DerivedCandidateRecord,
    error: DerivedPhysicsError,
    recovery: DerivedPhysicsFailure['recovery'],
  ): void {
    record.state = 'failed';
    this.pendingDerivedCandidates.delete(record.token.candidateId);
    this.derivedFailures.set(
      record.input.entity,
      Object.freeze({
        candidateId: record.token.candidateId,
        entity: record.input.entity,
        revision: record.input.revision,
        fixedStep: this.fixedStep,
        error,
        recovery,
      }),
    );
    this.releaseDerivedCandidate(record.token.candidateId);
  }

  private rejectPreparedCandidate(
    record: DerivedCandidateRecord,
    error: DerivedPhysicsError,
  ): void {
    for (const member of record.batch?.records ?? [record]) {
      if (!this.derivedCandidates.has(member.token.candidateId)) continue;
      for (const collider of member.nativeColliders) this.removeNativeCollider(collider.handle);
      this.rememberDerivedFailure(member, error, 'old-state-retained');
    }
  }

  private processDerivedCandidates(): boolean {
    if (this.pendingDerivedCandidates.size === 0) return false;
    const pendingRecords = [...this.pendingDerivedCandidates]
      .map((id) => this.derivedCandidates.get(id))
      .filter((record): record is DerivedCandidateRecord => record?.state === 'queued');
    const { ordered, cyclic } = orderDerivedCandidateGroups(pendingRecords);
    for (const { record, key } of cyclic)
      this.rejectPreparedCandidate(
        record,
        new DerivedPhysicsError(
          'derived-constraint-invalid',
          'cyclic endpoint updates share one batch',
          'submit mutually dependent body replacements together',
          { candidateId: key },
        ),
      );
    let geometryCommitted = false;
    for (const group of ordered) {
      if (this.derivedPoisonedEntities.size > 0) break;
      const first = group[0];
      if (first === undefined) continue;
      if (
        group.some(
          (record) =>
            record.state !== 'queued' ||
            !this.pendingDerivedCandidates.has(record.token.candidateId),
        )
      )
        continue;
      // Validate the whole final projection before any native body changes.
      const rejected = this.derivedGroupRejection(group) ?? this.preflightDerivedBatch(group);
      if (rejected !== undefined) {
        this.rejectPreparedCandidate(first, rejected);
        continue;
      }
      if (this.admitDerivedGroup(group)) geometryCommitted = true;
    }
    return geometryCommitted;
  }

  private derivedGroupRejection(
    group: readonly DerivedCandidateRecord[],
  ): DerivedPhysicsError | undefined {
    const sources = this.pendingDerivedSources();
    for (const record of group) {
      const rejected = this.derivedRecordRejection(record, sources);
      if (rejected !== undefined) return rejected;
    }
    return undefined;
  }

  private derivedRecordRejection(
    record: DerivedCandidateRecord,
    sources: ReadonlyMap<number, DerivedBodySource>,
  ): DerivedPhysicsError | undefined {
    const entity = record.input.entity;
    const projected = sources.get(entity);
    if (projected !== undefined && record.input.revision < projected.revision)
      return new DerivedPhysicsError(
        'derived-candidate-stale',
        'fixed-step admission publishes the final queued body revisions',
        'discard the older group and prepare a complete replacement',
        { entity },
      );
    if (
      (record.retainedGeometry !== undefined || record.sharedGeometry !== undefined) &&
      !retainedDerivedGeometryCurrent(
        record,
        this.derivedBodies.get(entity),
        this.raw,
        this.bodyForEntity(entity)?.handle,
      )
    )
      return new DerivedPhysicsError(
        'derived-candidate-stale',
        'admission retains the exact accepted geometry owner',
        'read its new publication and prepare again',
        { entity },
      );
    if (this.derivedPoisonedEntities.has(entity))
      return new DerivedPhysicsError(
        'derived-recovery-invalid',
        'every batch body has recoverable native state',
        'rebuild the PhysicsWorld before retrying',
        { entity },
      );
    if (this.bodyForEntity(entity) === undefined)
      return new DerivedPhysicsError(
        'derived-body-not-found',
        'every batch body remains live through admission',
        'reconcile entities and prepare again',
        { entity },
      );
    return this.validateDerivedAdmission(record.input, sources);
  }

  /** Commits every member or rolls back the whole group; returns whether geometry was accepted. */
  private admitDerivedGroup(group: readonly DerivedCandidateRecord[]): boolean {
    let geometryCommitted = false;
    const undos: DerivedAdmissionUndo[] = [];
    for (const record of group) {
      const undo = this.captureDerivedAdmissionUndo(record);
      try {
        const committed = this.stageDerivedRecord(undo);
        if (this.acceptDerivedGeometry(undo, group)) geometryCommitted = true;
        this.adoptDerivedRecord(record, committed);
        undos.push(undo);
      } catch (cause) {
        this.failDerivedGroup(group, undo, undos, cause);
        break;
      }
    }
    return geometryCommitted;
  }

  private captureDerivedAdmissionUndo(record: DerivedCandidateRecord): DerivedAdmissionUndo {
    const entity = record.input.entity;
    const old = this.derivedBodies.get(entity);
    const body = this.bodyForEntity(entity);
    return {
      record,
      body,
      bodyState: captureDerivedBodyState(body),
      old,
      automaticAdditionalMass: this.entityMap.get(entity)?.automaticAdditionalMass ?? 0,
      automaticRecordMass: this.entityMap.get(entity)?.automaticAdditionalMass,
      source: this.derivedBodySources.get(entity),
      publication: this.derivedPublications.get(entity),
      colliders: this.bodyColliders(body).map((collider) => ({
        collider,
        density: typeof collider.density === 'function' ? collider.density() : undefined,
        enabled: typeof collider.isEnabled === 'function' ? collider.isEnabled() : true,
      })),
      constraints: new Map(this.derivedConstraints),
      stagedConstraints: new Map<string, DerivedConstraintRecord>(),
      geometryCommitUncertain: false,
    };
  }

  /** Applies the candidate natively and returns the body record it will own once accepted. */
  private stageDerivedRecord(undo: DerivedAdmissionUndo): DerivedBodyRecord {
    const { record, body, old } = undo;
    primeGroupedContacts(
      this.raw,
      old,
      candidateShapeRecords(record),
      this.derivedColliderToShape,
      this.groupedContactEvents,
    );
    this.stageDerivedConstraints(record, undo.stagedConstraints);
    if (record.input.bodyType !== undefined)
      body.setBodyType(rapierBodyTypeFromString(this.rapierModule, record.input.bodyType), true);
    this.enableCandidateColliders(record);
    // Disable superseded shapes before the mass refresh. They carry no mass
    // after admission, but Rapier still integrates every enabled collider's
    // mass properties, which dominates retiring many voxel bodies at once.
    if (old !== undefined && record.retainedGeometry === undefined)
      this.retireReplacedDerivedShapes(record, old);
    if (record.input.motion?.rotation !== undefined) {
      const [x, y, z, w] = record.input.motion.rotation;
      body.setRotation({ x, y, z, w }, true);
    }
    this.applyDerivedMass(
      body,
      record.input.massProperties,
      undo.bodyState.worldCom,
      record.input.velocityPolicy ?? 'preserve',
      this.entityMap.get(record.input.entity)?.additionalMass ?? 0,
      record.input.entity,
      record.input.shapes,
      candidateNativeColliders(record),
    );
    if (record.input.motion !== undefined)
      applyDerivedMotion(
        body,
        record.input.motion,
        this.entityMap.get(record.input.entity)?.lockRotation === true,
      );
    // Retire joints against this committed revision only. Other queued
    // endpoints may still fail and retain their previous joints.
    if (this.derivedConstraints.size > 0) this.retireSupersededConstraints(record);
    this.adoptStagedConstraints(record, undo.stagedConstraints);
    return {
      entity: record.input.entity,
      sourceKey: record.input.sourceKey,
      generation: this.backendGeneration,
      revision: record.input.revision,
      bodyType: record.input.bodyType,
      velocityPolicy: record.input.velocityPolicy,
      candidateId: record.token.candidateId,
      shapes: candidateShapeRecords(record),
      massProperties: record.input.massProperties,
      constraints: record.retainedGeometry?.constraints ?? [...(record.input.constraints ?? [])],
    };
  }

  private stageDerivedConstraints(
    record: DerivedCandidateRecord,
    staged: Map<string, DerivedConstraintRecord>,
  ): void {
    for (const constraint of record.input.constraints ?? []) {
      const created = this.createNativeConstraint(constraint);
      if (!created.ok) throw created.error;
      staged.set(constraint.id, { input: { ...constraint }, handle: created.value.handle });
    }
  }

  private enableCandidateColliders(record: DerivedCandidateRecord): void {
    for (const native of record.nativeColliders) {
      const collider = (this.raw as RapierWorld).getCollider(native.handle);
      if (collider === null || collider === undefined)
        throw new Error('candidate collider disappeared');
      collider.setEnabled(true);
    }
  }

  private retireSupersededConstraints(record: DerivedCandidateRecord): void {
    // Project this endpoint only; sourceForEntity reads other committed sources.
    const committedSources = new Map([
      [record.input.entity, { sourceKey: record.input.sourceKey, revision: record.input.revision }],
    ]);
    const replacementConstraintIds = new Set(
      (record.input.constraints ?? []).map((constraint) => constraint.id),
    );
    for (const [constraintId, current] of [...this.derivedConstraints]) {
      if (
        replacementConstraintIds.has(constraintId) ||
        this.constraintDependenciesMatch(current.input, committedSources)
      )
        continue;
      this.removeNativeConstraint(current.handle);
      this.derivedConstraints.delete(constraintId);
    }
  }

  private retireReplacedDerivedShapes(
    record: DerivedCandidateRecord,
    old: DerivedBodyRecord,
  ): void {
    const retained = new Set(record.sharedGeometry?.shapes.flatMap(derivedShapeHandles));
    for (const handle of old.shapes.flatMap(derivedShapeHandles)) {
      if (retained.has(handle)) continue;
      const collider = (this.raw as RapierWorld).getCollider(handle);
      if (collider !== null && collider !== undefined) collider.setEnabled(false);
    }
    this.retiredDerivedBodies.push(old);
  }

  private adoptStagedConstraints(
    record: DerivedCandidateRecord,
    staged: ReadonlyMap<string, DerivedConstraintRecord>,
  ): void {
    for (const constraint of record.input.constraints ?? []) {
      const previous = this.derivedConstraints.get(constraint.id);
      if (previous !== undefined) this.removeNativeConstraint(previous.handle);
      const adopted = staged.get(constraint.id);
      if (adopted !== undefined) this.derivedConstraints.set(constraint.id, adopted);
    }
  }

  /** The last group member runs the consumer geometry commit; returns whether it ran. */
  private acceptDerivedGeometry(
    undo: DerivedAdmissionUndo,
    group: readonly DerivedCandidateRecord[],
  ): boolean {
    const record = undo.record;
    // No native mutation may follow geometry acceptance before recording ownership.
    const commitGeometry =
      record === group[group.length - 1]
        ? (record.batch?.commitGeometry ?? record.commitGeometry)
        : undefined;
    if (commitGeometry === undefined) return false;
    this.activeDerivedAdmission = record;
    try {
      undo.geometryCommitUncertain = true;
      const geometry = commitGeometry();
      undo.geometryCommitUncertain = false;
      if (!geometry.ok) throw geometry.error;
    } finally {
      this.activeDerivedAdmission = undefined;
    }
    delete record.commitGeometry;
    return true;
  }

  private adoptDerivedRecord(record: DerivedCandidateRecord, committed: DerivedBodyRecord): void {
    this.derivedBodies.set(record.input.entity, committed);
    const entityRecord = this.entityMap.get(record.input.entity);
    if (entityRecord !== undefined) {
      entityRecord.automaticAdditionalMass =
        record.input.massProperties?.mode === 'explicit' ? 0 : entityRecord.additionalMass;
    }
    this.derivedBodySources.set(record.input.entity, {
      sourceKey: record.input.sourceKey,
      revision: record.input.revision,
    });
    this.derivedFailures.delete(record.input.entity);
    record.state = 'queued';
    this.pendingDerivedCandidates.delete(record.token.candidateId);
  }

  private failDerivedGroup(
    group: readonly DerivedCandidateRecord[],
    failed: DerivedAdmissionUndo,
    committed: DerivedAdmissionUndo[],
    cause: unknown,
  ): void {
    let restored = this.tryRollbackDerivedAdmission(failed);
    for (const undo of committed.reverse()) {
      if (!this.tryRollbackDerivedAdmission(undo)) restored = false;
    }
    const error =
      cause instanceof DerivedPhysicsError
        ? cause
        : new DerivedPhysicsError(
            'derived-backend-failed',
            'derived admission either commits completely or preserves the prior body state',
            'inspect the failure receipt and rebuild the PhysicsWorld if recovery is required',
            {
              entity: failed.record.input.entity,
              candidateId: failed.record.token.candidateId,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          );
    // A thrown consumer callback can have changed ECS state. Native
    // rollback alone cannot certify any member of that combined group.
    if (failed.geometryCommitUncertain) restored = false;
    for (const member of group) {
      if (!restored) {
        this.derivedPoisonedEntities.add(member.input.entity);
        this.derivedBodies.delete(member.input.entity);
        this.derivedPublications.delete(member.input.entity);
      }
      this.rememberDerivedFailure(
        member,
        error,
        restored ? 'old-state-retained' : 'rebuild-required',
      );
    }
  }

  private tryRollbackDerivedAdmission(undo: DerivedAdmissionUndo): boolean {
    try {
      return this.rollbackDerivedAdmission(undo);
    } catch {
      return false;
    }
  }

  private rollbackDerivedAdmission(undo: DerivedAdmissionUndo): boolean {
    for (const staged of undo.stagedConstraints.values())
      this.removeNativeConstraint(staged.handle);
    // A partial commit may have replaced joints. Recreate old native joints
    // after restoring bodies instead of retaining stale JS handles.
    for (const current of this.derivedConstraints.values())
      this.removeNativeConstraint(current.handle);
    this.derivedConstraints.clear();
    if (undo.old !== undefined) this.reinstateDerivedBody(undo.record.input.entity, undo.old);
    this.discardCandidateColliders(undo);
    const restored = this.restoreDerivedNativeBody(undo);
    this.restoreDerivedOwnership(undo);
    return restored;
  }

  private reinstateDerivedBody(entity: number, old: DerivedBodyRecord): void {
    for (const handle of old.shapes.flatMap(derivedShapeHandles)) {
      const collider = (this.raw as RapierWorld).getCollider(handle);
      if (collider !== null && collider !== undefined) collider.setEnabled(true);
    }
    const retiredIndex = this.retiredDerivedBodies.indexOf(old);
    if (retiredIndex >= 0) this.retiredDerivedBodies.splice(retiredIndex, 1);
    this.derivedBodies.set(entity, old);
    this.derivedBodySources.set(entity, { sourceKey: old.sourceKey, revision: old.revision });
  }

  /** Removes staged colliders and restores the prior colliders' density and enablement. */
  private discardCandidateColliders(undo: DerivedAdmissionUndo): void {
    for (const native of undo.record.nativeColliders) {
      const collider = (this.raw as RapierWorld).getCollider(native.handle);
      if (collider !== null && collider !== undefined) collider.setEnabled(false);
    }
    // Remove staged colliders before Rapier's deferred mass recomputation.
    for (const native of undo.record.nativeColliders) this.removeNativeCollider(native.handle);
    for (const { collider, density, enabled } of undo.colliders) {
      if (this.raw.getCollider(collider.handle) === null) continue;
      if (density !== undefined && typeof collider.setDensity === 'function')
        collider.setDensity(density);
      if (typeof collider.setEnabled === 'function') collider.setEnabled(enabled);
    }
  }

  private restoreDerivedNativeBody(undo: DerivedAdmissionUndo): boolean {
    const { body, bodyState: state } = undo;
    try {
      body.setBodyType(state.bodyType, true);
      this.restoreCommittedMass(body, undo.old, undo.automaticAdditionalMass);
      body.setTranslation(state.translation, true);
      body.setRotation(state.rotation, true);
      body.setLinvel(state.linearVelocity, true);
      body.setAngvel(state.angularVelocity, true);
      body.setEnabled(state.enabled);
    } catch {
      return false;
    }
    if (!this.restoreNativeConstraints(undo.constraints)) return false;
    return derivedBodyStateRestored(body, state);
  }

  private restoreDerivedOwnership(undo: DerivedAdmissionUndo): void {
    const entity = undo.record.input.entity;
    if (undo.old === undefined) this.derivedBodies.delete(entity);
    else this.derivedBodies.set(entity, undo.old);
    if (undo.source === undefined) this.derivedBodySources.delete(entity);
    else this.derivedBodySources.set(entity, undo.source);
    if (undo.publication === undefined) this.derivedPublications.delete(entity);
    else this.derivedPublications.set(entity, undo.publication);
    const entityRecord = this.entityMap.get(entity);
    if (entityRecord !== undefined && undo.automaticRecordMass !== undefined)
      entityRecord.automaticAdditionalMass = undo.automaticRecordMass;
  }

  private publishDerivedCandidates(): void {
    // Publish queued preparation slots that still own their Body.
    for (const candidate of this.derivedCandidates.values()) {
      if (candidate.state !== 'queued') continue;
      const body = this.derivedBodies.get(candidate.input.entity);
      if (body?.candidateId !== candidate.token.candidateId) continue;
      this.derivedPublications.set(
        body.entity,
        Object.freeze({
          candidateId: body.candidateId,
          entity: body.entity,
          revision: body.revision,
          fixedStep: this.fixedStep,
          shapeIds: Object.freeze(body.shapes.map((shape) => shape.input.id)),
          generation: body.generation,
        }),
      );
      // The committed body/publication now own native colliders and identity.
      // Release the private preparation copy and its transient slot.
      this.releaseDerivedCandidate(body.candidateId);
    }
  }

  private retireDerivedBodies(): void {
    for (const body of this.retiredDerivedBodies.splice(0)) {
      const retained = new Set(
        this.derivedBodies.get(body.entity)?.shapes.flatMap(derivedShapeHandles),
      );
      for (const handle of body.shapes.flatMap(derivedShapeHandles))
        if (!retained.has(handle)) this.removeNativeCollider(handle);
      this.releaseDerivedCandidate(body.candidateId);
    }
  }

  private applyDerivedMass(
    body: RapierRigidBody,
    properties: PhysicsMassProperties | undefined,
    previousWorldCom: { x: number; y: number; z: number },
    velocityPolicy: 'preserve' | 'reset',
    authoredAdditionalMass: number,
    entity: number,
    candidateShapes: readonly DerivedShapeInput[],
    candidateColliders: readonly { readonly handle: number }[],
  ): void {
    const oldVelocity = body.linvel();
    const oldAngularVelocity = this.entityMap.get(entity)?.lockRotation
      ? { x: 0, y: 0, z: 0 }
      : body.angvel();
    if (properties?.mode === 'explicit') {
      // Explicit mass is the sole source for this body. Zero every ordinary
      // and derived collider density first so Rapier does not add a hidden
      // density contribution to the authored value.
      this.rememberAuthoredDensity(entity, body);
      for (const collider of this.bodyColliders(body)) {
        if (typeof collider.setDensity === 'function') collider.setDensity(0);
      }
      const frame = properties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
      body.setAdditionalMassProperties(
        properties.mass,
        {
          x: properties.centerOfMass[0],
          y: properties.centerOfMass[1],
          z: properties.centerOfMass[2],
        },
        {
          x: properties.principalInertia[0],
          y: properties.principalInertia[1],
          z: properties.principalInertia[2],
        },
        { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
        true,
      );
      // Rapier defers additional mass updates. Admission reads worldCom below
      // before stepping, so refresh now or COM restoration shifts the body twice.
      body.recomputeMassPropertiesFromColliders();
    } else {
      restoreDerivedDensities(
        this.bodyColliders(body),
        properties?.mode === 'automatic' ? properties.density : undefined,
        this.entityMap.get(entity)?.authoredDensity ?? 1,
        candidateShapes,
        candidateColliders,
        this.derivedColliderToShape,
      );
      this.restoreAutomaticMass(body, authoredAdditionalMass);
    }
    if (velocityPolicy === 'reset') {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    const nextWorldCom = body.worldCom();
    const next = preserveCenterOfMassVelocity(
      [oldVelocity.x, oldVelocity.y, oldVelocity.z],
      [oldAngularVelocity.x, oldAngularVelocity.y, oldAngularVelocity.z],
      [previousWorldCom.x, previousWorldCom.y, previousWorldCom.z],
      [nextWorldCom.x, nextWorldCom.y, nextWorldCom.z],
    );
    body.setLinvel({ x: next[0], y: next[1], z: next[2] }, true);
    body.setAngvel(oldAngularVelocity, true);
  }

  /** Restore the complete committed mass policy after a failed admission. */
  private restoreCommittedMass(
    body: RapierRigidBody,
    previous: DerivedBodyRecord | undefined,
    automaticAdditionalMass: number,
  ): void {
    if (previous?.massProperties?.mode === 'explicit') {
      const frame = previous.massProperties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
      body.setAdditionalMassProperties(
        previous.massProperties.mass,
        {
          x: previous.massProperties.centerOfMass[0],
          y: previous.massProperties.centerOfMass[1],
          z: previous.massProperties.centerOfMass[2],
        },
        {
          x: previous.massProperties.principalInertia[0],
          y: previous.massProperties.principalInertia[1],
          z: previous.massProperties.principalInertia[2],
        },
        { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
        true,
      );
      body.recomputeMassPropertiesFromColliders();
      return;
    }
    this.restoreAutomaticMass(body, automaticAdditionalMass);
  }

  /**
   * Rapier keeps `setAdditionalMassProperties` as native state even after a
   * collider recompute. Clear that override explicitly before recomputing so
   * automatic candidates and rollback really return to the authored policy.
   */
  private restoreAutomaticMass(body: RapierRigidBody, additionalMass: number): void {
    body.setAdditionalMass(Math.max(0, additionalMass), true);
    body.recomputeMassPropertiesFromColliders();
  }

  private rememberAuthoredDensity(entity: number, body: RapierRigidBody): void {
    const record = this.entityMap.get(entity);
    if (record === undefined || record.authoredDensity !== undefined) return;
    const authored = this.bodyColliders(body).find(
      (collider) =>
        !this.derivedColliderToShape.has(collider.handle) &&
        this.terrainColliders.get(entity)?.collider !== collider.handle,
    );
    const density =
      authored !== undefined && typeof authored.density === 'function'
        ? authored.density()
        : undefined;
    if (density !== undefined && Number.isFinite(density) && density >= 0)
      record.authoredDensity = density;
  }

  private restoreNativeConstraints(
    previous: ReadonlyMap<string, DerivedConstraintRecord>,
  ): boolean {
    for (const [constraintId, record] of previous) {
      const recreated = this.createNativeConstraint(record.input);
      if (!recreated.ok) {
        for (const current of this.derivedConstraints.values())
          this.removeNativeConstraint(current.handle);
        this.derivedConstraints.clear();
        return false;
      }
      this.derivedConstraints.set(constraintId, {
        input: { ...record.input },
        handle: recreated.value.handle,
      });
    }
    return true;
  }

  private bodyColliders(body: RapierRigidBody): RapierWorld[] {
    const result: RapierWorld[] = [];
    for (let index = 0; index < body.numColliders(); index += 1) {
      const collider = body.collider(index);
      if (collider !== null && collider !== undefined) result.push(collider);
    }
    return result;
  }

  private releaseDerivedCandidate(candidateId: string): void {
    const record = this.derivedCandidates.get(candidateId);
    if (record === undefined) return;
    this.derivedCandidateBytes = Math.max(0, this.derivedCandidateBytes - record.bytes);
    this.derivedCandidates.delete(candidateId);
  }

  private sourceForEntity(entity: number): DerivedBodySource {
    return (
      this.derivedBodySources.get(entity) ?? {
        sourceKey: `entity:${entity}`,
        revision: 0,
      }
    );
  }

  /**
   * Project the final source revision of every queued body. Constraint
   * dependencies are checked against this projection, not against whichever
   * queued candidate happens to be processed first.
   */
  private pendingDerivedSources(): Map<number, DerivedBodySource> {
    return projectPendingDerivedSources(this.pendingDerivedCandidates, this.derivedCandidates);
  }

  private recoveryBlocked(): boolean {
    return (
      this.derivedPoisonedEntities.size > 0 || this.syncState?.world.execution.health === 'poisoned'
    );
  }

  private validateConstraintDependencies(
    input: PhysicsConstraintInput,
    candidate?: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ): DerivedPhysicsError | undefined {
    const endpoints = [
      [input.bodyA, input.bodyASource],
      [input.bodyB, input.bodyBSource],
    ] as const;
    for (const [entity, dependency] of endpoints) {
      if (this.derivedPoisonedEntities.has(entity)) {
        return new DerivedPhysicsError(
          'derived-recovery-invalid',
          'constraint endpoints belong to a healthy PhysicsWorld state',
          'rebuild the PhysicsWorld before recreating constraints',
          { constraintId: input.id, entity },
        );
      }
      if (!this.entityMap.has(entity)) {
        return new DerivedPhysicsError(
          'derived-body-not-found',
          'both constraint endpoint entities have committed bodies',
          'reconcile both endpoint entities before creating or migrating a constraint',
          { constraintId: input.id, entity },
        );
      }
      const expected =
        candidate !== undefined && entity === candidate.entity
          ? { sourceKey: candidate.sourceKey, revision: candidate.revision }
          : (sourceOverrides?.get(entity) ?? this.sourceForEntity(entity));
      if (
        dependency.sourceKey !== expected.sourceKey ||
        dependency.revision !== expected.revision
      ) {
        return new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint endpoint sourceKey and revision match the committed endpoint',
          'refresh both endpoint dependencies and retry the complete candidate',
          {
            constraintId: input.id,
            entity,
            expected: `${expected.sourceKey}@${expected.revision}`,
            actual: `${dependency.sourceKey}@${dependency.revision}`,
          },
        );
      }
    }
    return undefined;
  }

  private constraintDependenciesMatch(
    input: PhysicsConstraintInput,
    sourceOverrides: ReadonlyMap<number, DerivedBodySource>,
  ): boolean {
    for (const [entity, dependency] of [
      [input.bodyA, input.bodyASource],
      [input.bodyB, input.bodyBSource],
    ] as const) {
      if (!this.entityMap.has(entity)) return false;
      const expected = sourceOverrides.get(entity) ?? this.sourceForEntity(entity);
      if (dependency.sourceKey !== expected.sourceKey || dependency.revision !== expected.revision)
        return false;
    }
    return true;
  }

  private validateDerivedAdmission(
    input: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ): DerivedPhysicsError | undefined {
    if (
      input.bodyType !== undefined &&
      input.bodyType !== 'static' &&
      input.bodyType !== 'dynamic' &&
      input.bodyType !== 'kinematic'
    ) {
      return new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate bodyType is one of static, dynamic, or kinematic',
        'repair the motion type before admission',
        { entity: input.entity, actual: input.bodyType },
      );
    }
    const seen = new Set<string>();
    for (const constraint of input.constraints ?? []) {
      const validation = validateConstraintInput(constraint);
      if (!validation.ok) return validation.error;
      if (seen.has(constraint.id)) {
        return new DerivedPhysicsError(
          'derived-constraint-invalid',
          'candidate contains one constraint update per identity',
          'merge duplicate updates before admission',
          { entity: input.entity, constraintId: constraint.id },
        );
      }
      seen.add(constraint.id);
      const dependencyError = this.validateConstraintDependencies(
        constraint,
        input,
        sourceOverrides,
      );
      if (dependencyError !== undefined) return dependencyError;
      const existing = this.derivedConstraints.get(constraint.id);
      if (existing !== undefined && constraint.revision <= existing.input.revision) {
        return new DerivedPhysicsError(
          'derived-constraint-stale',
          'migrated constraint revision advances the committed revision',
          'submit both endpoint dependencies and a newer constraint revision',
          {
            entity: input.entity,
            constraintId: constraint.id,
            expected: `>${existing.input.revision}`,
            actual: constraint.revision,
          },
        );
      }
    }
    return undefined;
  }

  private constraintsForBody(entity: number): readonly PhysicsConstraintInput[] {
    return [...this.derivedConstraints.values()]
      .filter(
        (constraint) => constraint.input.bodyA === entity || constraint.input.bodyB === entity,
      )
      .map((constraint) => ({ ...constraint.input }));
  }

  private installDerivedConstraint(
    input: PhysicsConstraintInput,
    updating: boolean,
  ): ReturnType<NonNullable<PhysicsWorld['createDerivedConstraint']>> {
    this.assertActive(updating ? 'updateDerivedConstraint' : 'createDerivedConstraint');
    const validation = validateConstraintInput(input);
    if (!validation.ok) return validation;
    const dependencyError = this.validateConstraintDependencies(
      input,
      undefined,
      this.pendingDerivedSources(),
    );
    if (dependencyError !== undefined) return err(dependencyError);
    const existing = this.derivedConstraints.get(input.id);
    if (existing !== undefined && !updating) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint identity is not already committed when creating it',
          'call updateDerivedConstraint with a newer revision',
          { constraintId: input.id },
        ),
      );
    }
    if (existing !== undefined && input.revision <= existing.input.revision) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint revision advances monotonically',
          'submit a newer constraint revision',
          {
            constraintId: input.id,
            actual: input.revision,
            expected: `>${existing.input.revision}`,
          },
        ),
      );
    }
    const native = this.createNativeConstraint(input);
    if (!native.ok) return native;
    if (existing !== undefined) this.removeNativeConstraint(existing.handle);
    this.derivedConstraints.set(input.id, { input: { ...input }, handle: native.value.handle });
    return ok({ id: input.id, revision: input.revision });
  }

  private removeNativeConstraint(handle: number): void {
    try {
      const joint = (this.raw as RapierWorld).getImpulseJoint(handle);
      if (joint !== null && joint !== undefined)
        (this.raw as RapierWorld).removeImpulseJoint(joint, true);
    } catch {
      // Cleanup is idempotent across backend teardown and entity removal.
    }
  }

  getKinematicControllerStates(): readonly Rapier3DKinematicControllerState[] {
    return [...this.kccOffsets]
      .sort(([first], [second]) => first - second)
      .map(([entity, offset]) => ({ entity, offset }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.assertActive('dispose');
    this.clearPairIsolation();
    this.isolationColliderOwners.clear();
    this.invalidateDerivedShapeCandidates('physics-dispose');
    this.derivedCandidates.clear();
    this.pendingDerivedCandidates.clear();
    this.derivedBodies.clear();
    this.derivedBodySources.clear();
    this.derivedPublications.clear();
    this.derivedFailures.clear();
    this.derivedConstraints.clear();
    this.derivedContacts.length = 0;
    this.derivedContactPublication = undefined;
    this.derivedPublicationPending = false;
    this.derivedPoisonedEntities.clear();
    this.derivedColliderToShape.clear();
    this.groupedContactEvents.clear();
    this.retiredDerivedBodies.length = 0;
    this.derivedCandidateBytes = 0;
    this.backendGeneration += 1;
    this.sharedGeometry?.dispose();
    this.sharedGeometry = undefined;
    this.syncState = undefined;
    this.terrainSync = undefined;
    this.terrainColliders.clear();
    this.moveContext = undefined;
    if (typeof this.raw.free === 'function') this.raw.free();
    if (typeof this.eventQueue.free === 'function') this.eventQueue.free();
    this.entityMap.clear();
    this.dirtyPairPolicies.clear();
    this.collisionPairs.clear();
    this.retiredColliderOwners.clear();
    this.pendingCollisionEvents.length = 0;
    this.collisionEventHistory.length = 0;
    this.kccCache.clear();
    this.kccOffsets.clear();
    this.disposed = true;
  }

  getBodyCount(): number {
    return this.entityMap.size;
  }

  hasBody(entity: number): boolean {
    return this.entityMap.has(entity);
  }

  /** Bind the ECS owner used by character motion and pose writeback. */
  setMoveContext(world: World, transform: Component): void {
    this.assertActive('setMoveContext');
    this.moveContext = { world, transform };
    this.bindIsolationWorld(world);
  }

  /** Release the persistent ECS readers owned by one system registration. */
  clearEcsContext(world: World): void {
    if (this.activeDerivedPreflight) this.assertActive('clearEcsContext');
    this.contactDeltaTime = 0;
    if (this.worldIdentity === world) this.clearPairIsolation();
    if (this.syncState?.world === world) this.syncState = undefined;
    if (this.terrainSync?.world === world) this.terrainSync = undefined;
    if (this.moveContext?.world === world) this.moveContext = undefined;
    if (this.worldIdentity === world) this.worldIdentity = undefined;
  }

  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3 {
    this.assertActive('moveAndSlide');
    this.contactDeltaTime = 0;
    if (this.recoveryBlocked())
      throw new DerivedPhysicsError(
        'derived-recovery-invalid',
        'KCC observes healthy physics',
        'rebuild the PhysicsWorld',
        { entity },
      );
    this.preparePairIsolation(false);
    this.nativeExecuting = true;
    try {
      return this.computeMove(entity, desiredDelta);
    } finally {
      this.nativeExecuting = false;
    }
  }

  private assertActive(operation: string): void {
    if (this.nativeExecuting)
      throw new Error(`RapierPhysicsWorld3D.${operation} cannot reenter native execution`);
    if (this.activeDerivedAdmission !== undefined) {
      throw new DerivedPhysicsError(
        'derived-candidate-pending',
        'physics queries and mutations observe only complete fixed-step states',
        'finish the paired geometry commit before querying or mutating physics',
        { entity: this.activeDerivedAdmission.input.entity, reason: operation },
      );
    }
    if (this.disposed) {
      throw new Error(`RapierPhysicsWorld3D.${operation} cannot run on a disposed instance`);
    }
  }

  /**
   * Shared moveAndSlide core (plan-strategy D-1/D-2/D-4/D-6/D-7).
   *
   * The three Fail-Fast entry checks (body / collider / kinematic) throw
   * structured PhysicsError before the World is read, so error-path tests can
   * call this without registered systems.
   */
  private computeMove(entity: number, desiredDelta: Vec3): Vec3 {
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
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
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

    const delta = { x: desiredDelta[0] ?? 0, y: desiredDelta[1] ?? 0, z: desiredDelta[2] ?? 0 };
    ctrl.computeColliderMovement(
      collider,
      delta,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Rapier Collider in filter predicate
      (other: any) =>
        this.isolationColliderOwners.get(other.handle) !== entity &&
        !this.colliderPairIsolated(collider.handle, other.handle),
    );

    // ── Step 2/3: read corrected movement + grounded ──
    const movement = ctrl.computedMovement() as { x: number; y: number; z: number };
    const grounded = ctrl.computedGrounded() as boolean;

    // ── Write back: push the kinematic body + ECS Transform + grounded ──
    const t = body.translation();
    const next = { x: t.x + movement.x, y: t.y + movement.y, z: t.z + movement.z };
    // setNextKinematicTranslation feeds the physics step pipeline; setTranslation
    // advances the body + its collider immediately so consecutive moveAndSlide
    // calls (without an intervening world.step) see the updated pose for the next
    // collision solve + grounded check. The query structures are refreshed so the
    // next computeColliderMovement reads the new position.
    body.setNextKinematicTranslation(next);
    body.setTranslation(next, true);
    // Translation-only KCC motion preserves each collider's parent-local pose.
    // Update this body's colliders directly instead of repeatedly propagating
    // the accumulating modified-body roster for every character in the frame.
    translateAttachedColliders3D(body, movement);

    const ctx = this.moveContext;
    if (ctx) {
      // D-6: writeback Result ignored — entry checks already guard liveness.
      ctx.world
        .set(entity as EntityHandle, ctx.transform, {
          pos: localPositionForWorld3D(ctx.world, entity as EntityHandle, next),
        })
        .unwrap();
      ctx.world.set(entity as EntityHandle, CharacterController, { grounded });
    }

    return vec3.create(movement.x, movement.y, movement.z);
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
    // that projection so 3D cannot drift from the shared CharacterController schema.
    return componentDefinition(CharacterController).defaults as unknown as CharacterControllerData;
  }

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

  /** Remove backend rows whose Collider disappeared from the World query. */
  pruneMissingEntities(active: ReadonlySet<number>): void {
    for (const entity of this.entityMap.keys()) {
      if (!active.has(entity)) this.removeEntity(entity);
    }
  }

  private sharedGeometry: SharedCollisionGeometry | undefined;
  private terrainSync: { readonly world: World; readonly sync: () => void } | undefined;
  private readonly terrainColliders = new Map<
    number,
    { asset: number; collider: number; body: number }
  >();

  private colliderFailure(reason: string): never {
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'a supported finite collider and a cooked static mesh collision product',
      hint: 'Repair Collider or cook meshCollision through the source producer; retry the same entity.',
      detail: { code: 'invalid-body-config', field: 'Collider', value: reason },
    });
  }

  private meshGeometry(collider: ColliderSnapshot) {
    if (this.worldIdentity === undefined || Number(collider.mesh) === 0)
      return this.colliderFailure('mesh collider requires a World and a bound mesh handle');
    return this.geometryOwner().prepare(
      Number(collider.mesh),
      collider.shape === ColliderShapeValue.trimesh ? 'trimesh' : 'convexHull',
    );
  }

  private createAuthoredCollider(
    desc: ColliderDesc,
    body: RapierRigidBody,
    collider: ColliderSnapshot,
  ): RapierCollider {
    const mesh =
      collider.shape === ColliderShapeValue.convexHull ||
      collider.shape === ColliderShapeValue.trimesh;
    try {
      const native = this.raw.createCollider(desc, body);
      if (mesh) this.geometryOwner().attach(native.handle, Number(collider.mesh));
      return native;
    } catch (cause) {
      if (mesh) this.geometryOwner().releaseUnused(Number(collider.mesh));
      throw cause;
    }
  }

  /** Prepare before changing a native body; reuse shape parameters for unchanged source/scale. */
  private authoredColliderDesc(
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot,
    bodyType: RigidBodyType,
  ): ColliderDesc {
    const RAPIER = this.rapierModule;
    const x = Math.abs(transform.scale.x),
      y = Math.abs(transform.scale.y),
      z = Math.abs(transform.scale.z);
    if (
      ![
        x,
        y,
        z,
        ...(collider.shape === ColliderShapeValue.cuboid
          ? collider.halfExtents
          : collider.shape === ColliderShapeValue.sphere
            ? [collider.radius]
            : collider.shape <= ColliderShapeValue.cone
              ? [collider.radius, collider.halfHeight]
              : []),
      ].every((v) => Number.isFinite(v) && v > 0)
    )
      return this.colliderFailure(
        'collider dimensions and world scale must be finite and positive',
      );
    let desc: ColliderDesc;
    switch (colliderShapeFromF32(collider.shape)) {
      case 'cuboid':
        desc = RAPIER.ColliderDesc.cuboid(
          collider.halfExtents[0] * x,
          collider.halfExtents[1] * y,
          collider.halfExtents[2] * z,
        );
        break;
      case 'sphere':
        desc = RAPIER.ColliderDesc.ball(collider.radius * Math.max(x, y, z));
        break;
      case 'capsule':
        desc = RAPIER.ColliderDesc.capsule(
          collider.halfHeight * y,
          collider.radius * Math.max(x, z),
        );
        break;
      case 'cylinder':
        desc = RAPIER.ColliderDesc.cylinder(
          collider.halfHeight * y,
          collider.radius * Math.max(x, z),
        );
        break;
      case 'cone':
        desc = RAPIER.ColliderDesc.cone(collider.halfHeight * y, collider.radius * Math.max(x, z));
        break;
      case 'convexHull':
      case 'trimesh': {
        if (collider.shape === ColliderShapeValue.trimesh && bodyType === 'dynamic')
          return this.colliderFailure(
            'concave trimesh is static/kinematic only; use convexHull for dynamic bodies',
          );
        desc = new RAPIER.ColliderDesc({
          type: 'shared',
          geometry: this.meshGeometry(collider).native,
          scale: { x, y, z },
        });
        break;
      }
    }
    return desc
      .setFriction(collider.friction)
      .setRestitution(collider.restitution)
      .setDensity(collider.density)
      .setCollisionGroups(collider.collisionGroups)
      .setSolverGroups(collider.solverGroups)
      .setSensor(Boolean(collider.isSensor))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
  }

  private bodyForEntity(entity: number): RapierRigidBody | undefined {
    const record = this.entityMap.get(entity);
    if (!record) return undefined;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    return ((this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null) ?? undefined;
  }

  private isCommittedFixedBody(entity: number): boolean {
    return this.bodyForEntity(entity)?.bodyType() === this.rapierModule.RigidBodyType.Fixed;
  }

  private reconcileTransformlessCompatibility(entity: number, staticByEcs: boolean): void {
    if (!staticByEcs || !this.isCommittedFixedBody(entity)) {
      this.removeEntity(entity);
      return;
    }
    // A fixed body cannot be controller-owned. Clear stale KCC state defensively
    // while retaining the already-committed body and collider receipt.
    this.removeKccController(entity);
  }

  private reconcilePhysicsEntity(
    state: PhysicsSyncState,
    entity: EntityHandle,
    previous: PhysicsSyncDescriptor | undefined,
  ): PhysicsSyncDescriptor | undefined {
    let row: PhysicsSyncQueryRow | undefined;
    for (const query of state.queries) {
      row = query.at(entity);
      if (row !== undefined) break;
    }
    if (row === undefined) {
      this.removeEntity(entity);
      return;
    }
    if (!row.has(state.transformComponent)) {
      // A lifecycle mutation cannot be applied without a pose. Keep only the
      // narrow migration case where Transform alone disappeared from an already
      // committed fixed body; never create or reshape a Transform-less row.
      if (
        state.projection.changed(entity, Collider) ||
        state.projection.changed(entity, RigidBody)
      ) {
        this.removeEntity(entity);
        return;
      }
      this.reconcileTransformlessCompatibility(entity, physicsRowIsStatic(row));
      return this.hasBody(entity) ? previous : undefined;
    }

    let descriptor = readPhysicsSyncDescriptor(row, state, previous);
    if (descriptor === undefined) {
      this.removeEntity(entity);
      return;
    }

    // Keep the accepted native scale as the tolerance baseline. A sequence of
    // small authored edits must accumulate until it changes actual geometry.
    if (
      previous !== undefined &&
      (descriptor.collider?.shape === ColliderShapeValue.convexHull ||
        descriptor.collider?.shape === ColliderShapeValue.trimesh) &&
      sameColliderScale(previous.transform.scale, descriptor.transform.scale)
    ) {
      descriptor = {
        ...descriptor,
        transform: { ...descriptor.transform, scale: previous.transform.scale },
      };
    }

    const colliderChanged =
      !samePhysicsValue(previous?.collider, descriptor.collider) ||
      // Scale changes geometry even when Rapier owns a dynamic body's pose.
      ((descriptor.collider?.shape === ColliderShapeValue.convexHull ||
        descriptor.collider?.shape === ColliderShapeValue.trimesh) &&
        !sameColliderScale(previous?.transform.scale, descriptor.transform.scale));
    if (
      this.hasBody(entity) &&
      (colliderChanged || !samePhysicsValue(previous?.rigidBody, descriptor.rigidBody))
    ) {
      // Authored properties share one native-body mutation path with derived
      // shapes, preserving motion and joint identity through ordinary edits.
      this.syncAuthoredEcsMutation(entity, descriptor);
    }
    if (!this.hasBody(entity)) {
      this.ensureBody(entity, descriptor.transform, descriptor.rigidBody, descriptor.collider);
      return descriptor;
    }

    if (
      previous?.characterControllerOffset !== descriptor.characterControllerOffset ||
      previous?.hasCharacterController !== descriptor.hasCharacterController
    ) {
      const cachedOffset = this.kccOffsets.get(entity);
      const hadCachedReceipt = this.kccCache.has(entity);
      const finalOffset = descriptor.characterControllerOffset;
      if (!descriptor.hasCharacterController) {
        this.removeKccController(entity);
      } else if (
        hadCachedReceipt &&
        (finalOffset === undefined || !Object.is(cachedOffset, finalOffset))
      ) {
        // Component removal is structural and reaches the full reconcile path.
        // A value change only rebuilds the receipt when its effective offset changed.
        this.removeKccController(entity);
        if (finalOffset !== undefined) this.ensureKcc(entity, finalOffset);
      }
    }
    if (
      samePhysicsValue(previous?.transform, descriptor.transform) &&
      !(previous?.hasCharacterController && !descriptor.hasCharacterController)
    ) {
      return descriptor;
    }

    // Translation and rotation do not change primitive geometry. Rewriting the
    // dimensions marks Rapier's shape dirty and discards retained contact work.
    const scaledCollider = samePhysicsValue(previous?.transform.scale, descriptor.transform.scale)
      ? undefined
      : descriptor.collider;
    const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
    if (bodyType === 'static') {
      this.syncAuthoredPose(entity, descriptor.transform, scaledCollider, 'static');
    } else if (bodyType === 'kinematic' && !descriptor.hasCharacterController) {
      this.syncAuthoredPose(entity, descriptor.transform, scaledCollider, 'kinematic');
    } else if (bodyType === 'dynamic') {
      this.poseWritebackEntities.add(entity);
    }
    return descriptor;
  }
  private syncAuthoredEcsMutation(entity: number, descriptor: PhysicsSyncDescriptor): void {
    const body = this.bodyForEntity(entity);
    if (body === undefined) return;
    const solverIterations = validateAdditionalSolverIterations(
      descriptor.rigidBody.additionalSolverIterations ?? 0,
    );
    const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
    const prepared =
      descriptor.collider === undefined
        ? undefined
        : this.authoredColliderDesc(descriptor.transform, descriptor.collider, bodyType);
    const RAPIER = this.rapierModule as RapierWorld;
    // The native body is shared, but authored and derived colliders have
    // distinct owners. Never address an authored collider by array position.
    const oldColliders = this.bodyColliders(body);
    const committed = this.derivedBodies.get(entity);
    if (prepared !== undefined && descriptor.collider !== undefined) {
      const collider = this.createAuthoredCollider(
        prepared.setDensity(
          committed?.massProperties?.mode === 'explicit' ? 0 : descriptor.collider.density,
        ),
        body,
        descriptor.collider,
      );
      this.syncIsolationCollider(collider, entity);
    }
    let removedAuthoredCollider = false;
    for (const collider of oldColliders) {
      if (
        !this.derivedColliderToShape.has(collider.handle) &&
        this.terrainColliders.get(entity)?.collider !== collider.handle
      ) {
        this.retiredColliderOwners.set(collider.handle, entity);
        this.isolationColliderOwners.delete(collider.handle);
        (this.raw as RapierWorld).removeCollider(collider, true);
        this.sharedGeometry?.detach(collider.handle);
        removedAuthoredCollider = true;
      }
    }
    const record = this.entityMap.get(entity);
    if (record !== undefined) record.authoredDensity = descriptor.collider?.density;
    if (descriptor.collider === undefined && removedAuthoredCollider) {
      this.retireRemovedColliderPairs(entity);
    }
    if (bodyType === 'static') {
      body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'static');
    } else if (bodyType === 'kinematic') {
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'kinematic');
    } else {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      if (record !== undefined) record.additionalMass = Math.max(0, descriptor.rigidBody.mass);
      if (committed?.massProperties?.mode !== 'explicit') {
        this.restoreAutomaticMass(body, record?.additionalMass ?? 0);
        if (record !== undefined) record.automaticAdditionalMass = record.additionalMass;
      }
      body.setGravityScale(descriptor.rigidBody.gravityScale, true);
      body.setLinearDamping(descriptor.rigidBody.linearDamping);
      body.setAngularDamping(descriptor.rigidBody.angularDamping);
    }
    body.setAdditionalSolverIterations(solverIterations);
    body.enableCcd(Boolean(descriptor.rigidBody.ccdEnabled));
    this.syncRotationLock(entity, body, Boolean(descriptor.rigidBody.lockRotation));
    if (committed?.massProperties?.mode === 'explicit') {
      this.restoreCommittedMass(body, committed, 0);
    }
  }

  private syncRotationLock(entity: number, body: RapierRigidBody, locked: boolean): void {
    const record = this.entityMap.get(entity);
    if (record === undefined) return;
    if (record.lockRotation !== locked) body.lockRotations(locked, true);
    if (locked) body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    record.lockRotation = locked;
  }

  private geometryOwner(): SharedCollisionGeometry {
    const assets = this.worldIdentity?.assets;
    if (assets === undefined)
      return this.colliderFailure('shared geometry requires a World asset owner');
    this.sharedGeometry ??= new SharedCollisionGeometry(
      assets,
      this.raw.colliders,
      this.rapierModule,
    );
    return this.sharedGeometry;
  }

  private removeTerrainCollider(entity: number): void {
    const previous = this.terrainColliders.get(entity);
    if (previous === undefined) return;
    const collider = this.raw.getCollider(previous.collider);
    if (collider !== null && collider !== undefined) this.raw.removeCollider(collider, false);
    this.sharedGeometry?.detach(previous.collider);
    this.isolationColliderOwners.delete(previous.collider);
    this.terrainColliders.delete(entity);
  }

  private syncTerrain(world: World): void {
    if (this.terrainSync?.world !== world) {
      this.terrainSync = {
        world,
        sync: createTerrainHeightfieldSync(world, {
          remove: (entity) => this.removeTerrainCollider(entity),
          replace: (entity, asset) => {
            const body = this.bodyForEntity(entity);
            if (body === undefined) return;
            const previous = this.terrainColliders.get(entity);
            if (previous?.asset === asset && previous.body === body.handle) return;
            const owner = this.geometryOwner();
            const geometry = owner.prepare(asset, 'heightfield');
            const RAPIER = this.rapierModule;
            const desc = new RAPIER.ColliderDesc({
              type: 'shared',
              geometry: geometry.native,
              scale: { x: 1, y: 1, z: 1 },
            })
              .setDensity(0)
              .setFriction(0.5)
              .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
              .setActiveHooks(
                RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS |
                  RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS,
              )
              .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
            let native: { readonly handle: number };
            try {
              native = this.raw.createCollider(desc, body);
              owner.attach(native.handle, asset);
            } catch (cause) {
              owner.releaseUnused(asset);
              throw cause;
            }
            this.removeTerrainCollider(entity);
            this.terrainColliders.set(entity, {
              asset,
              collider: native.handle,
              body: body.handle,
            });
            this.isolationColliderOwners.set(native.handle, entity);
          },
        }),
      };
    }
    this.terrainSync.sync();
  }
  /** @internal ECS system bridge; consumers should register PhysicsSyncBackend. */
  _syncFromEcs(
    world: World,
    transformComponent: Component,
    globalTransformComponent = world.components.resolve('GlobalTransform'),
  ): void {
    this.assertActive('syncFromEcs');
    this.contactDeltaTime = 0;
    this.bindIsolationWorld(world);
    this.sharedGeometry?.adopt();
    if (globalTransformComponent === undefined) {
      this.syncTerrain(world);
      return;
    }
    let state = this.syncState;
    if (
      state === undefined ||
      state.world !== world ||
      state.transformComponent !== transformComponent ||
      state.globalTransformComponent !== globalTransformComponent
    ) {
      const queryResult = world.query({
        read: [Collider],
        optional: [
          transformComponent,
          globalTransformComponent,
          RigidBody,
          CharacterController,
          ChildOf,
        ],
      });
      if (!queryResult.ok) return;
      const bodyQuery = world.query({
        read: [RigidBody],
        without: [Collider],
        optional: [transformComponent, globalTransformComponent, CharacterController, ChildOf],
      });
      if (!bodyQuery.ok) throw bodyQuery.error;
      state = {
        world,
        transformComponent,
        globalTransformComponent,
        queries: [queryResult.value, bodyQuery.value] as unknown as readonly PhysicsSyncQuery[],
        projection: createStateProjection(
          world,
          [
            transformComponent,
            globalTransformComponent,
            Collider,
            RigidBody,
            CharacterController,
            ChildOf,
            Disabled,
          ],
          [Collider, RigidBody],
        ),
        accepted: new Map(),
      };
      this.syncState = state;
    }

    const batch = state.projection.read();
    const updates: { index: number; descriptor: PhysicsSyncDescriptor | undefined }[] = [];
    for (const index of batch.indices) {
      const entity = state.projection.entity(index);
      const previous = state.accepted.get(index);
      if (previous !== undefined && previous.entity !== entity) this.removeEntity(previous.entity);
      if (entity === undefined) {
        updates.push({ index, descriptor: undefined });
        continue;
      }
      const descriptor = this.reconcilePhysicsEntity(
        state,
        entity,
        previous?.entity === entity ? previous : undefined,
      );
      updates.push({ index, descriptor });
    }
    batch.accept();
    for (const { index, descriptor } of updates) {
      if (descriptor === undefined) state.accepted.delete(index);
      else state.accepted.set(index, descriptor);
    }
    this.syncTerrain(world);
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
  // ─── ECS→Rapier bridge (D-2) ──────────────────────────────────────────

  /** Create the native body once; later author edits use the incremental sync owner. */
  ensureBody(
    entity: number,
    transform: PhysicsTransform3D,
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
      lockRotation?: boolean;
      additionalSolverIterations?: number;
    },
    collider: ColliderSnapshot | undefined,
  ): void {
    this.assertActive('ensureBody');
    const solverIterations = validateAdditionalSolverIterations(
      rigidBody.additionalSolverIterations ?? 0,
    );
    if (this.entityMap.has(entity)) return; // M1 idempotent guard (D-2)
    const RAPIER = this.rapierModule;
    // ── Create RigidBodyDesc ──
    const rbType = rigidBodyTypeFromF32(rigidBody.type);
    const prepared =
      collider === undefined ? undefined : this.authoredColliderDesc(transform, collider, rbType);
    let body: RapierRigidBody;
    switch (rbType) {
      case 'dynamic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.dynamic()
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
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
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
          .setRotation(transform.rotation);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'kinematic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased()
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
          .setRotation(transform.rotation);
        // CCD sweeps the collider along its per-step kinematic translation so a
        // fast mover (player, bullet) reliably contacts dynamics instead of
        // tunneling through them on discrete steps.
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      // No default — rigidBodyTypeFromF32 ensures only 3 arms; TS guards completeness.
    }
    body.setAdditionalSolverIterations(solverIterations);
    body.userData = entity;
    this.registerBody(
      entity,
      body.handle,
      rbType === 'dynamic' ? Math.max(0, rigidBody.mass) : 0,
      collider?.density,
    );
    this.syncRotationLock(entity, body, Boolean(rigidBody.lockRotation));
    if (prepared !== undefined && collider !== undefined) {
      try {
        const nativeCollider = this.createAuthoredCollider(prepared, body, collider);
        this.syncIsolationCollider(nativeCollider, entity);
      } catch (cause) {
        this.removeEntity(entity);
        throw cause;
      }
    }
    // Rapier defers descriptor additional mass, including when a collider is
    // already attached. Same-step impulses and derived admission must both see
    // the complete authored mass as soon as synchronization publishes the body.
    const record = this.entityMap.get(entity);
    this.restoreAutomaticMass(body, record?.additionalMass ?? 0);
    if (record !== undefined) record.automaticAdditionalMass = record.additionalMass;
  }
  /**
   * Synchronize a static or kinematic body's Rapier pose and collider shape from
   * the resolved Transform pose. Dynamic bodies own their pose after creation.
   */
  syncAuthoredPose(
    entity: number,
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot | undefined,
    bodyType: 'static' | 'kinematic',
  ): void {
    this.assertActive('syncAuthoredPose');
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) return;
    if (bodyType === 'static') {
      body.setTranslation(transform.position, true);
      body.setRotation(transform.rotation, true);
    } else {
      body.setNextKinematicTranslation(transform.position);
      body.setNextKinematicRotation(transform.rotation);
    }
    if (collider === undefined) return;
    const rapierCollider = this.bodyColliders(body).find(
      (shape) =>
        !this.derivedColliderToShape.has(shape.handle) &&
        this.terrainColliders.get(entity)?.collider !== shape.handle,
    );
    if (!rapierCollider) return;
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    const scaleZ = Math.abs(transform.scale.z);
    switch (colliderShapeFromF32(collider.shape)) {
      case 'cuboid': {
        const x = Math.fround(collider.halfExtents[0] * scaleX);
        const y = Math.fround(collider.halfExtents[1] * scaleY);
        const z = Math.fround(collider.halfExtents[2] * scaleZ);
        const current = rapierCollider.halfExtents();
        if (current?.x !== x || current.y !== y || current.z !== z)
          rapierCollider.setHalfExtents({ x, y, z });
        break;
      }
      case 'sphere': {
        const radius = Math.fround(collider.radius * Math.max(scaleX, scaleY, scaleZ));
        if (rapierCollider.radius() !== radius) rapierCollider.setRadius(radius);
        break;
      }
      case 'cone':
      case 'cylinder':
      case 'capsule': {
        const halfHeight = Math.fround(collider.halfHeight * scaleY);
        const radius = Math.fround(collider.radius * Math.max(scaleX, scaleZ));
        if (rapierCollider.halfHeight() !== halfHeight) rapierCollider.setHalfHeight(halfHeight);
        if (rapierCollider.radius() !== radius) rapierCollider.setRadius(radius);
        break;
      }
      case 'convexHull':
      case 'trimesh':
        // Source and scale changes use the same staged authored replacement above.
        break;
    }
  }
  // ─── ECS integration helpers ───────────────────────────────────────────
  /**
   * Register an ECS entity with its Rapier body handle.
   */
  registerBody(
    entity: number,
    bodyHandle: number,
    additionalMass = 0,
    authoredDensity?: number,
  ): void {
    this.contactDeltaTime = 0;
    for (const [key, pair] of this.isolatedPairs) {
      if (pair.input.entityA === entity || pair.input.entityB === entity)
        this.retireIsolatedPair(key, pair);
    }
    const oldBody = this.bodyForEntity(entity);
    if (oldBody !== undefined)
      for (const collider of this.bodyColliders(oldBody))
        this.isolationColliderOwners.delete(collider.handle);
    this.entityMap.set(entity, {
      bodyHandle,
      lockRotation: false,
      worldIdentity: this.worldIdentity,
      additionalMass: Math.max(0, additionalMass),
      // `ensureBody` registers before its authored collider is attached.
      // Rapier recomputes the body from that collider and clears the
      // descriptor-only additional mass, so the native baseline is zero.
      // A later automatic derived admission records the actual additional
      // contribution after it has been applied. Keeping this separate from
      // `additionalMass` lets rollback restore native state rather than an
      // authored value that Rapier has not applied yet.
      automaticAdditionalMass: 0,
      authoredDensity:
        authoredDensity !== undefined && Number.isFinite(authoredDensity) && authoredDensity >= 0
          ? authoredDensity
          : undefined,
    });
    if (!this.derivedBodySources.has(entity)) {
      this.derivedBodySources.set(entity, { sourceKey: `entity:${entity}`, revision: 0 });
    }
    this.poseWritebackEntities.add(entity);
    const body = this.raw.getRigidBody(bodyHandle);
    if (body !== undefined && body !== null)
      for (const collider of this.bodyColliders(body)) this.syncIsolationCollider(collider, entity);
  }

  setKinematicPosition(entity: number, pos: { x: number; y: number; z: number }): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    this.contactDeltaTime = 0;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
  }
  /**
   * Write Rapier dynamic body poses back. Cost is O(awake dynamic bodies):
   * sleeping and fixed bodies are not visited, except for the bodies tracked
   * by `poseWritebackEntities`.
   */
  writebackDynamicBodies(): Array<{
    entity: number;
    pos: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  }> {
    const results: Array<{
      entity: number;
      pos: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    }> = [];
    const pending = this.poseWritebackEntities;
    const active = this.activeWritebackEntities;
    (this.raw as RapierWorld).forEachActiveRigidBody(
      (body: { userData: unknown; handle: number }) => {
        const entity = body.userData as number;
        if (this.entityMap.get(entity)?.bodyHandle !== body.handle) return;
        active.add(entity);
        pending.add(entity);
      },
    );
    for (const entity of pending) {
      const record = this.entityMap.get(entity);
      if (record === undefined) continue;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
      if (!body) continue;
      if (body.bodyType() !== this.rapierModule.RigidBodyType.Dynamic) continue;
      const translation = body.translation();
      const rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y, z: translation.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      });
    }
    pending.clear();
    this.poseWritebackEntities = active;
    this.activeWritebackEntities = pending;
    return results;
  }

  removeEntity(entity: number): void {
    this.groupedContactEvents.removeEntity(entity);
    for (const [key, pair] of this.isolatedPairs) {
      if (pair.input.entityA === entity || pair.input.entityB === entity)
        this.retireIsolatedPair(key, pair);
    }
    const record = this.entityMap.get(entity);
    if (!record) return;
    const removedBody = this.bodyForEntity(entity);
    const removedColliders = removedBody === undefined ? [] : this.bodyColliders(removedBody);
    if (removedBody !== undefined)
      for (const collider of removedColliders) this.isolationColliderOwners.delete(collider.handle);
    for (const candidate of this.derivedCandidates.values()) {
      if (
        candidate.input.entity !== entity ||
        candidate.batch === undefined ||
        (candidate.state !== 'ready' && candidate.state !== 'queued')
      )
        continue;
      this.rejectPreparedCandidate(
        candidate,
        new DerivedPhysicsError(
          'derived-body-not-found',
          'all grouped bodies remain live until admission',
          'prepare a new complete group after entity reconciliation',
          { entity },
        ),
      );
    }
    const derived = this.derivedBodies.get(entity);
    if (derived !== undefined) {
      for (const handle of derived.shapes.flatMap(derivedShapeHandles))
        this.removeNativeCollider(handle);
      this.derivedBodies.delete(entity);
      this.derivedPublications.delete(entity);
    }
    this.derivedFailures.delete(entity);
    this.derivedPoisonedEntities.delete(entity);
    for (const [id, constraint] of this.derivedConstraints) {
      if (constraint.input.bodyA === entity || constraint.input.bodyB === entity) {
        this.removeNativeConstraint(constraint.handle);
        this.derivedConstraints.delete(id);
      }
    }
    for (const [id, candidate] of this.derivedCandidates) {
      if (candidate.input.entity !== entity) continue;
      for (const collider of candidate.nativeColliders) this.removeNativeCollider(collider.handle);
      this.pendingDerivedCandidates.delete(id);
      this.releaseDerivedCandidate(id);
    }
    const ownPairs = [...(this.collisionPairs.get(entity) ?? [])];
    for (const other of ownPairs) {
      if (this.removePair(entity, other)) {
        this.pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
      }
    }
    this.removeKccController(entity); // D-3: clear cached KCC before body removal
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
    (this.raw as any).removeRigidBody({ handle: record.bodyHandle } as RapierRigidBody);
    for (const collider of removedColliders) this.sharedGeometry?.detach(collider.handle);
    this.terrainColliders.delete(entity);
    this.entityMap.delete(entity);
    this.dirtyPairPolicies.delete(entity);
    this.derivedBodySources.delete(entity);
    // Clear the despawned entity from every overlap set so a collected Core does
    // not linger in the player's CollidingEntities (Rapier emits no `stopped`
    // event when a collider is removed mid-overlap).
    const own = this.collisionPairs.get(entity);
    if (own) {
      for (const other of own) this.collisionPairs.get(other)?.delete(entity);
      this.collisionPairs.delete(entity);
    }
  }
}

export function createRapier3DPhysicsWorld(
  rapier: Rapier3DModule,
  options: PhysicsOptions = {},
): RapierPhysicsWorld3D {
  return new RapierPhysicsWorld3D(rapier, options);
}
