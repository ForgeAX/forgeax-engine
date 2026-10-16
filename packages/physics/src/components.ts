// @forgeax/engine-physics — ECS Component schemas.
//
// RigidBody and Collider are the two user-facing entry points; AI users
// spawn entities with these components to opt into physics simulation.
// CollidingEntities is the runtime set-query component for continuous
// collision status (started/stopped model, no 'continued' event).

import {
  type Component,
  defineComponent,
  type SchemaOf,
  type ShapeOf,
  type World,
} from '@forgeax/engine-ecs';
import { TransformInterpolation } from '@forgeax/engine-scene';
import type { PhysicsVector } from './derived-physics.js';
import { PhysicsError } from './errors.js';

/**
 * RigidBody motion type — 3-state discriminant mirroring Rapier's
 * Dynamic / Fixed / KinematicPositionBased triplet.
 *
 * `'static'`: infinite mass, never moves (Rapier Fixed).
 * `'dynamic'`: driven by forces, gravity, collisions (Rapier Dynamic).
 * `'kinematic'`: user-controlled position, velocity derived by engine
 *                (Rapier KinematicPositionBased).
 */
export type RigidBodyType = 'static' | 'dynamic' | 'kinematic';

/**
 * Collider shape discriminant — 3 AI-friendly shape names.
 *
 * `'cuboid'`: box shape defined by half-extents (x, y, z).
 * `'sphere'`: sphere defined by radius.
 * `'capsule'`: capsule defined by half-height + radius.
 *
 * Named `'sphere'` not `'ball'` per plan-strategy D-5: AI users see
 * the familiar geometric term; backend maps to Rapier `ColliderDesc.ball()`.
 */
export type ColliderShape = keyof typeof ColliderShapeValue;

// ─── D-3: numeric enum constants + narrowing helpers ─────────────────────
//
// Aligned with `packages/runtime/src/components/camera.ts:41-53`
// `cameraProjectionFromF32` pattern. The ECS `enum` field maps to `number`
// (Uint32Array column); these constants let AI users write
// `{ type: RigidBodyTypeValue.dynamic }` instead of bare magic numbers,
// and the narrowing helpers let backends switch cleanly on the string union.
//
// Declared BEFORE the RigidBody / Collider components so each component's enum
// field descriptor can reference the SAME `*Value` map as its `labels`
// (Derive, don't Duplicate — one object is both the AI-facing const AND the
// schema-projected label map that `describeComponent` surfaces).

/** Numeric value for static rigid body (Rapier Fixed). */
export const RIGID_BODY_TYPE_STATIC = 0;
/** Numeric value for dynamic rigid body (Rapier Dynamic). */
export const RIGID_BODY_TYPE_DYNAMIC = 1;
/** Numeric value for kinematic rigid body (Rapier KinematicPositionBased). */
export const RIGID_BODY_TYPE_KINEMATIC = 2;

export const RigidBodyTypeValue = {
  static: RIGID_BODY_TYPE_STATIC,
  dynamic: RIGID_BODY_TYPE_DYNAMIC,
  kinematic: RIGID_BODY_TYPE_KINEMATIC,
} as const;

export function rigidBodyTypeFromF32(n: number): RigidBodyType {
  if (n === RIGID_BODY_TYPE_DYNAMIC) return 'dynamic';
  if (n === RIGID_BODY_TYPE_KINEMATIC) return 'kinematic';
  return 'static';
}

/** Numeric value for cuboid collider shape. */
export const COLLIDER_SHAPE_CUBOID = 0;
/** Numeric value for sphere collider shape. */
export const COLLIDER_SHAPE_SPHERE = 1;
/** Numeric value for capsule collider shape. */
export const COLLIDER_SHAPE_CAPSULE = 2;

export const ColliderShapeValue = {
  cuboid: COLLIDER_SHAPE_CUBOID,
  sphere: COLLIDER_SHAPE_SPHERE,
  capsule: COLLIDER_SHAPE_CAPSULE,
  cylinder: 3,
  cone: 4,
  convexHull: 5,
  trimesh: 6,
} as const;

export function colliderShapeFromF32(n: number): ColliderShape {
  if (n === ColliderShapeValue.cylinder) return 'cylinder';
  if (n === ColliderShapeValue.cone) return 'cone';
  if (n === ColliderShapeValue.convexHull) return 'convexHull';
  if (n === ColliderShapeValue.trimesh) return 'trimesh';
  if (n === COLLIDER_SHAPE_SPHERE) return 'sphere';
  if (n === COLLIDER_SHAPE_CAPSULE) return 'capsule';
  return 'cuboid';
}

/**
 * ECS Component: rigid body physics properties.
 *
 * AI user entry point — spawn with `world.spawn(RigidBody({ type: 'dynamic' }))`
 * to opt an entity into physics simulation.
 *
 * | Field | Type | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `type` | `RigidBodyType` | `'dynamic'` | Motion type discriminant |
 * | `mass` | `number` | `1.0` | Linear mass (> 0 for dynamic) |
 * | `linearDamping` | `number` | `0.0` | Velocity damping factor [0, 1] |
 * | `angularDamping` | `number` | `0.0` | Angular velocity damping [0, 1] |
 * | `gravityScale` | `number` | `1.0` | Per-body gravity multiplier |
 * | `ccdEnabled` | `boolean` | `false` | Continuous collision detection |
 *
 * `type` declares `labels: RigidBodyTypeValue` so `describeComponent` projects
 * the `static=0 / dynamic=1 / kinematic=2` map through the front door — an AI
 * learns the legal variants from the schema, not from engine source.
 */
export const RigidBody = defineComponent(
  'RigidBody',
  {
    type: { type: 'enum', default: RIGID_BODY_TYPE_DYNAMIC, labels: RigidBodyTypeValue },
    mass: { type: 'f32', default: 1 },
    linearDamping: { type: 'f32', default: 0 },
    angularDamping: { type: 'f32', default: 0 },
    gravityScale: { type: 'f32', default: 1 },
    ccdEnabled: { type: 'bool', default: false },
    additionalSolverIterations: { type: 'u32', default: 0 },
  },
  { requires: [TransformInterpolation] },
);

/**
 * ECS Component: collision geometry.
 *
 * Spawn alongside RigidBody to give an entity a collision shape. Entities
 * with Collider but no RigidBody are treated as static colliders (Rapier
 * native behavior — collider without parent body is fixed): `physicsSyncBackend`
 * synthesizes an implicit static body for them, so a bare-Collider floor/wall is
 * simulated as immovable level geometry — the natural way to author static
 * scenery without a redundant `RigidBody{static}`.
 *
 * | Field | Type | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `shape` | `ColliderShape` | — | Shape discriminant |
 * | `halfExtents` | `[number, number, number]` | `[0.5, 0.5, 0.5]` | Cuboid half-width/height/depth |
 * | `mesh` | `shared<MeshAsset>` | `0` | Cooked source for convexHull / trimesh |
 * | `radius` | `number` | `0.5` | Sphere / capsule / cylinder / cone radius |
 * | `halfHeight` | `number` | `0.5` | Capsule / cylinder / cone half-height |
 * | `friction` | `number` | `0.5` | Coulomb friction coefficient |
 * | `restitution` | `number` | `0.0` | Elasticity (1.0 = perfect bounce) |
 * | `density` | `number` | `1.0` | Mass density (alternative to mass) |
 * | `isSensor` | `bool` | `false` | Sensor mode (detect, no physical response) |
 * | `collisionGroups` | `u32` | `0x0001_FFFF` | 32-bit packed membership/filter |
 * | `solverGroups` | `u32` | `0xFFFF_FFFF` | 32-bit packed constraint groups |
 */
export const Collider = defineComponent('Collider', {
  shape: { type: 'enum', default: COLLIDER_SHAPE_CUBOID, labels: ColliderShapeValue },
  /** ConvexHull/trimesh resolve this ordinary mesh asset; slot zero is unbound. */
  mesh: { type: 'shared<MeshAsset>' },
  // feat-20260709 M4: cuboid half-extents collapsed from 3 per-axis scalar
  // columns into one inline array<f32,3> column. Explicit layer-2 default
  // (the array layer-3 fallback is all-zero, which would give a degenerate
  // zero-size box). radius/halfHeight stay scalar (OOS-1: independent
  // sphere/capsule params, not part of the cuboid vec).
  halfExtents: { type: 'array<f32, 3>', default: new Float32Array([0.5, 0.5, 0.5]) },
  radius: { type: 'f32', default: 0.5 },
  halfHeight: { type: 'f32', default: 0.5 },
  friction: { type: 'f32', default: 0.5 },
  restitution: { type: 'f32', default: 0 },
  density: { type: 'f32', default: 1 },
  isSensor: { type: 'bool', default: false },
  collisionGroups: { type: 'u32', default: 0x0001_ffff },
  solverGroups: { type: 'u32', default: 0xffff_ffff },
});

/** Read-side row of {@link Collider}; `halfExtents` is a zero-copy view into World storage. */
export type ColliderData = ShapeOf<SchemaOf<typeof Collider>>;

/** Owned copy of a {@link Collider} row that a physics backend may retain across frames. */
export type ColliderSnapshot = Readonly<Omit<ColliderData, 'halfExtents'>> & {
  readonly halfExtents: PhysicsVector;
};

export function snapshotCollider(data: ColliderData): ColliderSnapshot {
  return {
    ...data,
    halfExtents: [data.halfExtents[0] ?? 0, data.halfExtents[1] ?? 0, data.halfExtents[2] ?? 0],
  };
}

/**
 * ECS Component: kinematic character controller tuning + output state.
 *
 * Spawn alongside a `RigidBody({ type: 'kinematic' })` + `Collider` to opt an
 * entity into collision-aware movement via `PhysicsWorld.moveAndSlide`. The
 * tuning fields are stable character properties; `grounded` is written back by
 * the engine after each `moveAndSlide` (game code reads it, never writes it).
 *
 * All fields are flat scalars in engine units (degrees, world-space distance) —
 * no Rapier types leak through. Slope angles use the `Deg` suffix to make the
 * unit explicit; the backend translates degrees to radians. A single field
 * carries both the on/off switch and the value: `autoStepMaxHeight === 0`
 * disables auto-step, `snapToGroundDist === 0` disables snap-to-ground.
 *
 * 2D and 3D reuse this same component (plan-strategy D-9): every field is a
 * dimension-agnostic scalar, so no separate 2D component is needed.
 *
 * | Field | Type | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `offset` | `f32` | `0.01` | Skin thickness, prevents penetration |
 * | `maxSlopeClimbDeg` | `f32` | `45` | Max climbable slope angle (degrees) |
 * | `minSlopeSlideDeg` | `f32` | `30` | Slope angle past which sliding starts (degrees) |
 * | `autoStepMaxHeight` | `f32` | `0.3` | Max auto-step height (0 = off) |
 * | `autoStepMinWidth` | `f32` | `0.2` | Min step width to be steppable |
 * | `snapToGroundDist` | `f32` | `0.2` | Downhill ground-snap distance (0 = off) |
 * | `grounded` | `bool` | `false` | Engine-written: grounded after last move |
 */
export const CharacterController = defineComponent('CharacterController', {
  offset: { type: 'f32', default: 0.01 },
  maxSlopeClimbDeg: { type: 'f32', default: 45 },
  minSlopeSlideDeg: { type: 'f32', default: 30 },
  autoStepMaxHeight: { type: 'f32', default: 0.3 },
  autoStepMinWidth: { type: 'f32', default: 0.2 },
  snapToGroundDist: { type: 'f32', default: 0.2 },
  grounded: { type: 'bool', default: false, transient: true },
});

/** Read-side row of {@link CharacterController}; both Rapier adapters apply the same tuning. */
export type CharacterControllerData = ShapeOf<SchemaOf<typeof CharacterController>>;

/**
 * ECS Component: set of entities currently colliding with the holder entity.
 *
 * Maintained by the physics tick systems — entities are added on collision
 * start (`CollisionEvent.started`) and removed on collision stop
 * (`CollisionEvent.stopped`). AI users query this component to know whose
 * colliders overlap right now without consuming per-frame events.
 *
 * This is the `'continued'` equivalent — no repeated per-frame events,
 * one component query per frame exposes the full active contact set
 * (plan-strategy D-3: CollidingEntities set-query mode).
 */
export const CollidingEntities = defineComponent(
  'CollidingEntities',
  {
    entities: { type: 'array<entity>' },
  },
  { transient: true },
);

const PHYSICS_COMPONENTS: readonly Component[] = [
  TransformInterpolation,
  CharacterController,
  Collider,
  CollidingEntities,
  RigidBody,
];

/** Install the physics component vocabulary in a World and release its leases on teardown. */
export function registerPhysicsComponents(world: World): () => void {
  const leases = PHYSICS_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Validate bounded authored solver precision before a backend mutates native state. */
export function validateAdditionalSolverIterations(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 32)
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'additionalSolverIterations is an integer in [0,32]',
      hint: 'repair the authored RigidBody before synchronization',
      detail: { code: 'invalid-body-config', field: 'additionalSolverIterations', value },
    });
  return value;
}
