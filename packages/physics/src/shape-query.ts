import { err, ok, type Result } from '@forgeax/engine-types';
import type { PhysicsVector } from './derived-physics.js';
import { finitePhysicsVector } from './managed-joints.js';

/** Shared read-only 3D volume query policy. Motion is a finite displacement. */
export interface PhysicsSweepQuery {
  readonly origin: PhysicsVector;
  readonly motion: PhysicsVector;
  readonly maxHits: number;
  readonly filterMask?: number;
  readonly excludeEntities?: readonly number[];
  /** Native queries include sensors by default. */
  readonly includeSensors?: boolean;
  /** Moving casts can ignore bodies overlapping the initial pose. Stationary
   * queries always report current overlaps. Omission means report. */
  readonly initialOverlap?: 'report' | 'ignore';
}
export interface ShapeSweepContact {
  readonly entity: number;
  /** Detached world-space witness and outward normal on the target collider. */
  readonly point: PhysicsVector;
  readonly normal: PhysicsVector;
  readonly fraction: number;
}
export interface ShapeSweepResult {
  /** First-impact batch, with each body entity occurring once. A stationary
   * query returns current overlaps at fraction zero. */
  readonly hits: readonly ShapeSweepContact[];
  readonly truncated: boolean;
}
export type PhysicsQueryField = keyof PhysicsSweepQuery | 'radius' | 'shape' | 'rotation' | 'query';
interface PhysicsQueryDetails {
  'physics-query-invalid': { readonly field: PhysicsQueryField; readonly reason: string };
  'physics-query-unavailable': { readonly reason: string };
  'physics-query-failed': { readonly reason: string };
}
export type PhysicsQueryErrorCode = keyof PhysicsQueryDetails;
export type PhysicsQueryFailure = {
  [Code in PhysicsQueryErrorCode]: PhysicsQueryError<Code>;
}[PhysicsQueryErrorCode];
export class PhysicsQueryError<
  Code extends PhysicsQueryErrorCode = PhysicsQueryErrorCode,
> extends Error {
  override readonly name = 'PhysicsQueryError';
  readonly expected = 'a healthy synchronized physics state and finite native shape-query inputs';
  readonly hint =
    'inspect detail; repair the query or finish/recover the physics state before querying';
  constructor(
    readonly code: Code,
    readonly detail: PhysicsQueryDetails[Code],
  ) {
    super(`[${code}] ${detail.reason}`);
  }
}
export function validatePhysicsSweepQuery(
  input: PhysicsSweepQuery,
): Result<void, PhysicsQueryFailure> {
  const invalid = (field: PhysicsQueryField, reason: string) =>
    err(new PhysicsQueryError('physics-query-invalid', { field, reason }));
  if (!input || typeof input !== 'object') return invalid('query', 'query object required');
  if (!finitePhysicsVector(input.origin, 3))
    return invalid('origin', 'finite float32 origin required');
  if (!finitePhysicsVector(input.motion, 3))
    return invalid('motion', 'finite float32 displacement required');
  if (!Number.isSafeInteger(input.maxHits) || input.maxHits < 1)
    return invalid('maxHits', 'positive safe integer contact budget required');
  if (
    input.filterMask !== undefined &&
    (!Number.isInteger(input.filterMask) || input.filterMask < 0 || input.filterMask > 0xffffffff)
  )
    return invalid('filterMask', 'unsigned packed 32-bit interaction groups required');
  if (
    input.excludeEntities !== undefined &&
    (!Array.isArray(input.excludeEntities) ||
      input.excludeEntities.some((entity) => !Number.isSafeInteger(entity) || entity < 0))
  )
    return invalid('excludeEntities', 'finite non-negative entity identities required');
  if (input.includeSensors !== undefined && typeof input.includeSensors !== 'boolean')
    return invalid('includeSensors', 'boolean sensor policy required');
  if (
    input.initialOverlap !== undefined &&
    input.initialOverlap !== 'report' &&
    input.initialOverlap !== 'ignore'
  )
    return invalid('initialOverlap', 'report or ignore initial-overlap policy required');
  return ok(undefined);
}
