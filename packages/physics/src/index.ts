// @forgeax/engine-physics — physics interface package barrel.
//
// ECS component schemas (RigidBody / Collider / CollisionEvent),
// PhysicsWorld Resource interface, PhysicsErrorCode union.
//
// Dependencies: @forgeax/engine-ecs (Component / event token),
// @forgeax/engine-math (Vec2 / Vec3 / Quat),
// @forgeax/engine-types (type utilities).

export { inspectPhysicsCapabilities, type PhysicsCapabilities } from './capabilities.js';
export type { CollisionEventPayload } from './collision-event.js';
export { CollisionEvent } from './collision-event.js';
export type {
  CharacterControllerData,
  ColliderData,
  ColliderShape,
  ColliderSnapshot,
  RigidBodyType,
} from './components.js';
export {
  CharacterController,
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  colliderShapeFromF32,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
  snapshotCollider,
  validateAdditionalSolverIterations,
} from './components.js';
export type {
  PhysicsContactManifold,
  PhysicsContactNeighborsSnapshot,
  PhysicsContactNormalFilter,
  PhysicsContactPointVelocities,
  PhysicsContactSnapshot,
} from './contact-query.js';
export type {
  ConvexCompoundShapeInput,
  DerivedBodyTypeCandidateInput,
  DerivedPhysicsAdmissionGuard,
  DerivedPhysicsAdmissionState,
  DerivedPhysicsCandidate,
  DerivedPhysicsCandidateInput,
  DerivedPhysicsCandidateState,
  DerivedPhysicsCollisionReceipt,
  DerivedPhysicsErrorCode,
  DerivedPhysicsErrorDetail,
  DerivedPhysicsFailure,
  DerivedPhysicsMotion,
  DerivedPhysicsPublication,
  DerivedPhysicsSnapshot,
  DerivedPhysicsSourceTransform,
  DerivedShapeInput,
  DerivedShapeState,
  HeightfieldShapeInput,
  NormalizedDerivedShapeInput,
  PhysicsConstraintBodyDependency,
  PhysicsConstraintInput,
  PhysicsContactObservation,
  PhysicsMassProperties,
  PhysicsQuaternion,
  PhysicsVector,
  PhysicsVelocityPolicy,
  PrimitiveShapeInput,
  TriangleMeshShapeInput,
  VoxelShapeInput,
} from './derived-physics.js';
export {
  cloneDerivedPhysicsInput,
  clonePhysicsConstraintInput,
  DERIVED_PHYSICS_LIMITS,
  DerivedPhysicsError,
  estimateDerivedPhysicsInputBytes,
  normalizeConvexCompoundShapeInput,
  normalizeHeightfieldShapeInput,
  normalizePrimitiveShapeInput,
  normalizeTriangleMeshShapeInput,
  normalizeVoxelShapeInput,
  preserveCenterOfMassVelocity,
  validateMassProperties,
} from './derived-physics.js';
export type { PhysicsErrorCode, PhysicsErrorDetail } from './errors.js';
export { PHYSICS_ERROR_HINTS, PhysicsError } from './errors.js';
export * from './fixed-dynamics.js';
export type {
  BodyMassProperties,
  BodyMotion,
  ManagedJointBinding,
  ManagedJointInput,
  ManagedPhysicsErrorCode,
  ManagedPhysicsFailure,
} from './managed-joints.js';
export {
  finitePhysicsVector,
  ManagedPhysicsError,
  unitPhysicsQuaternion,
  validateManagedJoints,
} from './managed-joints.js';
export type {
  PairIsolationErrorCode,
  PairIsolationInput,
  PairIsolationLease,
} from './pair-isolation.js';
export { PairIsolationError } from './pair-isolation.js';
export { PhysicsWorld2DResource, PhysicsWorldResource } from './physics-world';
export type {
  CharacterSynchronization,
  MoveAndSlideOptions,
  NativePhysicsStepTiming,
  PhysicsSweepError,
  PhysicsWorld,
  PhysicsWorld2D,
  RaycastHit,
  RaycastHit2D,
  RaycastOptions,
  SphereSweepHit,
} from './physics-world.js';
export type { PhysicsPluginBackend } from './plugin-factory.js';
export { definePhysicsPlugin, physicsComponentsPlugin } from './plugin-factory.js';
export type {
  PhysicsQueryErrorCode,
  PhysicsQueryFailure,
  PhysicsQueryField,
  PhysicsSweepQuery,
  ShapeSweepContact,
  ShapeSweepResult,
} from './shape-query.js';
export { PhysicsQueryError, validatePhysicsSweepQuery } from './shape-query.js';
export type { ShapeSweepQuery, SweepShape } from './shape-sweep.js';
export { validateShapeSweepQuery } from './shape-sweep.js';
export {
  PhysicsSimulationControl,
  physicsSimulationRunning,
} from './simulation-control.js';
export {
  type PhysicsOptions,
  validateAsyncResultsInterpolation,
  validateProfileNativeStepTimings,
  validateSolverIterations,
} from './solver-options.js';
export type {
  PhysicsSolverClock,
  PhysicsSolverOutput,
  PhysicsSolverParticipant,
  PhysicsSolverParticipantInput,
  PhysicsSolverStepContext,
  PhysicsSolverTask,
} from './solver-participant.js';
export { PHYSICS_SOLVER_MAX_PAYLOAD_BYTES } from './solver-participant.js';
export type {
  SphereSweepContact,
  SphereSweepQuery,
  SphereSweepResult,
} from './sphere-sweep.js';
export { validateSphereSweepQuery } from './sphere-sweep.js';
export {
  PhysicsSimulation,
  PhysicsSync,
  PhysicsWriteback as PhysicsWritebackPhase,
} from './system-order';
export { PhysicsSet } from './system-set.js';
export { createTerrainHeightfieldSync, type TerrainColliderOwner } from './terrain-heightfield.js';
export type { PhysicsWasmHost } from './wasm-host.js';
