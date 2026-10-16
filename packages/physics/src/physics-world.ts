// @forgeax/engine-physics — PhysicsWorld Resource interface.
//
// The physics backend (RapierPhysicsWorld3D / RapierPhysicsWorld2D) implements
// this interface and registers as the 'PhysicsWorld' World Resource.
// AI users obtain it via `world.getResource<PhysicsWorld>('PhysicsWorld')`.

import type { Vec2, Vec3 } from '@forgeax/engine-math';
import type { Result } from '@forgeax/engine-types';
import type { PhysicsContactSnapshot } from './contact-query.js';
import type {
  DerivedBodyTypeCandidateInput,
  DerivedPhysicsCandidate,
  DerivedPhysicsCandidateInput,
  DerivedPhysicsError,
  DerivedPhysicsFailure,
  DerivedPhysicsMotion,
  DerivedPhysicsPublication,
  DerivedPhysicsSnapshot,
  DerivedShapeState,
  PhysicsConstraintInput,
  PhysicsContactObservation,
  PhysicsVector,
} from './derived-physics.js';
import type {
  BodyMotion,
  ManagedJointBinding,
  ManagedJointInput,
  ManagedPhysicsFailure,
} from './managed-joints.js';
import type {
  PairIsolationError,
  PairIsolationInput,
  PairIsolationLease,
} from './pair-isolation.js';

/**
 * Raycast hit result — returned by `PhysicsWorld.raycast()`.
 *
 * `entity`: the entity whose collider was hit.
 * `point`: world-space hit point.
 * `normal`: world-space surface normal at hit point.
 * `timeOfImpact`: ray parameter t (origin + direction * toi = hit point).
 */
export interface RaycastHit {
  entity: number;
  point: Vec3;
  normal: Vec3;
  timeOfImpact: number;
}

/**
 * PhysicsWorld Resource interface — the engine-side API surface for physics
 * operations. Backend implementations (RapierPhysicsWorld3D/2D) satisfy this
 * contract.
 *
 * Inserted as `'PhysicsWorld'` resource by `createApp` when `opts.physics`
 * is set. AI users retrieve via `world.getResource<PhysicsWorld>('PhysicsWorld')`.
 *
 * All mutation methods are synchronous; physics step is driven by the tick
 * systems (syncBackend → stepSimulation → writeback), not by user calls.
 */
export interface PhysicsWorld {
  /** Transactionally create ordinary body joints; all endpoints must already be synchronized. */
  createManagedJoints?: (
    inputs: readonly ManagedJointInput[],
  ) => Result<ManagedJointBinding, ManagedPhysicsFailure>;
  /** Detached world-space body evidence; no Rapier object escapes. */
  getBodyMotion?: (entity: number) => Result<BodyMotion, ManagedPhysicsFailure>;
  /** Bounded current solid contacts after writeback; optional packed groups match raycast filters. */
  getCurrentContacts?: (
    entity: number,
    filterMask?: number,
  ) => Result<PhysicsContactSnapshot, ManagedPhysicsFailure>;
  /** Request native wake without changing pose or velocity; contacts require the next step. */
  wakeBody?: (entity: number) => Result<void, ManagedPhysicsFailure>;
  /** Explicit pose/velocity handoff. Call after synchronization and before step, never for visual blend. */
  setBodyMotion?: (
    entity: number,
    motion: Omit<BodyMotion, 'sleeping'>,
  ) => Result<void, ManagedPhysicsFailure>;
  /** Ordinary dynamic impulse, independent of derived geometry. */
  applyBodyImpulse?: (
    entity: number,
    impulse: PhysicsVector,
  ) => Result<void, ManagedPhysicsFailure>;
  /** Current native solver joint count, including managed and derived joints. */
  getJointCount?: () => number;
  /**
   * Exclude exactly two live bodies from contacts, sensor intersections and KCC
   * obstacles, starting at the next step/query. All other pairs and authored
   * groups remain eligible. Missing capability must be refused by the caller.
   * Leases expire on body replacement, entity retirement or World detach.
   */
  acquirePairIsolation?: (
    input: PairIsolationInput,
  ) => Result<PairIsolationLease, PairIsolationError>;
  /** Release backend-native resources. Called by the owning physics plugin. */
  dispose(): void;
  /** Set world gravity vector. */
  setGravity(gravity: Vec3): void;

  /** Get current world gravity vector. */
  getGravity(): Vec3;

  /**
   * Cast a ray into the physics world and return the first hit.
   *
   * @param origin - world-space ray origin.
   * @param direction - normalized world-space ray direction.
   * @param maxDist - maximum ray distance (0 = infinite).
   * @param filterMask - 32-bit packed collision filter mask (optional).
   * @returns RaycastHit on hit, undefined on miss.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit | undefined;

  /**
   * Place an existing body at a world-space position
   * before this call returns, zeroing velocity. The body, attached colliders,
   * and ECS Transform agree immediately, so a same-tick `moveAndSlide` starts
   * from the new position. Kinematic bodies also update their next step target.
   *
   * Call after `hasBody(entity)` reports readiness. Use for resetting after
   * out-of-bounds or reconciling a character to an authoritative position.
   * Does not accumulate velocity from the displacement
   * (unlike `world.set(entity, Transform, { translation: ... })` on
   * dynamic bodies, which would cause a velocity spike).
   *
   * @param entity - the entity with a registered native body.
   * @param position - new world-space position.
   * @throws PhysicsError `body-not-found` if the native body is not ready, or
   *   `invalid-body-config` for a non-finite position.
   */
  teleport(entity: number, position: Vec3): void;

  /**
   * Move a kinematic character with collision response, slope handling,
   * auto-step, and ground-snap, then write the resolved position back to the
   * entity's `Transform` and `CharacterController.grounded`.
   *
   * This is the engine's unopinionated movement primitive (modeled on Unity
   * `CharacterController.Move`): the game layer computes `desiredDelta` from
   * input + gravity + jump, and `moveAndSlide` resolves it against the world
   * geometry. The entity must carry a `RigidBody({ type: 'kinematic' })`, a
   * `Collider`, and a `CharacterController` component.
   *
   * Tuning (offset / slope / auto-step / ground-snap) is read from the
   * `CharacterController` component each call; there is no per-call options
   * object and no `dt` parameter (the delta already encodes elapsed time).
   *
   * @param entity       the character entity (kinematic RigidBody + Collider + CharacterController).
   * @param desiredDelta the requested world-space displacement for this step.
   * @returns the actual displacement applied after collision resolution.
   * @throws PhysicsError `body-not-found` if the entity has no Rapier body,
   *   `collider-not-found` if the body has no collider,
   *   `controller-requires-kinematic` if the body is not kinematic.
   */
  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3;

  /** Advance the physics simulation by one timestep. */
  step(deltaTime: number): void;

  /** Return the number of active rigid bodies in the physics world. */
  getBodyCount(): number;

  /**
   * Check whether a Rapier body exists for `entity`.
   *
   * Returns `true` after `ensureBody` has created a Rapier body for the entity
   * (which happens asynchronously via WASM fire-and-forget load + tick pipeline).
   * A RigidBody-only 3D entity is a native body even before derived shapes arrive.
   *
   * AI-user contract: before calling `moveAndSlide` inside a per-frame driver,
   * guard with `if (!pw.hasBody(entity)) return;` to avoid `body-not-found`
   * errors during the window between `app.start()` and the first
   * `physicsSyncBackend` tick that builds the body.
   */
  hasBody(entity: number): boolean;

  /**
   * Prepare a replacement set of local derived shapes without making it
   * queryable. The Rapier 3D implementation backs these shapes with one
   * native world and one ECS body; 2D backends may omit this optional seam.
   */
  prepareDerivedShapeCandidate?: (
    input: DerivedPhysicsCandidateInput,
  ) => Result<DerivedPhysicsCandidate, DerivedPhysicsError>;
  /**
   * Prepare one declared atomic group of distinct bodies. Every native shape
   * remains disabled until the complete returned roster is admitted together.
   * A failed member releases the whole preparation. The group consumes one
   * shared in-flight slot; its members share the ordinary candidate byte budget.
   */
  prepareDerivedShapeCandidates?: (
    inputs: readonly DerivedPhysicsCandidateInput[],
  ) => Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError>;
  /**
   * Prepare one type-only group against exact current owned publications.
   * Retains the accepted entities, shape revisions and native colliders. Admit
   * with admitDerivedShapeCandidates for the same paired callback/rollback.
   * Any replaced publication makes the preparation stale; receipt copies and
   * receipts from another PhysicsWorld are refused.
   */
  prepareDerivedBodyTypeCandidates?: (
    inputs: readonly DerivedBodyTypeCandidateInput[],
  ) => Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError>;
  /**
   * Queue a prepared candidate. The optional synchronous geometry commit runs
   * after fallible native preparation, before step/publication. It must either
   * commit its complete ECS binding or return failure without changing it.
   * Returned failure restores old physics; a thrown callback has uncertain ECS
   * writes and requires rebuild. Reentrant physics access is refused.
   */
  admitDerivedShapeCandidate?: (
    candidate: DerivedPhysicsCandidate,
    commitGeometry?: () => Result<void, Error>,
  ) => Result<DerivedPhysicsCandidate, DerivedPhysicsError>;
  /**
   * Queue one bounded replacement across distinct bodies. Native preparation
   * completes for every member before the single geometry callback; any member
   * failure rolls the group back. A thrown callback or failed rollback requires
   * rebuilding the PhysicsWorld. Preparation/candidate budgets remain shared.
   */
  admitDerivedShapeCandidates?: (
    candidates: readonly DerivedPhysicsCandidate[],
    commitGeometry?: () => Result<void, Error>,
  ) => Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError>;
  /** Borrowed ordering proof, present only inside the paired geometry commit. */
  getDerivedAdmission?: (
    entity?: number,
  ) =>
    | { readonly entity: number; readonly revision: number; readonly fixedStep: number }
    | undefined;
  /** Cancel a candidate that has not been published. */
  cancelDerivedShapeCandidate?: (
    candidate: DerivedPhysicsCandidate,
  ) => Result<void, DerivedPhysicsError>;
  /** Invalidate pending candidates without touching the last committed state. */
  invalidateDerivedShapeCandidates?: (reason?: string) => void;
  /** Read the most recent fixed-step publication for one body. */
  getDerivedPublication?: (entity: number) => DerivedPhysicsPublication | undefined;
  /** Read the structured failure from the latest rejected admission, if any. */
  getDerivedFailure?: (entity: number) => DerivedPhysicsFailure | undefined;
  /** Read the committed body type without exposing a native Rapier body. */
  getDerivedBodyType?: (entity: number) => 'static' | 'dynamic' | 'kinematic' | undefined;
  /** Read whether a native admission failure requires a full World rebuild. */
  getDerivedRecoveryState?: () => 'ready' | 'rebuild-required';
  /** Read detached mass evidence without exposing a native body handle. */
  getDerivedBodyMass?: (entity: number) => number | undefined;
  /** Read the committed world-space COM and velocities for one derived body. */
  getDerivedMotion?: (entity: number) => DerivedPhysicsMotion | undefined;
  /**
   * Apply a world-space impulse at a world-space point on the exact committed
   * dynamic body revision. Call after syncBackend and before stepSimulation.
   * Rejects queued admission, stale identity and invalid vectors; never moves
   * the pose directly. A partially failed native write requires World recovery.
   * The caller bounds impulse magnitude, normally maxForce * FixedTime.delta.
   */
  applyDerivedImpulse?: (input: {
    readonly entity: number;
    readonly sourceKey: string;
    readonly revision: number;
    readonly impulse: PhysicsVector;
    readonly point: PhysicsVector;
  }) => Result<void, DerivedPhysicsError>;
  /** Read the currently committed local shape identities for one body. */
  getDerivedShapes?: (entity: number) => readonly DerivedShapeState[];
  /** Conservative completed-step contact prefilter; undefined requires the full contact seam. */
  hasManagedContactPair?: (entity: number, other: number) => boolean | undefined;
  /** Read an immutable detached contact publication; held snapshots survive later drains. */
  getContactObservations?: () => readonly PhysicsContactObservation[];
  /** Complete the fixed-step publication after ECS writeback/contact sync. */
  finalizeDerivedFixedStep?: () => void;
  /** Capture portable, committed input for explicit rebuild/recovery. */
  captureDerivedPhysicsState?: () => DerivedPhysicsSnapshot;
  /** Read committed constraint identities and endpoints without capturing body geometry. */
  getDerivedConstraintStates?: () => readonly Pick<
    PhysicsConstraintInput,
    'id' | 'revision' | 'bodyA' | 'bodyB'
  >[];
  /** Restore a previously captured input through normal candidate admission. */
  restoreDerivedPhysicsState?: (
    snapshot: DerivedPhysicsSnapshot,
  ) => Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError>;
  /** Create/update/remove constraints in the same solver as ordinary bodies. */
  createDerivedConstraint?: (
    input: PhysicsConstraintInput,
  ) => Result<{ readonly id: string; readonly revision: number }, DerivedPhysicsError>;
  updateDerivedConstraint?: (
    input: PhysicsConstraintInput,
  ) => Result<{ readonly id: string; readonly revision: number }, DerivedPhysicsError>;
  removeDerivedConstraint?: (id: string) => Result<void, DerivedPhysicsError>;
}

/** 2D raycast hit result. */
export interface RaycastHit2D {
  entity: number;
  point: Vec2;
  normal: Vec2;
  timeOfImpact: number;
}

/** 2D PhysicsWorld Resource interface. */
export interface PhysicsWorld2D {
  /** Release backend-native resources. Called by the owning physics plugin. */
  dispose(): void;
  setGravity(gravity: Vec2): void;
  getGravity(): Vec2;
  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined;
  /**
   * Immediately place an existing body at a world-space
   * 2D position and angle, synchronizing its colliders and ECS Transform.
   * Kinematic bodies update their next step target; velocity is cleared.
   * Call after `hasBody(entity)` reports readiness.
   * @throws PhysicsError `body-not-found` or `invalid-body-config` for
   *   non-finite inputs.
   */
  teleport(entity: number, position: Vec2, rotation: number): void;
  /**
   * Move a kinematic character with collision response, slope handling,
   * auto-step, and ground-snap (2D variant of {@link PhysicsWorld.moveAndSlide}).
   *
   * Resolves `desiredDelta` against the world geometry, writes the resolved
   * position back to the entity's `Transform` and `CharacterController.grounded`,
   * and returns the actual 2D displacement. The entity must carry a
   * `RigidBody({ type: 'kinematic' })`, a `Collider`, and a `CharacterController`.
   *
   * @param entity       the character entity (kinematic RigidBody + Collider + CharacterController).
   * @param desiredDelta the requested world-space 2D displacement for this step.
   * @returns the actual 2D displacement applied after collision resolution.
   * @throws PhysicsError `body-not-found`, `collider-not-found`, or
   *   `controller-requires-kinematic` (same contract as the 3D primitive).
   */
  moveAndSlide(entity: number, desiredDelta: Vec2): Vec2;
  step(deltaTime: number): void;
  getBodyCount(): number;

  /**
   * Check whether a Rapier 2D body exists for `entity`.
   *
   * See {@link PhysicsWorld.hasBody} for the full contract — the 2D variant
   * follows the same semantics.
   */
  hasBody(entity: number): boolean;
}
