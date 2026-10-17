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
  COLLIDER_SHAPE_CAPSULE,
  COLLIDER_SHAPE_CUBOID,
  COLLIDER_SHAPE_SPHERE,
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  colliderShapeFromF32,
  RIGID_BODY_TYPE_DYNAMIC,
  RIGID_BODY_TYPE_KINEMATIC,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
  snapshotCollider,
  validateAdditionalSolverIterations,
} from './components.js';
export type { PhysicsContactManifold, PhysicsContactSnapshot } from './contact-query.js';
export type {
  ConvexCompoundShapeInput,
  DerivedBodyTypeCandidateInput,
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
export type { PhysicsBackend } from './plugin-factory.js';
export { physicsComponentsPlugin, physicsPlugin } from './plugin-factory.js';
export { PhysicsSet } from './system-set.js';
export { syncTerrainHeightfields } from './terrain-heightfield.js';
export type { PhysicsWasmHost } from './wasm-host.js';
