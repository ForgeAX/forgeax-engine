import type { PhysicsQuaternion, PhysicsVector } from '@forgeax/engine-physics';
import { finitePhysicsVector, unitPhysicsQuaternion } from '@forgeax/engine-physics';
import type { AnimationTargetIdValue, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { isAnimationTargetId } from './target-id';

export interface SpringBoneChain {
  /** Contiguous joints, root first; the last joint is the tail, not a writer. */
  readonly targets: readonly AnimationTargetIdValue[];
  /** Attraction acceleration / displacement, in s^-2. */
  readonly stiffness: number;
  /** Velocity decay rate, in s^-1. */
  readonly damping: number;
  /** World-space acceleration in length units / s^2. */
  readonly gravity: PhysicsVector;
  readonly radius: number;
  /** Swing cone about the animated direction, radians. */
  readonly maxAngle: number;
  readonly collisions?: readonly {
    readonly target: AnimationTargetIdValue;
    readonly center: PhysicsVector;
    readonly radius: number;
  }[];
  readonly iterations?: number;
}

export interface PhysicalBone {
  readonly target: AnimationTargetIdValue;
  /** Bone-local body origin and orientation. */
  readonly offset: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly mass: number;
  /** Additional native solver iterations for the connected island, integer [0,32]. */
  readonly additionalSolverIterations?: number;
  readonly shape:
    | { readonly kind: 'capsule'; readonly radius: number; readonly halfHeight: number }
    | { readonly kind: 'sphere'; readonly radius: number }
    | { readonly kind: 'cuboid'; readonly halfExtents: PhysicsVector };
  readonly collisionGroups?: number;
}

export interface PhysicalBoneJoint {
  /** Indices into physical.bones, never native or ECS identities. */
  readonly bodyA: number;
  readonly bodyB: number;
  /** Body-local unscaled anchors. */
  readonly anchorA: PhysicsVector;
  readonly anchorB: PhysicsVector;
  readonly axisA: PhysicsVector;
  readonly axisB: PhysicsVector;
  readonly limits: readonly [number, number];
}

/** Save as ordinary PluginAsset configuration alongside an authored Scene rig. */
export interface SkeletalMotionDefinition {
  readonly springs?: readonly SpringBoneChain[];
  readonly physical?: {
    readonly bones: readonly PhysicalBone[];
    readonly joints: readonly PhysicalBoneJoint[];
  };
}

interface MotionErrorDetails {
  'animation-motion-invalid': { readonly reason: string };
  'animation-motion-conflict': { readonly target: string; readonly reason: string };
  'animation-motion-stale': { readonly target: string; readonly reason: string };
  'animation-motion-unavailable': { readonly reason: string };
  'animation-motion-failed': {
    readonly reason: string;
    readonly cause?: string;
    readonly recovery: 'rebind' | 'rebuild-world';
  };
}
export type SkeletalMotionErrorCode = keyof MotionErrorDetails;
export type SkeletalMotionFailure = {
  [Code in SkeletalMotionErrorCode]: SkeletalMotionError<Code>;
}[SkeletalMotionErrorCode];
export class SkeletalMotionError<
  Code extends SkeletalMotionErrorCode = SkeletalMotionErrorCode,
> extends Error {
  override readonly name = 'SkeletalMotionError';
  readonly expected =
    'bounded authored motion, stable animation targets and live uniform-scale Scene pose';
  readonly hint =
    'inspect detail; repair the authored definition or rebind the rig before retrying';
  constructor(
    readonly code: Code,
    readonly detail: MotionErrorDetails[Code],
  ) {
    super(`[${code}] ${detail.reason}`);
  }
}

function nonnegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1e6;
}
function positive(n: number): boolean {
  return nonnegative(n) && n > 0;
}
function axis(v: PhysicsVector): boolean {
  return finitePhysicsVector(v, 3) && Math.abs(Math.hypot(...v) - 1) < 1e-4;
}

/** Runtime admission also protects plain JSON callers, before entities or writes exist. */
export function validateSkeletalMotionDefinition(
  input: SkeletalMotionDefinition,
): Result<void, SkeletalMotionFailure> {
  const invalid = (reason: string) =>
    err(new SkeletalMotionError('animation-motion-invalid', { reason }));
  if (input === null || typeof input !== 'object')
    return invalid('definition must be a JSON object');
  if (input.springs !== undefined && !Array.isArray(input.springs))
    return invalid('springs must be an array');
  if (
    input.physical !== undefined &&
    (input.physical === null ||
      typeof input.physical !== 'object' ||
      !Array.isArray(input.physical.bones) ||
      !Array.isArray(input.physical.joints))
  )
    return invalid('physical requires bones and joints arrays');
  const springs = input.springs ?? [];
  const bones = input.physical?.bones ?? [];
  const joints = input.physical?.joints ?? [];
  if (
    springs.length > 1024 ||
    bones.length > 128 ||
    joints.length > 256 ||
    (springs.length === 0 && bones.length === 0)
  )
    return invalid('requires 1..1024 chains or 1..128 bodies, at most 256 joints');
  const writers = new Set<string>();
  const springTargets = new Set<string>();
  for (const chain of springs) {
    if (
      !chain ||
      typeof chain !== 'object' ||
      !Array.isArray(chain.targets) ||
      (chain.collisions !== undefined && !Array.isArray(chain.collisions))
    )
      return invalid('chain requires targets and optional collisions arrays');
    if (
      chain.targets.length < 2 ||
      chain.targets.length > 33 ||
      !nonnegative(chain.stiffness) ||
      !nonnegative(chain.damping) ||
      !finitePhysicsVector(chain.gravity, 3) ||
      !nonnegative(chain.radius) ||
      !nonnegative(chain.maxAngle) ||
      chain.maxAngle > Math.PI ||
      !Number.isInteger(chain.iterations ?? 8) ||
      (chain.iterations ?? 8) < 1 ||
      (chain.iterations ?? 8) > 16 ||
      (chain.collisions?.length ?? 0) > 32
    )
      return invalid('invalid spring parameters or capacity');
    const seen = new Set<string>();
    for (const [index, target] of chain.targets.entries()) {
      if (
        !isAnimationTargetId(target) ||
        seen.has(target) ||
        (index < chain.targets.length - 1 && writers.has(target))
      )
        return invalid('spring joints must be unique, continuous targets with exclusive writers');
      seen.add(target);
      springTargets.add(target);
      if (index < chain.targets.length - 1) writers.add(target);
    }
    for (const collision of chain.collisions ?? [])
      if (
        !collision ||
        typeof collision !== 'object' ||
        !isAnimationTargetId(collision.target) ||
        !finitePhysicsVector(collision.center, 3) ||
        !positive(collision.radius)
      )
        return invalid('sphere collision needs a stable target, finite center and positive radius');
  }
  const bodyTargets = new Set<string>();
  for (const bone of bones) {
    if (!bone || typeof bone !== 'object' || !bone.shape || typeof bone.shape !== 'object')
      return invalid('body requires shape');
    if (
      !isAnimationTargetId(bone.target) ||
      bodyTargets.has(bone.target) ||
      springTargets.has(bone.target)
    )
      return invalid('physical and spring writers must be disjoint and body targets unique');
    if (
      !finitePhysicsVector(bone.offset, 3) ||
      !unitPhysicsQuaternion(bone.rotation) ||
      !positive(bone.mass)
    )
      return invalid('body offset, rotation or mass invalid');
    const shape = bone.shape;
    if (
      shape.kind === 'cuboid'
        ? !finitePhysicsVector(shape.halfExtents, 3) || !shape.halfExtents.every(positive)
        : (shape.kind !== 'sphere' && shape.kind !== 'capsule') ||
          !positive(shape.radius) ||
          (shape.kind === 'capsule' && !nonnegative(shape.halfHeight))
    )
      return invalid('unsupported or degenerate body shape');
    if (
      bone.additionalSolverIterations !== undefined &&
      (!Number.isInteger(bone.additionalSolverIterations) ||
        bone.additionalSolverIterations < 0 ||
        bone.additionalSolverIterations > 32)
    )
      return invalid('additionalSolverIterations is an integer in [0,32]');
    if (
      bone.collisionGroups !== undefined &&
      (!Number.isInteger(bone.collisionGroups) ||
        bone.collisionGroups < 0 ||
        bone.collisionGroups > 0xffffffff)
    )
      return invalid('collisionGroups is a packed u32');
    bodyTargets.add(bone.target);
  }
  const pairs = new Set<string>();
  for (const joint of joints) {
    if (!joint || typeof joint !== 'object') return invalid('joint must be an object');
    const pair = [joint.bodyA, joint.bodyB].sort((a, b) => a - b).join(':');
    if (
      ![joint.bodyA, joint.bodyB].every((n) => Number.isInteger(n) && n >= 0 && n < bones.length) ||
      joint.bodyA === joint.bodyB ||
      pairs.has(pair) ||
      !finitePhysicsVector(joint.anchorA, 3) ||
      !finitePhysicsVector(joint.anchorB, 3) ||
      !axis(joint.axisA) ||
      !axis(joint.axisB) ||
      !finitePhysicsVector(joint.limits, 2) ||
      joint.limits[0] < -Math.PI ||
      joint.limits[1] > Math.PI ||
      joint.limits[0] > joint.limits[1]
    )
      return invalid('invalid body indices, anchors, hinge axes or limits');
    pairs.add(pair);
  }
  return ok(undefined);
}
