// @forgeax/engine-physics — physics interface package barrel.
//
// ECS component schemas (RigidBody / Collider / CollisionEvent),
// PhysicsWorld Resource interface, PhysicsErrorCode union.
//
// Dependencies: @forgeax/engine-ecs (Component / event token),
// @forgeax/engine-math (Vec2 / Vec3 / Quat),
// @forgeax/engine-types (type utilities).

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
  DerivedPhysicsErrorCode,
  DerivedPhysicsErrorDetail,
  DerivedPhysicsFailure,
  DerivedPhysicsMotion,
  DerivedPhysicsPublication,
  DerivedPhysicsSnapshot,
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
  VoxelShapeInput,
} from './derived-physics.js';
export {
  cloneDerivedPhysicsInput,
  DERIVED_PHYSICS_LIMITS,
  DerivedPhysicsError,
  estimateDerivedPhysicsInputBytes,
  normalizeConvexCompoundShapeInput,
  normalizeHeightfieldShapeInput,
  normalizeVoxelShapeInput,
  preserveCenterOfMassVelocity,
  validateMassProperties,
} from './derived-physics.js';
export type { PhysicsErrorCode, PhysicsErrorDetail } from './errors.js';
export { PHYSICS_ERROR_HINTS, PhysicsError } from './errors.js';
export type {
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
export type { PhysicsWorld, PhysicsWorld2D, RaycastHit, RaycastHit2D } from './physics-world.js';
export type { PhysicsPluginBackend } from './plugin-factory.js';
export { definePhysicsPlugin, physicsComponentsPlugin } from './plugin-factory.js';
export { type PhysicsOptions, validateSolverIterations } from './solver-options.js';
export { PhysicsSet } from './system-set.js';
export { createTerrainHeightfieldSync, type TerrainColliderOwner } from './terrain-heightfield.js';
export type { PhysicsWasmHost } from './wasm-host.js';
