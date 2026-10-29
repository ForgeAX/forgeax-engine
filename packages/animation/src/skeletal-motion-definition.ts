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

function optionalIntegerIn(value: number | undefined, min: number, max: number): boolean {
  return value === undefined || (Number.isInteger(value) && value >= min && value <= max);
}

/** Returns the first rejection reason of a definition's top-level shape and capacity. */
function definitionShapeFailure(input: SkeletalMotionDefinition): string | undefined {
  if (input === null || typeof input !== 'object') return 'definition must be a JSON object';
  if (input.springs !== undefined && !Array.isArray(input.springs))
    return 'springs must be an array';
  if (
    input.physical !== undefined &&
    (input.physical === null ||
      typeof input.physical !== 'object' ||
      !Array.isArray(input.physical.bones) ||
      !Array.isArray(input.physical.joints))
  )
    return 'physical requires bones and joints arrays';
  const springs = input.springs ?? [];
  const bones = input.physical?.bones ?? [];
  const joints = input.physical?.joints ?? [];
  if (
    springs.length > 1024 ||
    bones.length > 128 ||
    joints.length > 256 ||
    (springs.length === 0 && bones.length === 0)
  )
    return 'requires 1..1024 chains or 1..128 bodies, at most 256 joints';
  return undefined;
}

function springParametersValid(chain: SpringBoneChain): boolean {
  const iterations = chain.iterations ?? 8;
  return (
    chain.targets.length >= 2 &&
    chain.targets.length <= 33 &&
    nonnegative(chain.stiffness) &&
    nonnegative(chain.damping) &&
    finitePhysicsVector(chain.gravity, 3) &&
    nonnegative(chain.radius) &&
    nonnegative(chain.maxAngle) &&
    chain.maxAngle <= Math.PI &&
    Number.isInteger(iterations) &&
    iterations >= 1 &&
    iterations <= 16 &&
    (chain.collisions?.length ?? 0) <= 32
  );
}

/** Claims the chain's joints; every joint but the tail becomes an exclusive writer. */
function claimSpringJoints(
  chain: SpringBoneChain,
  writers: Set<string>,
  springTargets: Set<string>,
): boolean {
  const seen = new Set<string>();
  const tail = chain.targets.length - 1;
  for (const [index, target] of chain.targets.entries()) {
    if (!isAnimationTargetId(target) || seen.has(target) || (index < tail && writers.has(target)))
      return false;
    seen.add(target);
    springTargets.add(target);
    if (index < tail) writers.add(target);
  }
  return true;
}

function springCollisionsValid(chain: SpringBoneChain): boolean {
  for (const collision of chain.collisions ?? [])
    if (
      !collision ||
      typeof collision !== 'object' ||
      !isAnimationTargetId(collision.target) ||
      !finitePhysicsVector(collision.center, 3) ||
      !positive(collision.radius)
    )
      return false;
  return true;
}

function springChainFailure(
  chain: SpringBoneChain,
  writers: Set<string>,
  springTargets: Set<string>,
): string | undefined {
  if (
    !chain ||
    typeof chain !== 'object' ||
    !Array.isArray(chain.targets) ||
    (chain.collisions !== undefined && !Array.isArray(chain.collisions))
  )
    return 'chain requires targets and optional collisions arrays';
  if (!springParametersValid(chain)) return 'invalid spring parameters or capacity';
  if (!claimSpringJoints(chain, writers, springTargets))
    return 'spring joints must be unique, continuous targets with exclusive writers';
  if (!springCollisionsValid(chain))
    return 'sphere collision needs a stable target, finite center and positive radius';
  return undefined;
}

function boneShapeValid(shape: PhysicalBone['shape']): boolean {
  if (shape.kind === 'cuboid')
    return finitePhysicsVector(shape.halfExtents, 3) && shape.halfExtents.every(positive);
  if (shape.kind !== 'sphere' && shape.kind !== 'capsule') return false;
  if (!positive(shape.radius)) return false;
  return shape.kind !== 'capsule' || nonnegative(shape.halfHeight);
}

function physicalBoneFailure(
  bone: PhysicalBone,
  bodyTargets: ReadonlySet<string>,
  springTargets: ReadonlySet<string>,
): string | undefined {
  if (!bone || typeof bone !== 'object' || !bone.shape || typeof bone.shape !== 'object')
    return 'body requires shape';
  if (
    !isAnimationTargetId(bone.target) ||
    bodyTargets.has(bone.target) ||
    springTargets.has(bone.target)
  )
    return 'physical and spring writers must be disjoint and body targets unique';
  if (
    !finitePhysicsVector(bone.offset, 3) ||
    !unitPhysicsQuaternion(bone.rotation) ||
    !positive(bone.mass)
  )
    return 'body offset, rotation or mass invalid';
  if (!boneShapeValid(bone.shape)) return 'unsupported or degenerate body shape';
  if (!optionalIntegerIn(bone.additionalSolverIterations, 0, 32))
    return 'additionalSolverIterations is an integer in [0,32]';
  if (!optionalIntegerIn(bone.collisionGroups, 0, 0xffffffff))
    return 'collisionGroups is a packed u32';
  return undefined;
}

function jointValid(
  joint: PhysicalBoneJoint,
  bodyCount: number,
  pair: string,
  pairs: ReadonlySet<string>,
): boolean {
  return (
    [joint.bodyA, joint.bodyB].every((n) => Number.isInteger(n) && n >= 0 && n < bodyCount) &&
    joint.bodyA !== joint.bodyB &&
    !pairs.has(pair) &&
    finitePhysicsVector(joint.anchorA, 3) &&
    finitePhysicsVector(joint.anchorB, 3) &&
    axis(joint.axisA) &&
    axis(joint.axisB) &&
    finitePhysicsVector(joint.limits, 2) &&
    joint.limits[0] >= -Math.PI &&
    joint.limits[1] <= Math.PI &&
    joint.limits[0] <= joint.limits[1]
  );
}

function physicalJointsFailure(
  joints: readonly PhysicalBoneJoint[],
  bodyCount: number,
): string | undefined {
  const pairs = new Set<string>();
  for (const joint of joints) {
    if (!joint || typeof joint !== 'object') return 'joint must be an object';
    const pair = [joint.bodyA, joint.bodyB].sort((a, b) => a - b).join(':');
    if (!jointValid(joint, bodyCount, pair, pairs))
      return 'invalid body indices, anchors, hinge axes or limits';
    pairs.add(pair);
  }
  return undefined;
}

/** Returns the first rejection reason, checking springs, then bodies, then joints. */
function skeletalMotionFailure(input: SkeletalMotionDefinition): string | undefined {
  const shape = definitionShapeFailure(input);
  if (shape !== undefined) return shape;
  const bones = input.physical?.bones ?? [];
  const writers = new Set<string>();
  const springTargets = new Set<string>();
  for (const chain of input.springs ?? []) {
    const failure = springChainFailure(chain, writers, springTargets);
    if (failure !== undefined) return failure;
  }
  const bodyTargets = new Set<string>();
  for (const bone of bones) {
    const failure = physicalBoneFailure(bone, bodyTargets, springTargets);
    if (failure !== undefined) return failure;
    bodyTargets.add(bone.target);
  }
  return physicalJointsFailure(input.physical?.joints ?? [], bones.length);
}

/** Runtime admission also protects plain JSON callers, before entities or writes exist. */
export function validateSkeletalMotionDefinition(
  input: SkeletalMotionDefinition,
): Result<void, SkeletalMotionFailure> {
  const reason = skeletalMotionFailure(input);
  if (reason !== undefined)
    return err(new SkeletalMotionError('animation-motion-invalid', { reason }));
  return ok(undefined);
}
