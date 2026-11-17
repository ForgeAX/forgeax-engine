import { err, ok, type Result } from '@forgeax/engine-types';
import type { PhysicsVector } from './derived-physics.js';
import {
  PhysicsQueryError,
  type PhysicsQueryFailure,
  type PhysicsSweepQuery,
  validatePhysicsSweepQuery,
} from './shape-query.js';

/** A finite displacement over the current synchronized 3D collider state. */
export interface SphereSweepQuery extends PhysicsSweepQuery {
  readonly radius: number;
}
export interface SphereSweepContact {
  readonly entity: number;
  /** World-space witness on the target collider, not the moving sphere. */
  readonly point: PhysicsVector;
  readonly normal: PhysicsVector;
  /** Displacement fraction in [0, 1]; initial overlap can return zero. */
  readonly fraction: number;
}
export interface SphereSweepResult {
  /** Native body contacts at the first impact pose; each entity occurs once.
   * A stationary query returns its current overlaps with fraction zero. */
  readonly hits: readonly SphereSweepContact[];
  /** Another eligible contact exists at that pose beyond the maxHits budget. */
  readonly truncated: boolean;
}
export function validateSphereSweepQuery(
  input: SphereSweepQuery,
): Result<void, PhysicsQueryFailure> {
  const invalid = (field: keyof SphereSweepQuery | 'query', reason: string) =>
    err(new PhysicsQueryError('physics-query-invalid', { field, reason }));
  const common = validatePhysicsSweepQuery(input);
  if (!common.ok) return common;
  if (
    !Number.isFinite(input.radius) ||
    !Number.isFinite(Math.fround(input.radius)) ||
    Math.fround(input.radius) <= 0
  )
    return invalid('radius', 'positive finite float32 radius required');
  return ok(undefined);
}
