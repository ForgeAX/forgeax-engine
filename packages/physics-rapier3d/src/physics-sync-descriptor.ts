import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView, type StateProjection } from '@forgeax/engine-ecs/projection';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  type ColliderData,
  type ColliderSnapshot,
  RigidBody,
  RigidBodyTypeValue,
  rigidBodyTypeFromF32,
  snapshotCollider,
} from '@forgeax/engine-physics';
import { ChildOf } from '@forgeax/engine-scene';

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
