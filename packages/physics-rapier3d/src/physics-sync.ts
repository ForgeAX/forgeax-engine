import type { Component, EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
import type { StateProjection } from '@forgeax/engine-ecs/projection';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  type ColliderData,
  type ColliderSnapshot,
  CollidingEntities,
  PhysicsSet,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
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

function hasReadableWorldPose(world: Float32Array | undefined): world is Float32Array {
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

export function readPhysicsSyncDescriptor(
  row: PhysicsSyncQueryRow,
  transformComponent: Component,
  globalTransformComponent: Component,
): PhysicsSyncDescriptor | undefined {
  const transformData = row.get(transformComponent) as
    | {
        readonly pos: Float32Array;
        readonly quat: Float32Array;
        readonly scale: Float32Array;
      }
    | undefined;
  const globalTransformData = row.get(globalTransformComponent) as
    | { readonly world: Float32Array }
    | undefined;
  const colliderData = (row.has(Collider) ? row.get(Collider) : undefined) as
    | ColliderData
    | undefined;
  if (transformData === undefined || (colliderData === undefined && !row.has(RigidBody)))
    return undefined;

  // Root-local TRS is already a world pose. A ChildOf row, however, must use
  // Scene's derived GlobalTransform world matrix. Matrix contents cannot be a
  // validity sentinel: a legitimate parent/local composition can resolve to
  // identity.
  const useWorldPose = row.has(ChildOf) && hasReadableWorldPose(globalTransformData?.world);
  if (useWorldPose) {
    poseScratchWorld.set(globalTransformData.world);
    mat4.decompose(poseScratchPosition, poseScratchRotation, poseScratchScale, poseScratchWorld);
  } else {
    poseScratchPosition[0] = transformData.pos[0] ?? 0;
    poseScratchPosition[1] = transformData.pos[1] ?? 0;
    poseScratchPosition[2] = transformData.pos[2] ?? 0;
    poseScratchRotation[0] = transformData.quat[0] ?? 0;
    poseScratchRotation[1] = transformData.quat[1] ?? 0;
    poseScratchRotation[2] = transformData.quat[2] ?? 0;
    poseScratchRotation[3] = transformData.quat[3] ?? 1;
    poseScratchScale[0] = transformData.scale[0] ?? 1;
    poseScratchScale[1] = transformData.scale[1] ?? 1;
    poseScratchScale[2] = transformData.scale[2] ?? 1;
  }

  const rigidBodyData = row.has(RigidBody)
    ? (row.get(RigidBody) as
        | {
            readonly type: number;
            readonly mass: number;
            readonly linearDamping: number;
            readonly angularDamping: number;
            readonly gravityScale: number;
            readonly ccdEnabled: number | boolean;
            readonly additionalSolverIterations?: number;
          }
        | undefined)
    : undefined;
  const characterControllerData = row.has(CharacterController)
    ? (row.get(CharacterController) as { readonly offset: number } | undefined)
    : undefined;

  return {
    entity: row.entity,
    transform: {
      position: {
        x: poseScratchPosition[0] ?? 0,
        y: poseScratchPosition[1] ?? 0,
        z: poseScratchPosition[2] ?? 0,
      },
      rotation: {
        x: poseScratchRotation[0] ?? 0,
        y: poseScratchRotation[1] ?? 0,
        z: poseScratchRotation[2] ?? 0,
        w: poseScratchRotation[3] ?? 1,
      },
      scale: {
        x: poseScratchScale[0] ?? 1,
        y: poseScratchScale[1] ?? 1,
        z: poseScratchScale[2] ?? 1,
      },
    },
    rigidBody:
      rigidBodyData === undefined
        ? {
            type: RIGID_BODY_TYPE_STATIC,
            mass: 0,
            linearDamping: 0,
            angularDamping: 0,
            gravityScale: 1,
            ccdEnabled: 0,
          }
        : {
            type: rigidBodyData.type,
            mass: rigidBodyData.mass,
            linearDamping: rigidBodyData.linearDamping,
            angularDamping: rigidBodyData.angularDamping,
            gravityScale: rigidBodyData.gravityScale,
            ccdEnabled: Number(rigidBodyData.ccdEnabled),
            additionalSolverIterations: rigidBodyData.additionalSolverIterations ?? 0,
          },
    collider: colliderData === undefined ? undefined : snapshotCollider(colliderData),
    hasCharacterController: row.has(CharacterController),
    characterControllerOffset: characterControllerData?.offset,
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
  const current = world.get(entity, transform);
  if (!current.ok) return false;
  const value = current.value as unknown as { pos?: ArrayLike<number>; quat?: ArrayLike<number> };
  return f32ArrayEquals(value.pos, pos) && f32ArrayEquals(value.quat, quat);
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
