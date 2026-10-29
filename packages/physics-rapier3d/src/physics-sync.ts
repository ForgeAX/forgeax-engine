import type { Component, EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
import { readRenderArrayView, type StateProjection } from '@forgeax/engine-ecs/projection';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  type ColliderData,
  type ColliderSnapshot,
  CollidingEntities,
  PhysicsSet,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
  snapshotCollider,
} from '@forgeax/engine-physics';
import { ChildOf } from '@forgeax/engine-scene';
import type { RapierPhysicsWorld3D } from './rapier-physics-world-3d.js';

export interface PhysicsTransform3D {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly scale: { readonly x: number; readonly y: number; readonly z: number };
}

export interface PhysicsSyncQueryRow {
  readonly entity: EntityHandle;
  has(component: Component): boolean;
  get(component: Component): Record<string, unknown> | undefined;
}

export interface PhysicsSyncQuery extends Iterable<PhysicsSyncQueryRow> {
  at(entity: EntityHandle): PhysicsSyncQueryRow | undefined;
}

export interface PhysicsSyncState {
  readonly world: World;
  readonly transformComponent: Component;
  readonly globalTransformComponent: Component;
  readonly queries: readonly PhysicsSyncQuery[];
  readonly projection: StateProjection;
  readonly accepted: Map<number, PhysicsSyncDescriptor>;
}

export interface PhysicsSyncDescriptor {
  readonly entity: EntityHandle;
  readonly transform: PhysicsTransform3D;
  readonly rigidBody: {
    readonly type: number;
    readonly mass: number;
    readonly linearDamping: number;
    readonly angularDamping: number;
    readonly gravityScale: number;
    readonly ccdEnabled: number;
    readonly lockRotation?: boolean;
    readonly additionalSolverIterations?: number;
  };
  readonly collider: ColliderSnapshot | undefined;
  readonly hasCharacterController: boolean;
  readonly characterControllerOffset: number | undefined;
}

export function samePhysicsValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === undefined ||
    right === undefined ||
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => samePhysicsValue(a[key], b[key]))
  );
}

/** Four Float32 epsilons enclose matrix decomposition noise, relative to committed geometry. */
export function sameColliderScale(
  left: PhysicsTransform3D['scale'] | undefined,
  right: PhysicsTransform3D['scale'],
): boolean {
  return (
    left !== undefined &&
    (['x', 'y', 'z'] as const).every((axis) => {
      const a = Math.abs(left[axis]),
        b = Math.abs(right[axis]);
      return Math.abs(a - b) <= Math.max(a, b) * 2 ** -21;
    })
  );
}

function hasReadableWorldPose(world: ArrayLike<number> | undefined): world is ArrayLike<number> {
  return world !== undefined && world.length >= 16;
}

/** dt upper bound (plan-strategy D-4): skip step if dt exceeds this. */
export const PHYSICS_DT_MAX = 0.1;
const poseScratchPosition = vec3.create();
const poseScratchRotation = quat.create();
const poseScratchScale = vec3.create();
const poseScratchWorld = new Float32Array(16);

export function physicsRowIsStatic(row: PhysicsSyncQueryRow): boolean {
  if (!row.has(RigidBody)) return true;
  const rigidBody = row.get(RigidBody) as { readonly type: number } | undefined;
  return rigidBody !== undefined && rigidBodyTypeFromF32(rigidBody.type) === 'static';
}

function readPhysicsTransform(
  row: PhysicsSyncQueryRow,
  state: PhysicsSyncState,
): PhysicsTransform3D | undefined {
  // Root TRS is already world-space; a parented row consumes Scene's matrix.
  const worldPose = row.has(ChildOf)
    ? readRenderArrayView(state.world, row.entity, state.globalTransformComponent, 'world')
    : undefined;
  let position: ArrayLike<number> | undefined;
  let rotation: ArrayLike<number> | undefined;
  let scale: ArrayLike<number> | undefined;
  if (hasReadableWorldPose(worldPose)) {
    poseScratchWorld.set(worldPose);
    mat4.decompose(poseScratchPosition, poseScratchRotation, poseScratchScale, poseScratchWorld);
    position = poseScratchPosition;
    rotation = poseScratchRotation;
    scale = poseScratchScale;
  } else {
    position = readRenderArrayView(state.world, row.entity, state.transformComponent, 'pos');
    rotation = readRenderArrayView(state.world, row.entity, state.transformComponent, 'quat');
    scale = readRenderArrayView(state.world, row.entity, state.transformComponent, 'scale');
  }
  if (position === undefined || rotation === undefined || scale === undefined) return undefined;
  return {
    position: { x: position[0] ?? 0, y: position[1] ?? 0, z: position[2] ?? 0 },
    rotation: {
      x: rotation[0] ?? 0,
      y: rotation[1] ?? 0,
      z: rotation[2] ?? 0,
      w: rotation[3] ?? 1,
    },
    scale: { x: scale[0] ?? 1, y: scale[1] ?? 1, z: scale[2] ?? 1 },
  };
}

function readRigidBodyConfig(
  row: PhysicsSyncQueryRow,
  state: PhysicsSyncState,
  previous: PhysicsSyncDescriptor | undefined,
): PhysicsSyncDescriptor['rigidBody'] {
  // Membership is separate from surviving-value evidence: removals are structural.
  if (row.has(RigidBody)) {
    if (previous !== undefined && !state.projection.changed(row.entity, RigidBody))
      return previous.rigidBody;
    const data = row.get(RigidBody) as
      | {
          readonly type: number;
          readonly mass: number;
          readonly linearDamping: number;
          readonly angularDamping: number;
          readonly gravityScale: number;
          readonly ccdEnabled: number | boolean;
          readonly lockRotation?: boolean;
          readonly additionalSolverIterations?: number;
        }
      | undefined;
    if (data !== undefined)
      return {
        type: data.type,
        mass: data.mass,
        linearDamping: data.linearDamping,
        angularDamping: data.angularDamping,
        gravityScale: data.gravityScale,
        ccdEnabled: Number(data.ccdEnabled),
        lockRotation: Boolean(data.lockRotation),
        additionalSolverIterations: data.additionalSolverIterations ?? 0,
      };
  }
  return {
    type: RigidBodyTypeValue.static,
    mass: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccdEnabled: 0,
    lockRotation: false,
  };
}

function readColliderConfig(
  row: PhysicsSyncQueryRow,
  state: PhysicsSyncState,
  previous: PhysicsSyncDescriptor | undefined,
): ColliderSnapshot | undefined {
  if (!row.has(Collider)) return undefined;
  if (previous?.collider !== undefined && !state.projection.changed(row.entity, Collider))
    return previous.collider;
  const data = row.get(Collider) as ColliderData | undefined;
  return data === undefined ? undefined : snapshotCollider(data);
}

function readCharacterControllerOffset(
  row: PhysicsSyncQueryRow,
  state: PhysicsSyncState,
  previous: PhysicsSyncDescriptor | undefined,
): number | undefined {
  if (
    previous?.hasCharacterController === true &&
    !state.projection.changed(row.entity, CharacterController)
  )
    return previous.characterControllerOffset;
  return (row.get(CharacterController) as { readonly offset: number } | undefined)?.offset;
}

export function readPhysicsSyncDescriptor(
  row: PhysicsSyncQueryRow,
  state: PhysicsSyncState,
  previous: PhysicsSyncDescriptor | undefined,
): PhysicsSyncDescriptor | undefined {
  if (!row.has(Collider) && !row.has(RigidBody)) return undefined;
  const transform = readPhysicsTransform(row, state);
  if (transform === undefined) return undefined;
  const hasCharacterController = row.has(CharacterController);
  return {
    entity: row.entity,
    transform,
    rigidBody: readRigidBodyConfig(row, state, previous),
    collider: readColliderConfig(row, state, previous),
    hasCharacterController,
    characterControllerOffset: hasCharacterController
      ? readCharacterControllerOffset(row, state, previous)
      : undefined,
  };
}

// ── System name constants ──
const PHYSICS_SYNC_BACKEND = 'physicsSyncBackend' as const;
const PHYSICS_STEP_SIMULATION = 'physicsStepSimulation' as const;
const PHYSICS_WRITEBACK = 'physicsWriteback' as const;
const PHYSICS_COLLISION_SYNC = 'physicsCollisionSync' as const;

/**
 * Resolve the runtime `Transform` component token from the World-local ECS
 * registry (M2 — full resource-ification, D-3). physics already depends on
 * `@forgeax/engine-ecs`, so the catalog introduces no new dependency
 * and replaces the closure-captured `transformComponent` second parameter.
 * Returns `undefined` when Transform is not yet defined (the runtime package
 * defines it on import); callers early-out.
 */
function resolveTransform(world: World): Component | undefined {
  return world.components.resolve('Transform');
}

/**
 * `physicsSyncBackend` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms, bootstrap/recovery performs one complete Collider
 * reconcile. Warm ticks poll the existing ECS projection and identity-read only
 * final changed rows. Bare Colliders remain implicit static bodies; Transform-less
 * fixed bodies are retained only as a migration defense and are never created.
 * Reads `world` from its first parameter; resolves Transform via the global
 * registry. Labelled `'physics'`.
 */
export const PhysicsSyncBackend: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_SYNC_BACKEND,
  queries: [],
  after: ['propagateTransformsFixed'],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    const globalTransformComponent = world.components.resolve('GlobalTransform');
    if (transformComponent === undefined || globalTransformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    pw._syncFromEcs(world, transformComponent, globalTransformComponent);
  },
});

/**
 * `physicsStepSimulation` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend — read FixedTime.delta and call pw.step() with dt-gating.
 */
export const PhysicsStepSimulation: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_STEP_SIMULATION,
  queries: [],
  after: [PHYSICS_SYNC_BACKEND],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const dt = world.getResource(FixedTime).delta;
    if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal delta

    pw.step(dt);
  },
});

/**
 * `physicsWriteback` system token (M2 — full resource-ification, D-4).
 *
 * After physicsStepSimulation — call pw.writebackDynamicBodies() and write
 * positions back to ECS Transform (resolved via the global registry, D-3).
 */
export const PhysicsWriteback: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_WRITEBACK,
  queries: [],
  after: [PHYSICS_STEP_SIMULATION],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const results = pw.writebackDynamicBodies();
    for (const r of results) {
      const entity = r.entity as EntityHandle;
      const pos = [r.pos.x, r.pos.y, r.pos.z];
      const quat = [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w];
      if (transformPoseEquals(world, entity, transformComponent, pos, quat)) continue;
      world.set(entity, transformComponent, { pos, quat });
    }
  },
});

/**
 * Skipping a bit-identical write keeps an unchanged pose out of `changed`
 * filters, so downstream transform propagation stays O(moving bodies).
 */
function transformPoseEquals(
  world: World,
  entity: EntityHandle,
  transform: Component,
  pos: readonly number[],
  quat: readonly number[],
): boolean {
  return (
    f32ArrayEquals(readRenderArrayView(world, entity, transform, 'pos'), pos) &&
    f32ArrayEquals(readRenderArrayView(world, entity, transform, 'quat'), quat)
  );
}

function f32ArrayEquals(stored: ArrayLike<number> | undefined, next: readonly number[]): boolean {
  if (stored === undefined || stored.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (stored[index] !== Math.fround(next[index] as number)) return false;
  }
  return true;
}

/**
 * `physicsCollisionSync` system token — writes the drained overlap set into each
 * entity's `CollidingEntities` component (the contact/sensor set-query path).
 *
 * Runs after writeback so the component reflects this step's contacts. Without
 * it the `CollidingEntities` component documented in the physics README never
 * updates (the event queue was drained-on-overflow only), so sensor pickup +
 * proximity queries silently saw an empty set.
 */
export const PhysicsCollisionSync: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_COLLISION_SYNC,
  queries: [],
  after: [PHYSICS_WRITEBACK],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }
    pw.writebackCollidingEntities(world, CollidingEntities as unknown as Component);
    pw.finalizeDerivedFixedStep();
  },
});

/**
 * Register the physics tick systems into an ECS World.
 *
 * The systems ({@link PhysicsSyncBackend} / {@link PhysicsStepSimulation} /
 * {@link PhysicsWriteback} / {@link PhysicsCollisionSync}) are module-level
 * `defineSystem` tokens; this helper wires the moveAndSlide context + despawn
 * cleanup hook, then adds the tokens to the schedule.
 *
 * Transform is resolved from the World-local ECS component catalog,
 * D-3) — the previous `transformComponent` second parameter was redundant once
 * the system fns and moveContext resolve Transform themselves, so it is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems(world: World): () => void {
  const releaseComponents = registerPhysicsComponents(world);
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform(world);
  try {
    const pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent);
    }
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world
    .addSystems(FixedUpdate, PhysicsSet, [
      PhysicsSyncBackend,
      PhysicsStepSimulation,
      PhysicsWriteback,
      PhysicsCollisionSync,
    ])
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, PHYSICS_COLLISION_SYNC);
    world.removeSystem(FixedUpdate, PHYSICS_WRITEBACK);
    world.removeSystem(FixedUpdate, PHYSICS_STEP_SIMULATION);
    world.removeSystem(FixedUpdate, PHYSICS_SYNC_BACKEND);
    try {
      world.getResource<RapierPhysicsWorld3D>('PhysicsWorld').clearEcsContext(world);
    } catch {
      // PhysicsWorld may already have been removed as part of outer teardown.
    }
    releaseComponents();
  };
}
