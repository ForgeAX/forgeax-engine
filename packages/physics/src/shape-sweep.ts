import { err, ok, type Result } from '@forgeax/engine-types';
import type { PhysicsQuaternion, PhysicsVector } from './derived-physics.js';
import { finitePhysicsVector, unitPhysicsQuaternion } from './managed-joints.js';
import {
  PhysicsQueryError,
  type PhysicsQueryFailure,
  type PhysicsSweepQuery,
  validatePhysicsSweepQuery,
} from './shape-query.js';

/** Convex primitive geometry in local axes; capsule/cylinder use the local Y axis. */
export type SweepShape =
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'cuboid'; readonly halfExtents: PhysicsVector }
  | { readonly kind: 'capsule'; readonly radius: number; readonly halfHeight: number }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly halfHeight: number };
export interface ShapeSweepQuery extends PhysicsSweepQuery {
  readonly shape: SweepShape;
  /** Unit world-space orientation; omitted means identity. */
  readonly rotation?: PhysicsQuaternion;
}
export function validateShapeSweepQuery(input: ShapeSweepQuery): Result<void, PhysicsQueryFailure> {
  const common = validatePhysicsSweepQuery(input);
  if (!common.ok) return common;
  if (input.rotation !== undefined && !unitPhysicsQuaternion(input.rotation))
    return err(
      new PhysicsQueryError('physics-query-invalid', {
        field: 'rotation',
        reason: 'finite unit world-space quaternion required',
      }),
    );
  const invalid = () =>
    err(
      new PhysicsQueryError('physics-query-invalid', {
        field: 'shape',
        reason: 'supported convex primitive with finite float32 dimensions required',
      }),
    );
  const shape = input.shape;
  const positive = (value: number) =>
    Number.isFinite(value) && Number.isFinite(Math.fround(value)) && Math.fround(value) > 0;
  if (!shape || typeof shape !== 'object') return invalid();
  switch (shape.kind) {
    case 'sphere':
      if (!positive(shape.radius)) return invalid();
      break;
    case 'cuboid':
      if (!finitePhysicsVector(shape.halfExtents, 3) || !shape.halfExtents.every(positive))
        return invalid();
      break;
    case 'capsule':
      if (
        !positive(shape.radius) ||
        !Number.isFinite(shape.halfHeight) ||
        !Number.isFinite(Math.fround(shape.halfHeight)) ||
        shape.halfHeight < 0
      )
        return invalid();
      break;
    case 'cylinder':
      if (!positive(shape.radius) || !positive(shape.halfHeight)) return invalid();
      break;
    default:
      return invalid();
  }
  return ok(undefined);
}
