import {
  type Component,
  componentDefinition,
  Disabled,
  deferFixedStep,
  Entity,
  type EntityHandle,
  FixedTime,
  Time,
  type World,
} from '@forgeax/engine-ecs';
import {
  type BodyMotion,
  CharacterController,
  type CharacterControllerData,
  type CharacterSynchronization,
  Collider,
  ColliderShapeValue,
  type ColliderSnapshot,
  cloneDerivedPhysicsInput,
  createTerrainHeightfieldSync,
  DERIVED_PHYSICS_LIMITS,
  type DerivedBodyTypeCandidateInput,
  type DerivedPhysicsAdmissionGuard,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  type DerivedPhysicsCollisionReceipt,
  DerivedPhysicsError,
  type DerivedPhysicsFailure,
  type DerivedPhysicsMotion,
  type DerivedPhysicsPublication,
  type DerivedPhysicsSnapshot,
  type DerivedPhysicsSourceTransform,
  type DerivedShapeInput,
  type DerivedShapeState,
  estimateDerivedPhysicsInputBytes,
  finitePhysicsVector,
  type ManagedJointBinding,
  type ManagedJointInput,
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  type MoveAndSlideOptions,
  type NativePhysicsStepTiming,
  PairIsolationError,
  type PairIsolationInput,
  type PairIsolationLease,
  PHYSICS_ERROR_HINTS,
  type PhysicsBodyDynamics,
  type PhysicsBodyForceInput,
  type PhysicsBodyObbQuery,
  type PhysicsBodyTorqueInput,
  type PhysicsColliderPrimitives,
  type PhysicsConstraintInput,
  type PhysicsContactNeighborsSnapshot,
  type PhysicsContactNormalFilter,
  type PhysicsContactObservation,
  type PhysicsContactSnapshot,
  PhysicsError,
  PhysicsFixedError,
  type PhysicsMassProperties,
  type PhysicsOptions,
  type PhysicsSensorOverlap,
  type PhysicsSensorOverlaps,
  type PhysicsSweepError,
  type PhysicsVector,
  type PhysicsWorld,
  PhysicsWorldResource,
  type RaycastHit,
  RigidBody,
  RigidBodyTypeValue,
  type SphereSweepHit,
  unitPhysicsQuaternion,
  validateAsyncResultsInterpolation,
  validateMassProperties,
  validateProfileNativeStepTimings,
  validateSolverIterations,
} from '@forgeax/engine-physics';
import type { ColliderDesc, Collider as RapierCollider } from '../pkg/rapier.mjs';
import {
  runComputeMove,
  runEnsureBody,
  runReconcilePhysicsEntity,
  runSyncAuthoredEcsMutation,
  runSyncAuthoredPose,
} from './authored-entity-operations.js';
import {
  type BodyActivationCommand,
  changeBodyActivation,
  readBodyConstraintCount,
} from './body-activation.js';
import { BodyMotionReadback, type BodyMotionWriteback } from './body-motion-readback.js';
import { readContactObservation } from './contact-observation.js';
import {
  captureDerivedBodyState,
  type DerivedAdmissionUndo,
  derivedBodyStateRestored,
} from './derived-admission-undo.js';
import {
  runAdmitDerivedShapeCandidateInternal,
  runAdmitDerivedShapeCandidates,
  runApplyDerivedMass,
  runCancelDerivedShapeCandidate,
  runCreateDerivedCollider,
  runCreateManagedJoints,
  runCreateNativeConstraint,
  runFailDerivedGroup,
  runGetDerivedCollisionReceipt,
  runInstallDerivedConstraint,
  runProcessDerivedCandidates,
  runRestoreCommittedMass,
  runRestoreDerivedPhysicsState,
  runStageDerivedRecord,
  runValidateConstraintDependencies,
  runValidateDerivedAdmission,
} from './derived-candidate-operations.js';
import {
  type DerivedAdmissionBatch,
  type DerivedAdmissionProjection,
  type DerivedBodyRecord,
  type DerivedBodySource,
  type DerivedCandidateRecord,
  type DerivedConstraintRecord,
  type DerivedShapeRecord,
  derivedShapeHandles,
} from './derived-candidate-records.js';
import { restoreDerivedDensities } from './derived-density.js';
import { GroupedContactEvents } from './grouped-contact-events.js';
import {
  runAdmitFixedForce,
  runAuthoredColliderDesc,
  runBodiesShareCollision,
  runDerivedRecordRejection,
  runDrainRapierCollisionEvents,
  runGetCommittedBodyDynamics,
  runGetCommittedColliderPrimitives,
  runGetSensorOverlaps,
  runIntersectsCommittedBodyObb,
  runPreparePairIsolation,
  runPublishNativeStepTiming,
  runPublishSensorOverlaps,
  runRaycast,
  runRememberSourceOwnedTypeRefusal,
  runRemoveEntity,
  runSweepSphereAll,
  runSynchronizeCharacter,
} from './native-query-operations.js';
import { SolverParticipants } from './solver-participants.js';
import { SolverWorkerDriver } from './solver-worker-driver.js';
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

import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { type Vec3, vec3 } from '@forgeax/engine-math';

import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result, type RigidBodyType, unpackSlot } from '@forgeax/engine-types';
import { writeNativeBodyMotion } from './body-motion.js';
import { localPositionForWorld3D, translateAttachedColliders3D } from './body-pose.js';
import { rapierBodyTypeToString } from './body-type.js';
import { characterMovementDeltaTime } from './character-motion.js';
import {
  currentContactOwner,
  queryContactManifolds,
  readContactNeighborSnapshot,
  readContactNeighborsBatch,
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
  readNativeDerivedMotion,
  revalidatePendingDerivedCandidates,
} from './derived-admission-preflight.js';
import { prepareDerivedBodyTypes } from './derived-body-type.js';

import { stageDerivedColliders } from './derived-collider.js';
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
  type PhysicsSyncState,
  type PhysicsTransform3D,
  samePhysicsValue,
} from './physics-sync-descriptor.js';
import { SharedCollisionGeometry } from './shared-collision-geometry.js';
import type { Rapier3DModule } from './wasm-loader.js';

const EMPTY_CONTACT_OBSERVATIONS: readonly PhysicsContactObservation[] = Object.freeze([]);

interface SourceOwnedTypeRejection {
  readonly entity: EntityHandle;
  readonly candidateId: string;
  readonly revision: number;
  readonly requestedType: number;
}

export class RapierPhysicsWorld3D implements PhysicsWorld {
  /** Rapier 3D World instance owning all bodies, colliders, and pipeline. */
  raw: RapierWorld;

  private readonly rapierModule: Rapier3DModule;
  private readonly nativeStepTimingEnabled: boolean;
  private readonly nativeStepTimingListeners = new Set<(timing: NativePhysicsStepTiming) => void>();
  private nativeStepTimingIndex = 0;

  private readonly entityMap = new Map<number, PhysicsEntityRecord>();
  private readonly dirtyPairPolicies = new Map<number, PhysicsEntityRecord>();
  private readonly isolatedPairs = new Map<string, IsolatedPair>();
  private isolationLeaseCount = 0;
  /** Native collider identity prepared by its owner; callbacks never reenter native or ECS. */
  private readonly isolationColliderOwners = new Map<number, number>();
  private nativeExecuting = false;
  private activeDerivedPreflight = false;
  private derivedCandidateInputReadDepth = 0;
  private readonly pairHooks = {
    filterContactPair: (a: number, b: number) =>
      this.colliderPairIsolated(a, b) ? null : this.rapierModule.SolverFlags.COMPUTE_IMPULSE,
    filterIntersectionPair: (a: number, b: number) => !this.colliderPairIsolated(a, b),
  };

  private readonly motionReadback = new BodyMotionReadback();

  onBodyMotionChange(listener: (entity: number) => void): () => void {
    this.assertActive('onBodyMotionChange');
    return this.motionReadback.subscribe(listener);
  }

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
  private readonly derivedCollisionReceipts = new WeakMap<
    DerivedBodyRecord,
    DerivedPhysicsCollisionReceipt
  >();
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
  private solverTimeSeconds = 0;
  private solverHostTimeAnchorSeconds = 0;
  private readonly asyncResultsInterpolation: boolean;
  private readonly solverParticipants = new SolverParticipants(
    () => !this.nativeExecuting && !this.disposed,
  );
  private solverWorker: SolverWorkerDriver | undefined;
  private solverWorkerUrl: string | undefined;
  private solverSequence = 0;
  private solverPending = false;
  private solverCompletion: Promise<void> | undefined;
  private readonly solverRetiredEntities = new Set<number>();
  private readonly solverRetiredJoints = new Set<number>();
  private readonly solverAuthoredPoseChanges = new Set<number>();
  private solverSourcePoses = new Map<number, string>();
  private bodyGeneration = 0;
  private colliderGeneration = 0;
  private readonly sensorColliderIdentities = new Map<number, PhysicsSensorOverlap>();
  private readonly completedSensorRosters = new Map<number, PhysicsSensorOverlaps>();
  private readonly forceAccumulatorBodies = new Set<number>();
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
    this.nativeStepTimingEnabled = validateProfileNativeStepTimings(
      options.profileNativeStepTimings,
    );
    this.asyncResultsInterpolation = validateAsyncResultsInterpolation(
      options.asyncResultsInterpolation,
    );
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81, z: 0 }) as RapierWorld;
    this.raw.integrationParameters.numSolverIterations = solverIterations;
    this.raw.profilerEnabled = false;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81, z: 0 };
  }

  observeNativeStepTiming(listener: (timing: NativePhysicsStepTiming) => void): () => void {
    if (this.disposed || !this.nativeStepTimingEnabled) return () => {};
    const wasEmpty = this.nativeStepTimingListeners.size === 0;
    this.nativeStepTimingListeners.add(listener);
    if (wasEmpty && this.nativeStepTimingListeners.size > 0) this.raw.profilerEnabled = true;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.nativeStepTimingListeners.delete(listener);
      if (this.nativeStepTimingListeners.size === 0 && !this.disposed)
        this.raw.profilerEnabled = false;
    };
  }

  private publishNativeStepTiming(deltaSeconds: number, nativeStepIndex: number): void {
    runPublishNativeStepTiming(
      this.nativeStepTimingEnabled,
      this.nativeStepTimingListeners,
      () => this.raw,
      () => this.syncState,
      () => this.fixedStep,
      deltaSeconds,
      nativeStepIndex,
    );
  }

  // ─── PhysicsWorld interface ────────────────────────────────────────────

  getSolverClock(): import('@forgeax/engine-physics').PhysicsSolverClock {
    const world = this.syncState?.world;
    const fixed = world?.getResource(FixedTime);
    const externalTimeSeconds =
      this.solverTimeSeconds +
      (world && fixed
        ? Math.max(
            0,
            Math.min(
              fixed.delta,
              world.getResource(Time).elapsed - this.solverHostTimeAnchorSeconds,
            ),
          )
        : 0);
    const interpolationDelaySteps =
      this.solverParticipants.hasWorker && this.asyncResultsInterpolation ? 2 : 0;
    return Object.freeze({
      completedStep: this.fixedStep,
      simulationTimeSeconds: this.solverTimeSeconds,
      externalTimeSeconds,
      resultsTimeSeconds:
        externalTimeSeconds - interpolationDelaySteps * (fixed?.delta ?? this.raw.timestep),
      interpolationDelaySteps,
    });
  }

  private completeSolverTime(timestampSeconds: number, deltaSeconds: number): void {
    this.solverTimeSeconds = timestampSeconds + deltaSeconds;
    const world = this.syncState?.world;
    if (world) {
      const fixed = world.getResource(FixedTime);
      // The end-of-step clock carries only fractional host time, never whole pending debt.
      this.solverHostTimeAnchorSeconds =
        world.getResource(Time).elapsed - Math.max(0, fixed.overstep % fixed.delta);
    }
  }

  createSolverParticipant(
    input: import('@forgeax/engine-physics').PhysicsSolverParticipantInput,
  ): Result<import('@forgeax/engine-physics').PhysicsSolverParticipant, PhysicsFixedError> {
    if (
      !this.fixedOperationAvailable() ||
      (input.workerUrl === undefined) === (input.preSimulate === undefined) ||
      (input.workerUrl !== undefined &&
        (typeof Worker === 'undefined' ||
          !this.syncState ||
          this.syncState.world.getResource(FixedTime).catchUp !== 'substeps')) ||
      (this.solverWorkerUrl !== undefined && this.solverWorkerUrl !== input.workerUrl)
    )
      return this.fixedFailure(
        0,
        'fixed-operation-unavailable',
        'choose one solver processor and a module Worker with an attached substep World',
      );
    const created = this.solverParticipants.create(input);
    if (created.ok && input.workerUrl !== undefined && this.solverWorker === undefined) {
      this.solverWorker = new SolverWorkerDriver(input.workerUrl);
      this.solverWorkerUrl = input.workerUrl;
    }
    return created;
  }

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
    runPreparePairIsolation(
      () => this.worldIdentity,
      this.isolatedPairs,
      () => this.backendGeneration,
      this.entityMap,
      (key, pair) => this.retireIsolatedPair(key, pair),
      this.dirtyPairPolicies,
      () => this.raw,
      (body) => this.bodyColliders(body),
      (collider, entity) => this.syncIsolationCollider(collider, entity),
      refreshContacts,
    );
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
    return runRaycast(
      (operation) => this.assertCommittedReadable(operation),
      () => this.recoveryBlocked(),
      this.rapierModule,
      () => this.raw,
      origin,
      direction,
      maxDist,
      filterMask,
    );
  }

  sweepSphereAll(
    startM: Vec3,
    endM: Vec3,
    radiusM: number,
    filterMask?: number,
  ): Result<readonly SphereSweepHit[], PhysicsSweepError> {
    return runSweepSphereAll(
      () => this.disposed,
      () => this.recoveryBlocked(),
      () => this.nativeExecuting,
      () => this.solverPending,
      () => this.activeDerivedAdmission,
      this.rapierModule,
      () => this.raw,
      startM,
      endM,
      radiusM,
      filterMask,
    );
  }

  teleport(entity: number, position: Vec3): void {
    this.assertActive('teleport');
    const body = this.bodyForEntity(entity);
    const record = this.entityMap.get(entity);
    if (!body || record === undefined) {
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
    if (this.derivedBodies.get(entity)?.sourceTransform !== undefined) {
      throw new PhysicsError({
        code: 'invalid-body-config',
        expected: 'a source-owned body pose remains controlled by its accepted Scene matrix',
        hint: 'retire or replace the accepted source-owned geometry before transferring pose ownership',
        detail: {
          code: 'invalid-body-config',
          field: 'sourceTransform',
          value: { entity, operation: 'teleport' },
        },
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
    record.motionDiscontinuity++;
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
    this.motionReadback.enroll(entity, true);
    this.motionReadback.notify(entity);
  }

  synchronizeCharacter(entity: number, character: CharacterSynchronization): void {
    runSynchronizeCharacter(
      (operation) => this.assertActive(operation),
      (entity) => this.bodyForEntity(entity),
      () => this.syncState,
      this.rapierModule,
      (state, entity, previous, sourceOwnedTypeRejections) =>
        this.reconcilePhysicsEntity(state, entity, previous, sourceOwnedTypeRejections),
      this.derivedBodies,
      (entity, committed, requestedType, normalizationFailure) =>
        this.rememberSourceOwnedTypeRefusal(entity, committed, requestedType, normalizationFailure),
      (entity, position) => this.teleport(entity, position),
      entity,
      character,
    );
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
      const disposeUnusedSolverWorker = () => {
        if (this.solverWorker !== undefined && !this.solverParticipants.hasWorker) {
          this.solverWorker.dispose();
          this.solverWorker = undefined;
          this.solverWorkerUrl = undefined;
        }
      };
      disposeUnusedSolverWorker();
      if (this.solverWorker !== undefined && this.syncState !== undefined) {
        this.preparePairIsolation(true);
        const solveStep = this.syncState.world.getResource(FixedTime).tick;
        const timestampSeconds = this.solverTimeSeconds;
        const request: import('./solver-worker.js').RapierSolverWorkerRequest = {
          kind: 'step',
          sequence: ++this.solverSequence,
          snapshot: this.raw.takeSnapshot(),
          deltaSeconds: deltaTime,
          sourceStep: this.fixedStep,
          solveStep,
          timestampSeconds,
          bodies: [...this.entityMap].map(([entity, record]) => ({
            entity,
            generation: record.generation,
            handle: record.bodyHandle,
          })),
          tasks: this.solverParticipants.takeWorkerTasks(solveStep),
          isolatedBodyPairs: [...this.isolatedPairs.values()].map(
            (pair) => [pair.bodyA.bodyHandle, pair.bodyB.bodyHandle] as const,
          ),
        };
        this.nativeExecuting = true;
        this.solverPending = true;
        this.solverSourcePoses = new Map(
          [...this.entityMap.keys()].map((entity) => [entity, this.solverSourcePose(entity)]),
        );
        const oldWorld = this.raw;
        const completion = this.solverWorker
          .step(request)
          .then((response) => {
            if (this.disposed) return;
            const replacement = this.rapierModule.World.restoreSnapshot(response.snapshot);
            for (const [entity, record] of this.entityMap) {
              const body = replacement.getRigidBody(record.bodyHandle);
              if (!body) {
                replacement.free();
                throw new Error('Solver snapshot lost a registered body');
              }
              body.userData = entity;
              if (this.solverSourcePoses.get(entity) !== this.solverSourcePose(entity))
                this.solverAuthoredPoseChanges.add(entity);
            }
            for (const controller of this.kccCache.values())
              oldWorld.removeCharacterController(controller);
            this.kccCache.clear();
            this.kccOffsets.clear();
            this.raw = replacement;
            this.sharedGeometry?.rebindNative(replacement.colliders);
            oldWorld.free();
            this.fixedStep = solveStep;
            this.completeSolverTime(timestampSeconds, deltaTime);
            this.forceAccumulatorBodies.clear();
            this.nativeExecuting = false;
            this.solverPending = false;
            for (const entity of this.entityMap.keys())
              if (!this.syncState?.world.get(entity as EntityHandle, Entity).ok)
                this.solverRetiredEntities.add(entity);
            for (const entity of this.solverRetiredEntities) this.removeEntity(entity);
            this.solverRetiredEntities.clear();
            for (const handle of this.solverRetiredJoints) this.removeNativeConstraint(handle);
            this.solverRetiredJoints.clear();
            this.drainRapierCollisionEvents(response.collisions);
            this.solverParticipants.acknowledgeWorker(response.outputs);
            this.derivedPublicationPending = true;
          })
          .catch((cause: unknown) => {
            if (this.disposed) return;
            this.nativeExecuting = false;
            this.solverPending = false;
            for (const entity of this.entityMap.keys()) this.derivedPoisonedEntities.add(entity);
            throw cause;
          });
        this.solverCompletion = completion;
        deferFixedStep(this.syncState.world, completion);
        return;
      }
      this.solverParticipants.preSimulate({
        solveStep: this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1,
        deltaSeconds: deltaTime,
        timestampSeconds: this.solverTimeSeconds,
        getBodyDynamics: this.getCommittedBodyDynamics.bind(this),
        applyForceAtPoint: this.applyBodyForceAtPoint.bind(this),
        applyTorque: this.applyBodyTorque.bind(this),
        raycast: this.raycast.bind(this),
        traceTerrainDown: () => undefined,
      });
      this.nativeExecuting = true;
      this.preparePairIsolation(true);
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
      (this.raw as any).step(
        this.eventQueue,
        this.isolatedPairs.size === 0 ? undefined : this.pairHooks,
      );
      this.publishNativeStepTiming(deltaTime, ++this.nativeStepTimingIndex);
      this.nativeExecuting = false;
      this.fixedStep = this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1;
      this.completeSolverTime(this.solverTimeSeconds, deltaTime);
      // Rapier user forces persist until explicitly reset. All admitted forces
      // share this native accumulator and must expire even on a dry next step.
      for (const entity of this.forceAccumulatorBodies) {
        const body = this.bodyForEntity(entity);
        body?.resetForces(false);
        body?.resetTorques(false);
      }
      this.forceAccumulatorBodies.clear();
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
      if (!this.solverPending) this.nativeExecuting = false;
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
    this.publishSensorOverlaps();
    this.solverParticipants.complete(this.fixedStep);
  }

  private fixedFailure(
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    } = {},
  ) {
    return err(new PhysicsFixedError(code, { entity, reason, ...extra }));
  }

  private fixedOperationAvailable(access: 'read' | 'write' = 'write'): boolean {
    return !(
      this.disposed ||
      this.recoveryBlocked() ||
      (this.nativeExecuting && (access === 'write' || !this.solverPending)) ||
      this.activeDerivedPreflight ||
      this.activeDerivedAdmission !== undefined ||
      this.derivedPublicationPending
    );
  }

  private awaitingNativeBodySynchronization(entity: number): boolean {
    const state = this.syncState;
    const authored = entity as EntityHandle;
    if (state === undefined) {
      const context = this.moveContext;
      return (
        context !== undefined &&
        context.world.hasComponent(authored, RigidBody) &&
        context.world.hasComponent(authored, context.transform) &&
        !context.world.hasComponent(authored, Disabled)
      );
    }
    return (
      state.accepted.get(unpackSlot(authored))?.entity !== authored &&
      state.world.hasComponent(authored, RigidBody) &&
      state.world.hasComponent(authored, state.transformComponent) &&
      !state.world.hasComponent(authored, Disabled) &&
      state.projection.changed(authored, RigidBody)
    );
  }

  getCommittedBodyDynamics(entity: number): Result<PhysicsBodyDynamics, PhysicsFixedError> {
    return runGetCommittedBodyDynamics(
      (access) => this.fixedOperationAvailable(access),
      (entity, code, reason, extra) => this.fixedFailure(entity, code, reason, extra),
      this.entityMap,
      (entity) => this.bodyForEntity(entity),
      this.solverRetiredEntities,
      (entity) => this.awaitingNativeBodySynchronization(entity),
      () => this.fixedStep,
      () => this.syncState,
      entity,
    );
  }

  getCommittedColliderPrimitives(
    entity: number,
    filterMask = 0xffffffff,
  ): Result<PhysicsColliderPrimitives, PhysicsFixedError> {
    return runGetCommittedColliderPrimitives(
      (entity) => this.getCommittedBodyDynamics(entity),
      (entity, code, reason, extra) => this.fixedFailure(entity, code, reason, extra),
      (entity) => this.bodyForEntity(entity),
      this.entityMap,
      (entity, body) => this.acceptedBodyColliders(entity, body),
      this.rapierModule,
      (collider) => this.sensorIdentity(collider),
      entity,
      filterMask,
    );
  }

  private acceptedBodyColliders(entity: number, body: RapierRigidBody): RapierCollider[] {
    const shapes = this.derivedBodies.get(entity)?.shapes;
    return this.bodyColliders(body).filter(
      (collider) =>
        !this.derivedColliderToShape.has(collider.handle) ||
        shapes?.some((shape) => derivedShapeHandles(shape).includes(collider.handle)),
    ) as RapierCollider[];
  }

  intersectsCommittedBodyObb(input: PhysicsBodyObbQuery): Result<boolean, PhysicsFixedError> {
    return runIntersectsCommittedBodyObb(
      (entity) => this.getCommittedBodyDynamics(entity),
      (entity, code, reason, extra) => this.fixedFailure(entity, code, reason, extra),
      this.entityMap,
      (entity) => this.bodyForEntity(entity),
      this.rapierModule,
      (entity, body) => this.acceptedBodyColliders(entity, body),
      input,
    );
  }

  private admitFixedForce(input: {
    entity: number;
    generation: number;
    fixedStep: number;
  }): Result<RapierRigidBody, PhysicsFixedError> {
    return runAdmitFixedForce(
      (access) => this.fixedOperationAvailable(access),
      (entity, code, reason, extra) => this.fixedFailure(entity, code, reason, extra),
      this.entityMap,
      (entity) => this.bodyForEntity(entity),
      () => this.syncState,
      () => this.fixedStep,
      input,
    );
  }

  applyBodyForceAtPoint(input: PhysicsBodyForceInput): Result<void, PhysicsFixedError> {
    if (!finitePhysicsVector(input.forceN, 3) || !finitePhysicsVector(input.pointM, 3))
      return this.fixedFailure(
        input.entity,
        'fixed-input-invalid',
        'force and application point must be finite three-component SI vectors',
      );
    const admitted = this.admitFixedForce(input);
    if (!admitted.ok) return admitted;
    try {
      admitted.value.addForceAtPoint(
        { x: input.forceN[0], y: input.forceN[1], z: input.forceN[2] },
        { x: input.pointM[0], y: input.pointM[1], z: input.pointM[2] },
        true,
      );
      this.forceAccumulatorBodies.add(input.entity);
      return ok(undefined);
    } catch (cause) {
      this.derivedPoisonedEntities.add(input.entity);
      return this.fixedFailure(input.entity, 'fixed-backend-failed', String(cause), {
        recovery: 'rebuild-required',
      });
    }
  }

  applyBodyTorque(input: PhysicsBodyTorqueInput): Result<void, PhysicsFixedError> {
    if (!finitePhysicsVector(input.torqueNm, 3))
      return this.fixedFailure(
        input.entity,
        'fixed-input-invalid',
        'torque must be a finite SI vector',
      );
    const admitted = this.admitFixedForce(input);
    if (!admitted.ok) return admitted;
    try {
      admitted.value.addTorque(
        { x: input.torqueNm[0], y: input.torqueNm[1], z: input.torqueNm[2] },
        true,
      );
      this.forceAccumulatorBodies.add(input.entity);
      return ok(undefined);
    } catch (cause) {
      this.derivedPoisonedEntities.add(input.entity);
      return this.fixedFailure(input.entity, 'fixed-backend-failed', String(cause), {
        recovery: 'rebuild-required',
      });
    }
  }

  private sensorIdentity(collider: RapierWorld): PhysicsSensorOverlap | undefined {
    const entity = this.colliderHandleToEntity(collider.handle),
      record = entity === undefined ? undefined : this.entityMap.get(entity);
    if (entity === undefined || !record || !collider.isEnabled()) return undefined;
    let identity = this.sensorColliderIdentities.get(collider.handle);
    if (
      !identity ||
      identity.bodyGeneration !== record.generation ||
      identity.collisionGroups !== collider.collisionGroups() >>> 0
    ) {
      const generation = ++this.colliderGeneration;
      identity = Object.freeze({
        colliderId: `collider:${generation}`,
        entity,
        generation,
        bodyGeneration: record.generation,
        collisionGroups: collider.collisionGroups() >>> 0,
      });
      this.sensorColliderIdentities.set(collider.handle, identity);
    }
    return identity;
  }

  private publishSensorOverlaps(): void {
    runPublishSensorOverlaps(
      () => this.raw,
      (collider) => this.sensorIdentity(collider),
      this.sensorColliderIdentities,
      this.entityMap,
      (entity) => this.bodyForEntity(entity),
      (body) => this.bodyColliders(body),
      this.completedSensorRosters,
      () => this.fixedStep,
    );
  }

  getSensorOverlaps(
    rootEntity: number,
    filterMask = 0xffffffff,
  ): Result<PhysicsSensorOverlaps, PhysicsFixedError> {
    return runGetSensorOverlaps(
      (access) => this.fixedOperationAvailable(access),
      (entity, code, reason, extra) => this.fixedFailure(entity, code, reason, extra),
      this.entityMap,
      this.completedSensorRosters,
      this.sensorColliderIdentities,
      rootEntity,
      filterMask,
    );
  }

  /**
   * Drain the Rapier event queue into `collisionPairs`. Each event names two
   * collider handles + a `started` flag; we resolve each collider to its owning
   * entity (collider.parent() -> body.userData) and add/remove the symmetric
   * pair. This is what populates `CollidingEntities` for sensor pickup + contact
   * queries (the queue is otherwise drained-on-overflow and never observed).
   */
  private drainRapierCollisionEvents(
    workerEvents?: readonly (readonly [number, number, boolean])[],
  ): void {
    runDrainRapierCollisionEvents(
      (colliderHandle) => this.colliderHandleToEntity(colliderHandle),
      this.derivedColliderToShape,
      this.groupedContactEvents,
      (observation, handleA, handleB) =>
        this.recordContactObservation(observation, handleA, handleB),
      () => this.fixedStep,
      (a, b) => this.addPair(a, b),
      this.collisionPairs,
      (entityA, entityB) => this.bodiesShareCollision(entityA, entityB),
      (a, b) => this.removePair(a, b),
      (event) => this.pushCollisionEvent(event),
      () => this.eventQueue,
      this.retiredColliderOwners,
      workerEvents,
    );
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
    return runBodiesShareCollision(
      (entity) => this.bodyForEntity(entity),
      () => this.raw,
      (body) => this.bodyColliders(body),
      (colliderHandle) => this.colliderHandleToEntity(colliderHandle),
      entityA,
      entityB,
    );
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
    return readContactNeighborSnapshot(
      this.currentContactStepAvailable(),
      entity,
      () => this.bodyForEntity(entity),
      this.raw,
      this.currentContactOwner,
      this.fixedStep,
      this.contactDeltaTime,
      filterMask,
      normalFilter,
    );
  }

  getCurrentContactNeighborsBatch(
    requests: Parameters<NonNullable<PhysicsWorld['getCurrentContactNeighborsBatch']>>[0],
  ): Result<readonly PhysicsContactNeighborsSnapshot[], ManagedPhysicsFailure> {
    return readContactNeighborsBatch(
      requests,
      this.raw,
      this.currentContactOwner,
      (entity) => this.bodyForEntity(entity),
      () => this.currentContactStepAvailable(),
      this.fixedStep,
      this.contactDeltaTime,
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
    const result = changeBodyActivation(
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
    if (result.ok) this.motionReadback.notify(entity);
    return result;
  }
  /** Prepare disabled native shapes for one entity without changing queries. */
  prepareDerivedShapeCandidate(
    input: DerivedPhysicsCandidateInput,
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>> {
    const pending = this.pendingDerivedMutation('prepareDerivedShapeCandidate');
    if (pending) return err(pending);
    this.assertActive('prepareDerivedShapeCandidate');
    return this.prepareDerivedShapeCandidateInternal(input);
  }

  /** Prepare one indivisible roster using the existing disabled-native owner. */
  prepareDerivedShapeCandidates(
    inputs: readonly DerivedPhysicsCandidateInput[],
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidates']>> {
    const pending = this.pendingDerivedMutation('prepareDerivedShapeCandidates');
    if (pending) return err(pending);
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
    const pending = this.pendingDerivedMutation('prepareDerivedBodyTypeCandidates');
    if (pending) return err(pending);
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
    const refuseExistingBodyCandidate = () => {
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
        const refusePendingBodyCandidate = () => {
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
          return undefined;
        };
        const pendingCandidateFailure = refusePendingBodyCandidate();
        if (pendingCandidateFailure !== undefined) return pendingCandidateFailure;
      }
      return undefined;
    };
    const existingBodyFailure = refuseExistingBodyCandidate();
    if (existingBodyFailure !== undefined) return existingBodyFailure;
    this.derivedCandidateInputReadDepth++;
    let copied: ReturnType<typeof cloneDerivedPhysicsInput>;
    try {
      copied = cloneDerivedPhysicsInput(input);
    } finally {
      this.derivedCandidateInputReadDepth--;
    }
    if (!copied.ok) return copied;
    const activeSource = this.derivedBodies.get(copied.value.entity);
    if (
      activeSource?.sourceTransform !== undefined &&
      copied.value.sourceTransform === undefined &&
      (copied.value.shapes.length > 0 ||
        (copied.value.bodyType !== undefined && copied.value.bodyType !== 'static'))
    )
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'a source-owned body remains source-owned or is explicitly retired before pose transfer',
          'publish a complete replacement with a valid source transform, or retire the accepted source',
          {
            entity: copied.value.entity,
            actual: { sourceKey: activeSource.sourceKey, revision: copied.value.revision },
          },
        ),
      );
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
    const refusePreparationCapacity = () => {
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
      return undefined;
    };
    const capacityFailure = refusePreparationCapacity();
    if (capacityFailure !== undefined) return capacityFailure;
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
      const oldBody = this.derivedBodies.get(input.entity);
      const geometryOwner =
        oldBody !== undefined &&
        samePhysicsValue(oldBody.sourceTransform, privateInput.sourceTransform)
          ? oldBody
          : undefined;
      staged = stageDerivedColliders(
        privateInput.shapes,
        geometryOwner,
        (shape, previous) =>
          this.createDerivedCollider(
            body,
            shape,
            previous,
            privateInput.bodyType === 'dynamic' && privateInput.massProperties?.mode === 'explicit',
            privateInput.sourceTransform,
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
    let record: DerivedCandidateRecord;
    const token: DerivedPhysicsCandidate = Object.freeze({
      candidateId,
      generation: this.backendGeneration,
      owner: this.physicsOwner,
      input: tokenInput,
      get state() {
        return record.state;
      },
    });
    record = {
      token,
      ...staged,
      input: privateInput,
      bytes: candidateBytes,
      state: 'ready',
      ...(batch === undefined ? {} : { batch }),
    };
    this.derivedCandidates.set(candidateId, record);
    this.derivedCandidateBytes += candidateBytes;
    return ok(token);
  }

  /** Queue a prepared candidate for the next call to `step()`. */
  admitDerivedShapeCandidate(
    candidate: DerivedPhysicsCandidate,
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
    const pending = this.pendingDerivedMutation('admitDerivedShapeCandidate');
    if (pending) return err(pending);
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
    const pending = this.pendingDerivedMutation('admitDerivedShapeCandidateGroups');
    if (pending) return err(pending);
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
    return runAdmitDerivedShapeCandidates(
      (operation) => this.pendingDerivedMutation(operation),
      (operation) => this.assertActive(operation),
      this.derivedCandidates,
      this.physicsOwner,
      () => this.backendGeneration,
      () => this.pendingDerivedSources(),
      (candidate, projection, validateOnly) =>
        this.admitDerivedShapeCandidateInternal(candidate, projection, validateOnly),
      (record, error) => this.rejectPreparedCandidate(record, error),
      (admitted) => this.revalidatePendingDerivedCandidates(admitted),
      candidates,
      commitGeometry,
      unionOfGroups,
    );
  }

  admitDerivedShapeCandidatesGuarded(
    candidates: readonly DerivedPhysicsCandidate[],
    guard: DerivedPhysicsAdmissionGuard,
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidatesGuarded']>> {
    const pending = this.pendingDerivedMutation('admitDerivedShapeCandidatesGuarded');
    if (pending) return err(pending);
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
    return runAdmitDerivedShapeCandidateInternal(
      (operation) => this.assertActive(operation),
      this.derivedCandidates,
      this.physicsOwner,
      () => this.backendGeneration,
      this.derivedPoisonedEntities,
      () => this.pendingDerivedSources(),
      (input, sourceOverrides) => this.validateDerivedAdmission(input, sourceOverrides),
      (record, error) => this.rejectPreparedCandidate(record, error),
      this.derivedBodies,
      this.pendingDerivedCandidates,
      (admitted) => this.revalidatePendingDerivedCandidates(admitted),
      candidate,
      projection,
      validateOnly,
    );
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
    return runCancelDerivedShapeCandidate(
      (operation) => this.pendingDerivedMutation(operation),
      (operation) => this.assertActive(operation),
      this.derivedCandidates,
      this.physicsOwner,
      this.derivedBodies,
      this.pendingDerivedCandidates,
      (handle) => this.removeNativeCollider(handle),
      (candidateId) => this.releaseDerivedCandidate(candidateId),
      candidate,
    );
  }

  /** Reject all in-flight derived work while preserving the last publication. */
  invalidateDerivedShapeCandidates(reason = 'consumer-invalidated'): void {
    if (this.derivedCandidateInputReadDepth > 0 && this.nativeExecuting) {
      if (this.solverPending || this.activeDerivedAdmission !== undefined || this.disposed)
        this.assertActive('invalidateDerivedShapeCandidates');
    } else this.assertActive('invalidateDerivedShapeCandidates');
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
    this.assertCommittedReadable('getTerrainAssetVersion');
    if (this.recoveryBlocked()) return undefined;
    const binding = this.terrainColliders.get(entity);
    const version = binding === undefined ? undefined : this.sharedGeometry?.version(binding.asset);
    return binding === undefined || version === undefined
      ? undefined
      : { asset: binding.asset, version };
  }

  getDerivedPublication(entity: number): DerivedPhysicsPublication | undefined {
    this.assertCommittedReadable('getDerivedPublication');
    if (this.recoveryBlocked()) return undefined;
    return this.derivedPublications.get(entity);
  }

  async retireDerivedSource(
    credential: DerivedPhysicsPublication | DerivedPhysicsCandidate,
  ): Promise<Result<void, DerivedPhysicsError>> {
    const readRetiringSourceCredential = () => {
      const candidate =
        'owner' in credential ? this.derivedCandidates.get(credential.candidateId) : undefined;
      const entity = 'owner' in credential ? credential.input.entity : credential.entity;
      const publication = this.derivedPublications.get(entity);
      const body = this.derivedBodies.get(entity);
      const record = this.entityMap.get(entity);
      return { candidate, entity, publication, body, record };
    };
    const { candidate, entity, publication, body, record } = readRetiringSourceCredential();
    const stale = () =>
      err(
        new DerivedPhysicsError(
          'derived-candidate-stale',
          'an exact current backend-owned source credential',
          'read the current publication or retain its admitted candidate before retirement',
          { entity, candidateId: credential.candidateId },
        ),
      );
    if (
      this.disposed ||
      !record ||
      credential.generation !== this.backendGeneration ||
      ('owner' in credential
        ? credential.owner !== this.physicsOwner ||
          candidate?.token !== credential ||
          (candidate.state !== 'ready' && candidate.state !== 'queued')
        : publication !== credential || body?.candidateId !== credential.candidateId)
    )
      return stale();

    if (candidate === undefined && body === undefined) return stale();
    const sourceKey = candidate?.input.sourceKey ?? body?.sourceKey;
    if (sourceKey === undefined) return stale();
    const expectedBody = body?.candidateId === credential.candidateId ? body : undefined;
    try {
      while (this.solverPending) await this.solverCompletion;
    } catch (cause) {
      if (this.disposed) return ok(undefined);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'the source native reader acknowledges retirement',
          'dispose or rebuild the failed PhysicsWorld before releasing its native lifetime',
          { entity, reason: String(cause) },
          { cause },
        ),
      );
    }
    if (this.disposed) return ok(undefined);
    const current = this.derivedBodies.get(entity);
    const validateRetiringSourceCredential = () => {
      if (
        this.entityMap.get(entity) !== record ||
        (expectedBody === undefined
          ? this.derivedCandidates.get(credential.candidateId) !== candidate ||
            (current !== body && current?.candidateId !== credential.candidateId)
          : current !== expectedBody || current.sourceKey !== sourceKey) ||
        (!('owner' in credential) && this.derivedPublications.get(entity) !== credential)
      )
        return stale();
      return undefined;
    };
    const credentialFailure = validateRetiringSourceCredential();
    if (credentialFailure !== undefined) return credentialFailure;
    const completeRetiringSource = () => {
      const busy = this.pendingDerivedMutation('retireDerivedSource');
      if (busy) return err(busy);
      try {
        this.assertActive('retireDerivedSource');
        const cancelRetiringSourceCandidates = () => {
          for (const pending of [...this.derivedCandidates.values()]) {
            if (
              pending.input.entity !== entity ||
              pending.input.sourceKey !== sourceKey ||
              pending.token.candidateId === current?.candidateId
            )
              continue;
            const cancelled = this.cancelDerivedShapeCandidate(pending.token);
            if (!cancelled.ok) return cancelled;
          }
          return undefined;
        };
        const cancellation = cancelRetiringSourceCandidates();
        if (cancellation !== undefined) return cancellation;
        if (current?.candidateId !== credential.candidateId) {
          if (candidate && this.derivedCandidates.get(candidate.token.candidateId) === candidate)
            return this.cancelDerivedShapeCandidate(candidate.token);
          return ok(undefined);
        }
        const retired = this.retiredDerivedBodies.filter(
          (previous) => previous.entity === entity && previous.sourceKey === sourceKey,
        );
        const shapeIds = new Set(
          [current, ...retired].flatMap((owned) => owned.shapes.map((shape) => shape.input.id)),
        );
        const retireOwnedSourceShapes = () => {
          for (const owned of [current, ...retired]) {
            for (const handle of owned.shapes.flatMap(derivedShapeHandles)) {
              this.removeNativeCollider(handle);
              if (this.raw.colliders.contains(handle))
                throw new Error('Native collider retirement failed');
            }
            this.pendingDerivedCandidates.delete(owned.candidateId);
            this.releaseDerivedCandidate(owned.candidateId);
            const index = this.retiredDerivedBodies.indexOf(owned);
            if (index >= 0) this.retiredDerivedBodies.splice(index, 1);
          }
        };
        retireOwnedSourceShapes();
        const retireOwnedSourceConstraints = () => {
          for (const [id, constraint] of this.derivedConstraints) {
            const input = constraint.input;
            if (
              (input.bodyA === entity && input.bodyASource.sourceKey === sourceKey) ||
              (input.bodyB === entity && input.bodyBSource.sourceKey === sourceKey)
            ) {
              this.removeNativeConstraint(constraint.handle);
              if (this.raw.getImpulseJoint(constraint.handle))
                throw new Error('Native constraint retirement failed');
              this.derivedConstraints.delete(id);
            }
          }
        };
        retireOwnedSourceConstraints();
        const retireOwnedSourceContacts = () => {
          for (let index = this.derivedContacts.length - 1; index >= 0; index--) {
            const contact = this.derivedContacts[index];
            if (contact === undefined) throw new Error('Derived contact roster invariant failed');
            if (
              (contact.entityA === entity &&
                contact.shapeA !== undefined &&
                shapeIds.has(contact.shapeA)) ||
              (contact.entityB === entity &&
                contact.shapeB !== undefined &&
                shapeIds.has(contact.shapeB))
            )
              this.derivedContacts.splice(index, 1);
          }
        };
        retireOwnedSourceContacts();
        this.derivedContactPublication = undefined;
        this.groupedContactEvents.removeShapes(entity, shapeIds);
        const retireOwnedSourceEvents = () => {
          for (const events of [this.pendingCollisionEvents, this.collisionEventHistory]) {
            for (let index = events.length - 1; index >= 0; index--) {
              const event = events[index];
              if (event === undefined) throw new Error('Collision event roster invariant failed');
              if (
                (event.entityA === entity &&
                  event.shapeA !== undefined &&
                  shapeIds.has(event.shapeA)) ||
                (event.entityB === entity &&
                  event.shapeB !== undefined &&
                  shapeIds.has(event.shapeB))
              )
                events.splice(index, 1);
            }
          }
        };
        retireOwnedSourceEvents();
        this.derivedCollisionReceipts.delete(current);
        this.derivedBodies.delete(entity);
        this.derivedPublications.delete(entity);
        this.derivedBodySources.delete(entity);
        this.derivedFailures.delete(entity);
        const restoreRetiredSourceBody = () => {
          const nativeBody = this.bodyForEntity(entity);
          if (nativeBody) {
            restoreDerivedDensities(
              this.bodyColliders(nativeBody),
              undefined,
              record.authoredDensity ?? 1,
              [],
              [],
              this.derivedColliderToShape,
            );
            this.restoreAutomaticMass(nativeBody, record.additionalMass);
            record.automaticAdditionalMass = record.additionalMass;
          }
          for (const other of [...(this.collisionPairs.get(entity) ?? [])]) {
            if (!this.bodiesShareCollision(entity, other) && this.removePair(entity, other))
              this.pushCollisionEvent({
                type: 'stopped',
                entityA: entity,
                entityB: other,
                fixedStep: this.fixedStep,
              });
          }
        };
        restoreRetiredSourceBody();
        return ok(undefined);
      } catch (cause) {
        this.derivedPoisonedEntities.add(entity);
        return err(
          new DerivedPhysicsError(
            'derived-backend-failed',
            'all exact-source native resources retire together',
            'dispose or rebuild the PhysicsWorld after failed native retirement',
            { entity, reason: String(cause) },
            { cause },
          ),
        );
      }
    };
    return completeRetiringSource();
  }

  getDerivedCollisionReceipt(entity: number): DerivedPhysicsCollisionReceipt | undefined {
    return runGetDerivedCollisionReceipt(
      (operation) => this.assertCommittedReadable(operation),
      () => this.recoveryBlocked(),
      this.derivedBodies,
      this.derivedPublications,
      this.derivedCollisionReceipts,
      entity,
    );
  }

  getDerivedFailure(entity: number): DerivedPhysicsFailure | undefined {
    const failure = this.derivedFailures.get(entity);
    return failure === undefined ? undefined : { ...failure };
  }

  getDerivedBodyType(entity: number): RigidBodyType | undefined {
    this.assertCommittedReadable('getDerivedBodyType');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    return rapierBodyTypeToString(this.rapierModule, body.bodyType());
  }

  getDerivedBodyMass(entity: number): number | undefined {
    this.assertCommittedReadable('getDerivedBodyMass');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    return body === undefined ? undefined : body.mass();
  }

  getDerivedMotion(entity: number): DerivedPhysicsMotion | undefined {
    this.assertCommittedReadable('getDerivedMotion');
    if (this.recoveryBlocked() || !this.derivedBodies.has(entity)) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    return readNativeDerivedMotion(body);
  }

  applyDerivedImpulse(
    input: Parameters<NonNullable<PhysicsWorld['applyDerivedImpulse']>>[0],
  ): Result<void, DerivedPhysicsError> {
    const pending = this.pendingDerivedMutation('applyDerivedImpulse');
    if (pending) return err(pending);
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
    this.assertCommittedReadable('getDerivedShapes');
    if (this.recoveryBlocked()) return [];
    const body = this.derivedBodies.get(entity);
    if (body === undefined) return [];
    return describeDerivedShapes(body, entity);
  }

  getDerivedConstraintStates(): readonly Pick<
    PhysicsConstraintInput,
    'id' | 'revision' | 'bodyA' | 'bodyB'
  >[] {
    this.assertCommittedReadable('getDerivedConstraintStates');
    return describeDerivedConstraints(this.derivedConstraints);
  }

  captureDerivedPhysicsState(): DerivedPhysicsSnapshot {
    this.assertCommittedReadable('captureDerivedPhysicsState');
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
          ...(body.sourceTransform === undefined ? {} : { sourceTransform: body.sourceTransform }),
          shapes: copyDerivedShapeInputs(body),
          ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
          ...(body.sourceTransform !== undefined
            ? {}
            : (() => {
                const motion = this.getDerivedMotion(body.entity);
                return motion === undefined ? {} : { motion };
              })()),
          constraints: Object.freeze(this.constraintsForBody(body.entity)),
        })),
      ),
    });
  }

  restoreDerivedPhysicsState(
    snapshot: DerivedPhysicsSnapshot,
  ): ReturnType<NonNullable<PhysicsWorld['restoreDerivedPhysicsState']>> {
    return runRestoreDerivedPhysicsState(
      (operation) => this.pendingDerivedMutation(operation),
      (operation) => this.assertActive(operation),
      (input) => this.prepareDerivedShapeCandidate(input),
      (candidate) => this.cancelDerivedShapeCandidate(candidate),
      (candidates, commitGeometry, unionOfGroups) =>
        this.admitDerivedShapeCandidates(candidates, commitGeometry, unionOfGroups),
      snapshot,
    );
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
    const pending = this.pendingDerivedMutation('removeDerivedConstraint');
    if (pending) return err(pending);
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
    return runCreateManagedJoints(
      (operation) => this.pendingManagedMutation(operation),
      (operation) => this.assertActive(operation),
      (entity) => this.bodyForEntity(entity),
      (handle) => this.removeNativeConstraint(handle),
      () => this.raw,
      this.rapierModule,
      () => this.disposed,
      () => this.solverPending,
      this.solverRetiredJoints,
      inputs,
    );
  }

  getJointCount(): number {
    this.assertCommittedReadable('getJointCount');
    return this.raw.impulseJoints.len();
  }

  getBodyMotion(entity: number): Result<BodyMotion, ManagedPhysicsFailure> {
    this.assertCommittedReadable('getBodyMotion');
    return this.motionReadback.read(entity, this.bodyForEntity(entity));
  }

  setBodyMotion(
    entity: number,
    motion: Omit<BodyMotion, 'sleeping'>,
  ): Result<void, ManagedPhysicsFailure> {
    const pending = this.pendingManagedMutation('setBodyMotion');
    if (pending) return err(pending);
    this.assertActive('setBodyMotion');
    const body = this.bodyForEntity(entity);
    const record = this.entityMap.get(entity);
    if (body === undefined || record === undefined)
      return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    if (this.derivedBodies.get(entity)?.sourceTransform !== undefined)
      return err(
        new ManagedPhysicsError('managed-joint-invalid', {
          index: -1,
          reason:
            'source-owned body pose remains controlled by its accepted Scene matrix; retire or replace the source before setBodyMotion',
        }),
      );
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
    try {
      this.contactDeltaTime = 0;
      record.motionDiscontinuity++;
      writeNativeBodyMotion(body, motion, this.entityMap.get(entity)?.lockRotation);
      this.motionReadback.enroll(entity, true);
      this.motionReadback.notify(entity);
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
    const pending = this.pendingManagedMutation('applyBodyImpulse');
    if (pending) return err(pending);
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
      this.motionReadback.notify(entity);
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
    sourceTransform?: DerivedPhysicsSourceTransform,
  ): { readonly handle: number; readonly colliderHandles?: readonly number[] } {
    return runCreateDerivedCollider(
      this.rapierModule,
      () => this.raw,
      (collider, entity) => this.syncIsolationCollider(collider, entity),
      this.derivedColliderToShape,
      (reason) => this.colliderFailure(reason),
      (handle) => this.removeNativeCollider(handle),
      body,
      shape,
      previous,
      allowGroups,
      sourceTransform,
    );
  }

  private removeNativeCollider(handle: number): void {
    this.sensorColliderIdentities.delete(handle);
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
    return runCreateNativeConstraint(
      (entity) => this.bodyForEntity(entity),
      this.rapierModule,
      () => this.raw,
      (handle) => this.removeNativeConstraint(handle),
      input,
    );
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
    return runProcessDerivedCandidates(
      this.pendingDerivedCandidates,
      this.derivedCandidates,
      (record, error) => this.rejectPreparedCandidate(record, error),
      this.derivedPoisonedEntities,
      (group) => this.derivedGroupRejection(group),
      (group) => this.preflightDerivedBatch(group),
      (group) => this.admitDerivedGroup(group),
    );
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
    return runDerivedRecordRejection(
      this.derivedBodies,
      () => this.raw,
      (entity) => this.bodyForEntity(entity),
      this.derivedPoisonedEntities,
      (input, sourceOverrides) => this.validateDerivedAdmission(input, sourceOverrides),
      record,
      sources,
    );
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
      entityScale: this.entityMap.get(entity)?.scale,
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
    return runStageDerivedRecord(
      this.motionReadback,
      () => this.raw,
      this.derivedColliderToShape,
      this.groupedContactEvents,
      (record, staged) => this.stageDerivedConstraints(record, staged),
      this.rapierModule,
      (record) => this.enableCandidateColliders(record),
      (record, old) => this.retireReplacedDerivedShapes(record, old),
      this.entityMap,
      (
        body,
        properties,
        previousWorldCom,
        velocityPolicy,
        authoredAdditionalMass,
        entity,
        candidateShapes,
        candidateColliders,
      ) =>
        this.applyDerivedMass(
          body,
          properties,
          previousWorldCom,
          velocityPolicy,
          authoredAdditionalMass,
          entity,
          candidateShapes,
          candidateColliders,
        ),
      this.derivedConstraints,
      (record) => this.retireSupersededConstraints(record),
      (record, staged) => this.adoptStagedConstraints(record, staged),
      () => this.backendGeneration,
      undo,
    );
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
    runFailDerivedGroup(
      (undo) => this.tryRollbackDerivedAdmission(undo),
      this.derivedPoisonedEntities,
      this.derivedBodies,
      this.derivedPublications,
      (record, error, recovery) => this.rememberDerivedFailure(record, error, recovery),
      group,
      failed,
      committed,
      cause,
    );
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
    if (entityRecord !== undefined) {
      if (undo.automaticRecordMass !== undefined)
        entityRecord.automaticAdditionalMass = undo.automaticRecordMass;
      if (undo.entityScale !== undefined) entityRecord.scale = undo.entityScale;
    }
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
          inputDigest: body.inputDigest,
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
    runApplyDerivedMass(
      this.entityMap,
      (entity, body) => this.rememberAuthoredDensity(entity, body),
      (body) => this.bodyColliders(body),
      this.derivedColliderToShape,
      (body, additionalMass) => this.restoreAutomaticMass(body, additionalMass),
      body,
      properties,
      previousWorldCom,
      velocityPolicy,
      authoredAdditionalMass,
      entity,
      candidateShapes,
      candidateColliders,
    );
  }

  /** Restore the complete committed mass policy after a failed admission. */
  private restoreCommittedMass(
    body: RapierRigidBody,
    previous: DerivedBodyRecord | undefined,
    automaticAdditionalMass: number,
  ): void {
    runRestoreCommittedMass(
      (body, additionalMass) => this.restoreAutomaticMass(body, additionalMass),
      body,
      previous,
      automaticAdditionalMass,
    );
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
    return runValidateConstraintDependencies(
      this.derivedPoisonedEntities,
      this.entityMap,
      (entity) => this.sourceForEntity(entity),
      input,
      candidate,
      sourceOverrides,
    );
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
    return runValidateDerivedAdmission(
      (input, candidate, sourceOverrides) =>
        this.validateConstraintDependencies(input, candidate, sourceOverrides),
      this.derivedConstraints,
      input,
      sourceOverrides,
    );
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
    return runInstallDerivedConstraint(
      (operation) => this.pendingDerivedMutation(operation),
      (operation) => this.assertActive(operation),
      (input, candidate, sourceOverrides) =>
        this.validateConstraintDependencies(input, candidate, sourceOverrides),
      () => this.pendingDerivedSources(),
      this.derivedConstraints,
      (input) => this.createNativeConstraint(input),
      (handle) => this.removeNativeConstraint(handle),
      input,
      updating,
    );
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
    this.assertCommittedReadable('dispose');
    this.solverWorker?.dispose();
    this.solverParticipants.dispose();
    this.solverPending = false;
    this.nativeExecuting = false;
    this.assertActive('dispose');
    this.motionReadback.clear();
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
    this.nativeStepTimingListeners.clear();
    this.raw.profilerEnabled = false;
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

  /** Generation-bearing native identity, scoped to this instance's raw world. */
  getBodyHandle(entity: number): number | undefined {
    this.assertActive('getBodyHandle');
    return this.bodyForEntity(entity)?.handle;
  }

  /** Bind the ECS owner used by character motion and pose writeback. */
  setMoveContext(world: World, transform: Component): void {
    this.assertActive('setMoveContext');
    this.moveContext = { world, transform };
    this.bindIsolationWorld(world);
  }

  /** Release the persistent ECS readers owned by one system registration. */
  clearEcsContext(world: World): void {
    this.assertActive('clearEcsContext');
    this.contactDeltaTime = 0;
    if (this.worldIdentity === world) this.clearPairIsolation();
    if (this.syncState?.world === world) this.syncState = undefined;
    if (this.terrainSync?.world === world) this.terrainSync = undefined;
    if (this.moveContext?.world === world) this.moveContext = undefined;
    if (this.worldIdentity === world) this.worldIdentity = undefined;
  }

  moveAndSlide(entity: number, desiredDelta: Vec3, options?: MoveAndSlideOptions): Vec3 {
    this.assertActive('moveAndSlide');
    const deltaTime = characterMovementDeltaTime(options);
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
      return this.computeMove(entity, desiredDelta, options, deltaTime);
    } finally {
      this.nativeExecuting = false;
    }
  }

  private pendingDerivedMutation(operation: string): DerivedPhysicsError | undefined {
    if (!this.solverPending) return undefined;
    return new DerivedPhysicsError(
      'derived-candidate-pending',
      'derived native mutation starts between completed solver snapshots',
      'retry at the next fixed-step admission boundary; retain the accepted generation',
      { reason: operation },
    );
  }

  private pendingManagedMutation(
    operation: string,
  ): ManagedPhysicsError<'managed-physics-unavailable'> | undefined {
    if (!this.solverPending) return undefined;
    return new ManagedPhysicsError('managed-physics-unavailable', {
      reason: `${operation} requires a completed solver snapshot before native mutation`,
    });
  }

  private assertCommittedReadable(operation: string): void {
    // A Worker owns detached bytes; the main realm retains the last completed world.
    if (this.nativeExecuting && !this.solverPending)
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

  private assertActive(operation: string): void {
    if (this.solverPending)
      throw new Error(
        `RapierPhysicsWorld3D.${operation} cannot mutate an in-flight solver snapshot`,
      );
    this.assertCommittedReadable(operation);
  }

  /**
   * Shared moveAndSlide core (plan-strategy D-1/D-2/D-4/D-6/D-7).
   *
   * The three Fail-Fast entry checks (body / collider / kinematic) throw
   * structured PhysicsError before the World is read, so error-path tests can
   * call this without registered systems.
   */
  private computeMove(
    entity: number,
    desiredDelta: Vec3,
    options: MoveAndSlideOptions | undefined,
    deltaTime: number | undefined,
  ): Vec3 {
    return runComputeMove(
      this.rapierModule,
      (entity) => this.bodyForEntity(entity),
      (entity) => this.readCharacterController(entity),
      (entity, offset) => this.ensureKcc(entity, offset),
      () => this.raw,
      this.isolationColliderOwners,
      (a, b) => this.colliderPairIsolated(a, b),
      () => this.moveContext,
      entity,
      desiredDelta,
      options,
      deltaTime,
    );
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
    return runAuthoredColliderDesc(
      this.rapierModule,
      (reason) => this.colliderFailure(reason),
      (collider) => this.meshGeometry(collider),
      transform,
      collider,
      bodyType,
    );
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
    sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
  ): PhysicsSyncDescriptor | undefined {
    return runReconcilePhysicsEntity(
      (entity) => this.removeEntity(entity),
      (entity, staticByEcs) => this.reconcileTransformlessCompatibility(entity, staticByEcs),
      (entity) => this.hasBody(entity),
      (entity, descriptor, sourceOwnedTypeRejections) =>
        this.syncAuthoredEcsMutation(entity, descriptor, sourceOwnedTypeRejections),
      (entity, transform, rigidBody, collider) =>
        this.ensureBody(entity, transform, rigidBody, collider),
      this.kccOffsets,
      this.kccCache,
      (entity) => this.removeKccController(entity),
      (entity, offset) => this.ensureKcc(entity, offset),
      this.derivedBodies,
      (entity, transform, collider, bodyType) =>
        this.syncAuthoredPose(entity, transform, collider, bodyType),
      this.solverAuthoredPoseChanges,
      (entity) => this.bodyForEntity(entity),
      this.motionReadback,
      state,
      entity,
      previous,
      sourceOwnedTypeRejections,
    );
  }
  private syncAuthoredEcsMutation(
    entity: number,
    descriptor: PhysicsSyncDescriptor,
    sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
  ): PhysicsSyncDescriptor {
    return runSyncAuthoredEcsMutation(
      (entity) => this.bodyForEntity(entity),
      this.rapierModule,
      this.derivedBodies,
      (entity, committed, requestedType, normalizationFailure) =>
        this.rememberSourceOwnedTypeRefusal(entity, committed, requestedType, normalizationFailure),
      (transform, collider, bodyType) => this.authoredColliderDesc(transform, collider, bodyType),
      (body) => this.bodyColliders(body),
      (desc, body, collider) => this.createAuthoredCollider(desc, body, collider),
      (collider, entity) => this.syncIsolationCollider(collider, entity),
      this.derivedColliderToShape,
      this.terrainColliders,
      this.retiredColliderOwners,
      this.isolationColliderOwners,
      () => this.raw,
      () => this.sharedGeometry,
      this.entityMap,
      (entity) => this.retireRemovedColliderPairs(entity),
      (entity, transform, collider, bodyType) =>
        this.syncAuthoredPose(entity, transform, collider, bodyType),
      (body, additionalMass) => this.restoreAutomaticMass(body, additionalMass),
      (entity, body, locked) => this.syncRotationLock(entity, body, locked),
      (body, previous, automaticAdditionalMass) =>
        this.restoreCommittedMass(body, previous, automaticAdditionalMass),
      entity,
      descriptor,
      sourceOwnedTypeRejections,
    );
  }

  private rememberSourceOwnedTypeRefusal(
    entity: number,
    committed: DerivedBodyRecord,
    requestedType: number,
    normalizationFailure?: unknown,
  ): void {
    runRememberSourceOwnedTypeRefusal(
      this.derivedFailures,
      () => this.fixedStep,
      entity,
      committed,
      requestedType,
      normalizationFailure,
    );
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
    const sourceOwnedTypeRejections: SourceOwnedTypeRejection[] = [];
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
        sourceOwnedTypeRejections,
      );
      updates.push({ index, descriptor });
    }
    batch.accept();
    for (const { index, descriptor } of updates) {
      if (descriptor === undefined) state.accepted.delete(index);
      else state.accepted.set(index, descriptor);
    }
    for (const rejection of sourceOwnedTypeRejections) {
      const normalized = world.set(rejection.entity, RigidBody, {
        type: RigidBodyTypeValue.static,
      });
      if (!normalized.ok) {
        const committed = this.derivedBodies.get(rejection.entity);
        if (committed?.candidateId === rejection.candidateId)
          this.rememberSourceOwnedTypeRefusal(
            rejection.entity,
            committed,
            rejection.requestedType,
            normalized.error,
          );
      }
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
    runEnsureBody(
      (operation) => this.assertActive(operation),
      this.entityMap,
      this.rapierModule,
      (transform, collider, bodyType) => this.authoredColliderDesc(transform, collider, bodyType),
      () => this.raw,
      (entity, bodyHandle, additionalMass, authoredDensity) =>
        this.registerBody(entity, bodyHandle, additionalMass, authoredDensity),
      (entity, body, locked) => this.syncRotationLock(entity, body, locked),
      (desc, body, collider) => this.createAuthoredCollider(desc, body, collider),
      (collider, entity) => this.syncIsolationCollider(collider, entity),
      (entity) => this.removeEntity(entity),
      (body, additionalMass) => this.restoreAutomaticMass(body, additionalMass),
      entity,
      transform,
      rigidBody,
      collider,
    );
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
    runSyncAuthoredPose(
      (operation) => this.assertActive(operation),
      this.entityMap,
      () => this.raw,
      this.motionReadback,
      (body) => this.bodyColliders(body),
      this.derivedColliderToShape,
      this.terrainColliders,
      entity,
      transform,
      collider,
      bodyType,
    );
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
      generation: ++this.bodyGeneration,
      motionDiscontinuity: 0,
      bodyHandle,
      lockRotation: false,
      scale: Object.freeze([1, 1, 1]),
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
    this.motionReadback.enroll(entity, true);
    const body = this.raw.getRigidBody(bodyHandle);
    if (body !== undefined && body !== null)
      for (const collider of this.bodyColliders(body)) this.syncIsolationCollider(collider, entity);
    this.motionReadback.notify(entity);
  }

  setKinematicPosition(entity: number, pos: { x: number; y: number; z: number }): void {
    this.assertActive('setKinematicPosition');
    const record = this.entityMap.get(entity);
    if (!record) return;
    this.contactDeltaTime = 0;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    this.motionReadback.enroll(entity, true);
    this.motionReadback.notify(entity);
  }
  /** Detached dynamic poses; unchanged sleeping bodies need no native reads. */
  writebackDynamicBodies(): BodyMotionWriteback[] {
    return this.motionReadback.writeback(this.raw, this.entityMap, this.rapierModule.RigidBodyType);
  }

  private solverSourcePose(entity: number): string {
    if (!this.syncState) return '';
    const read = this.syncState.world.get(
      entity as EntityHandle,
      this.syncState.transformComponent,
    );
    if (!read.ok) return '';
    const value = read.value as unknown as {
      pos: ArrayLike<number>;
      quat: ArrayLike<number>;
      scale: ArrayLike<number>;
      shear: ArrayLike<number>;
    };
    return JSON.stringify([
      Array.from(value.pos),
      Array.from(value.quat),
      Array.from(value.scale),
      Array.from(value.shear),
    ]);
  }

  removeEntity(entity: number): void {
    runRemoveEntity(
      () => this.solverPending,
      this.solverRetiredEntities,
      this.groupedContactEvents,
      this.isolatedPairs,
      (key, pair) => this.retireIsolatedPair(key, pair),
      this.entityMap,
      (entity) => this.bodyForEntity(entity),
      (body) => this.bodyColliders(body),
      this.isolationColliderOwners,
      this.derivedCandidates,
      (record, error) => this.rejectPreparedCandidate(record, error),
      this.derivedBodies,
      (handle) => this.removeNativeCollider(handle),
      this.derivedPublications,
      this.derivedFailures,
      this.derivedPoisonedEntities,
      this.derivedConstraints,
      (handle) => this.removeNativeConstraint(handle),
      this.pendingDerivedCandidates,
      (candidateId) => this.releaseDerivedCandidate(candidateId),
      this.collisionPairs,
      (a, b) => this.removePair(a, b),
      (event) => this.pushCollisionEvent(event),
      (entity) => this.removeKccController(entity),
      () => this.raw,
      () => this.sharedGeometry,
      this.terrainColliders,
      this.dirtyPairPolicies,
      this.derivedBodySources,
      this.motionReadback,
      entity,
    );
  }
}

export function createRapier3DPhysicsWorld(
  rapier: Rapier3DModule,
  options: PhysicsOptions = {},
): RapierPhysicsWorld3D {
  return new RapierPhysicsWorld3D(rapier, options);
}

export function requireRapierPhysicsWorld3D(world: World): RapierPhysicsWorld3D {
  const physics = world.getResource(PhysicsWorldResource);
  if (!(physics instanceof RapierPhysicsWorld3D))
    throw new TypeError('The World uses a different physics backend');
  return physics;
}
