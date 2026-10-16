import { err, ok, type Result } from '@forgeax/engine-types';
import type { PhysicsQuaternion, PhysicsVector } from './derived-physics.js';

/** Ordinary body constraints; no derived geometry publication dependency. */
export type ManagedJointInput = {
  readonly bodyA: number;
  readonly bodyB: number;
  readonly anchorA: PhysicsVector;
  readonly anchorB: PhysicsVector;
  readonly contactsEnabled?: boolean;
} & (
  | {
      readonly kind: 'hinge';
      readonly axisA: PhysicsVector;
      readonly axisB: PhysicsVector;
      readonly limits: readonly [number, number];
    }
  | {
      readonly kind: 'fixed';
      readonly frameA: PhysicsQuaternion;
      readonly frameB: PhysicsQuaternion;
    }
);

export interface ManagedJointBinding {
  /** Idempotent lease release; no native handle escapes the backend. */
  dispose(): void;
}

export interface BodyMotion {
  readonly position: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly linearVelocity: PhysicsVector;
  readonly angularVelocity: PhysicsVector;
  readonly sleeping: boolean;
}

interface ManagedPhysicsDetails {
  'managed-joint-invalid': { readonly index: number; readonly reason: string };
  'managed-body-missing': { readonly entity: number };
  'managed-physics-unavailable': { readonly reason: string };
  'managed-physics-failed': {
    readonly reason: string;
    readonly recovery: 'old-state-retained' | 'rebuild-required';
  };
}
export type ManagedPhysicsErrorCode = keyof ManagedPhysicsDetails;
export type ManagedPhysicsFailure = {
  [Code in ManagedPhysicsErrorCode]: ManagedPhysicsError<Code>;
}[ManagedPhysicsErrorCode];

export class ManagedPhysicsError<
  Code extends ManagedPhysicsErrorCode = ManagedPhysicsErrorCode,
> extends Error {
  override readonly name = 'ManagedPhysicsError';
  readonly expected = 'live ordinary physics bodies and bounded finite joint or motion input';
  readonly hint = 'inspect detail; repair the rig input or rebuild the PhysicsWorld when required';
  constructor(
    readonly code: Code,
    readonly detail: ManagedPhysicsDetails[Code],
  ) {
    super(`[${code}] ${'reason' in detail ? detail.reason : 'body is unavailable'}`);
  }
}

export function finitePhysicsVector(value: readonly number[], size: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === size &&
    value.every((n) => Number.isFinite(n) && Number.isFinite(Math.fround(n)))
  );
}

export function unitPhysicsQuaternion(value: readonly number[]): boolean {
  return finitePhysicsVector(value, 4) && Math.abs(Math.hypot(...value) - 1) <= 1e-4;
}

export function validateManagedJoints(
  inputs: readonly ManagedJointInput[],
): Result<void, ManagedPhysicsFailure> {
  const invalid = (index: number, reason: string) =>
    err(new ManagedPhysicsError('managed-joint-invalid', { index, reason }));
  if (!Array.isArray(inputs) || inputs.length > 256)
    return invalid(-1, 'joint group must be an array of at most 256 joints');
  const pairs = new Set<string>();
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index] as ManagedJointInput;
    if (!input || typeof input !== 'object') return invalid(index, 'joint must be a JSON object');
    const pair = [input.bodyA, input.bodyB].sort((a, b) => a - b).join(':');
    const common =
      Number.isSafeInteger(input.bodyA) &&
      Number.isSafeInteger(input.bodyB) &&
      input.bodyA >= 0 &&
      input.bodyB >= 0 &&
      input.bodyA !== input.bodyB &&
      !pairs.has(pair) &&
      finitePhysicsVector(input.anchorA, 3) &&
      finitePhysicsVector(input.anchorB, 3) &&
      (input.contactsEnabled === undefined || typeof input.contactsEnabled === 'boolean');
    const shape =
      input.kind === 'hinge'
        ? finitePhysicsVector(input.axisA, 3) &&
          finitePhysicsVector(input.axisB, 3) &&
          Math.abs(Math.hypot(...input.axisA) - 1) < 1e-4 &&
          Math.abs(Math.hypot(...input.axisB) - 1) < 1e-4 &&
          finitePhysicsVector(input.limits, 2) &&
          input.limits[0] >= -Math.PI &&
          input.limits[1] <= Math.PI &&
          input.limits[0] <= input.limits[1]
        : input.kind === 'fixed' &&
          unitPhysicsQuaternion(input.frameA) &&
          unitPhysicsQuaternion(input.frameB);
    if (!common || !shape)
      return invalid(
        index,
        'distinct body pair, finite anchors, unit frames/axes, ordered radian limits and boolean contact flag required',
      );
    pairs.add(pair);
  }
  return ok(undefined);
}
