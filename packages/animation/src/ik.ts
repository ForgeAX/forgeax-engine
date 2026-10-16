import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, type Vec3, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import { compileIKLimits, type IKJointLimit } from './ik-limits';
import { SkeletonPose, solverFailure } from './skeleton-pose';
import { AnimationBindingError, type AnimationError } from './solver-errors';

function scaledAdd(out: Vec3, a: Vec3Like, b: Vec3Like, factor: number): void {
  for (let i = 0; i < 3; i++) out[i] = (a[i] as number) + factor * (b[i] as number);
}

export interface IKOptions {
  /** Blend from the current input pose, in [0,1]. */
  readonly weight?: number;
  /** World-space bend guide for a three-joint limb. */
  readonly pole?: Vec3Like;
}
export interface IKResult {
  readonly error: number;
  readonly reached: boolean;
  readonly iterations: number;
}
export interface IKSolver {
  solve(target: Vec3Like, options?: IKOptions): Result<IKResult, AnimationError>;
}

/** Compile a contiguous root-to-effector chain; reread its current local pose on every solve. */
export function createIKSolver(
  world: World,
  options: {
    readonly joints: readonly EntityHandle[];
    readonly maxIterations?: number;
    readonly tolerance?: number;
    readonly maxAngle?: number;
    readonly limits?: readonly IKJointLimit[];
  },
): Result<IKSolver, AnimationError> {
  try {
    const joints = [...options.joints];
    const iterations = options.maxIterations ?? 32;
    const tolerance = options.tolerance ?? 1e-4;
    const maxAngle = options.maxAngle ?? Math.PI;
    if (joints.length < 2 || joints.length > 256 || new Set(joints).size !== joints.length)
      throw new AnimationBindingError('animation-skeleton-invalid', {
        reason: 'requires 2..256 unique contiguous joints',
      });
    if (
      !Number.isSafeInteger(iterations) ||
      iterations < 1 ||
      iterations > 256 ||
      !Number.isFinite(tolerance) ||
      tolerance <= 0 ||
      !Number.isFinite(maxAngle) ||
      maxAngle <= 0 ||
      maxAngle > Math.PI
    )
      throw new AnimationBindingError('animation-solver-options-invalid', {
        iterations,
        tolerance,
        maxAngle,
      });
    for (let i = 1; i < joints.length; i++) {
      const parent = world.get(joints[i] as EntityHandle, ChildOf);
      if (!parent.ok || parent.value.parent !== joints[i - 1])
        throw new AnimationBindingError('animation-skeleton-invalid', {
          joint: joints[i] as EntityHandle,
          reason: 'noncontiguous chain',
        });
    }
    const pose = new SkeletonPose(world, joints);
    const indices = joints.map((joint) => pose.indices.get(joint) as number);
    const rotating = indices.slice(0, -1);
    const constrain = compileIKLimits(pose, rotating, options.limits ?? []);
    const originals = rotating.map(() => quat.create());
    const delta = quat.create();
    const inverse = quat.create();
    const desired = quat.create();
    const from = vec3.create();
    const to = vec3.create();
    const axis = vec3.create();
    const rootPosition = vec3.create();
    const middlePosition = vec3.create();
    const tipPosition = vec3.create();
    const bend = vec3.create();
    const elbow = vec3.create();
    const point = (out: Vec3, index: number) => {
      const m = pose.matrices[index];
      if (m !== undefined) vec3.set(out, m[12] as number, m[13] as number, m[14] as number);
      return out;
    };
    const error = (target: Vec3Like) =>
      vec3.distance(point(tipPosition, indices[indices.length - 1] as number), target);
    const rotateToward = (index: number, child: number, goal: Vec3Like) => {
      point(rootPosition, index);
      point(tipPosition, child);
      vec3.sub(from, tipPosition, rootPosition);
      vec3.sub(to, goal, rootPosition);
      if (vec3.lengthSq(from) < 1e-12 || vec3.lengthSq(to) < 1e-12) return;
      vec3.normalize(from, from);
      vec3.normalize(to, to);
      quat.invert(inverse, pose.globalRotations[index] as (typeof pose.globalRotations)[number]);
      quat.transformVec3(from, inverse, from);
      quat.transformVec3(to, inverse, to);
      vec3.cross(axis, from, to);
      const crossLength = vec3.length(axis);
      const dot = Math.min(1, Math.max(-1, vec3.dot(from, to)));
      if (crossLength > 1e-8) quat.fromAxisAngle(delta, axis, Math.atan2(crossLength, dot));
      else quat.fromUnitVectors(delta, from, to);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(delta[3] as number)));
      if (angle > maxAngle) quat.slerp(delta, [0, 0, 0, 1], delta, maxAngle / angle);
      quat.multiply(
        pose.rotations[index] as (typeof pose.rotations)[number],
        pose.rotations[index] as (typeof pose.rotations)[number],
        delta,
      );
      quat.normalize(
        pose.rotations[index] as (typeof pose.rotations)[number],
        pose.rotations[index] as (typeof pose.rotations)[number],
      );
      constrain?.(index);
      pose.update(index);
    };
    return ok({
      solve(target, controls = {}) {
        try {
          const weight = controls.weight ?? 1;
          if (
            ![
              target[0],
              target[1],
              target[2],
              weight,
              ...(controls.pole === undefined
                ? []
                : [controls.pole[0], controls.pole[1], controls.pole[2]]),
            ].every(Number.isFinite) ||
            weight < 0 ||
            weight > 1 ||
            (controls.pole !== undefined && joints.length !== 3)
          )
            throw new AnimationBindingError('animation-solver-options-invalid', {
              weight,
              reason: 'finite goal, weight [0,1], pole only for three-joint limbs',
            });
          pose.read();
          for (let i = 0; i < rotating.length; i++)
            (originals[i] as (typeof originals)[number]).set(
              pose.rotations[rotating[i] as number] as (typeof pose.rotations)[number],
            );
          if (weight > 0 && constrain !== undefined) {
            for (const index of rotating) constrain?.(index);
            pose.update(rotating[0] as number);
          }
          let completed = 0;
          if (weight > 0 && joints.length === 3 && controls.pole !== undefined) {
            const a = indices[0] as number;
            const b = indices[1] as number;
            const c = indices[2] as number;
            point(rootPosition, a);
            point(middlePosition, b);
            point(tipPosition, c);
            const l1 = vec3.distance(rootPosition, middlePosition);
            const l2 = vec3.distance(middlePosition, tipPosition);
            if (l1 < 1e-6 || l2 < 1e-6)
              throw new AnimationBindingError('animation-skeleton-invalid', {
                reason: 'zero-length limb',
              });
            vec3.sub(to, target, rootPosition);
            const distance = vec3.length(to);
            if (distance < 1e-8) vec3.sub(to, tipPosition, rootPosition);
            if (vec3.lengthSq(to) < 1e-12) vec3.set(to, 1, 0, 0);
            vec3.normalize(to, to);
            vec3.sub(bend, controls.pole, rootPosition);
            scaledAdd(bend, bend, to, -vec3.dot(bend, to));
            if (vec3.lengthSq(bend) < 1e-12) {
              // A collinear pole has no bend information: retain the current plane.
              vec3.sub(bend, middlePosition, rootPosition);
              scaledAdd(bend, bend, to, -vec3.dot(bend, to));
            }
            if (vec3.lengthSq(bend) < 1e-12) {
              vec3.set(
                axis,
                Math.abs(to[0] as number) < 0.9 ? 1 : 0,
                Math.abs(to[0] as number) < 0.9 ? 0 : 1,
                0,
              );
              vec3.cross(bend, to, axis);
            }
            vec3.normalize(bend, bend);
            const d = Math.max(
              Math.abs(l1 - l2) + 1e-7,
              Math.min(l1 + l2, Math.max(distance, 1e-7)),
            );
            const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
            const y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
            scaledAdd(elbow, rootPosition, to, x);
            scaledAdd(elbow, elbow, bend, y);
            rotateToward(a, b, elbow);
            rotateToward(b, c, target);
            completed = 1;
          } else if (weight > 0) {
            const root = rotating[0] as number;
            const tip = indices[indices.length - 1] as number;
            // Orient an extended limb before CCD; otherwise an opposite goal can fold
            // the tip onto the root and leave the root's direction undefined.
            rotateToward(root, tip, target);
            point(rootPosition, root);
            point(tipPosition, tip);
            if (
              rotating.length > 1 &&
              vec3.distance(rootPosition, target) <
                vec3.distance(rootPosition, tipPosition) - tolerance
            ) {
              const joint = rotating[rotating.length - 2] as number;
              point(middlePosition, joint);
              vec3.sub(from, tipPosition, middlePosition);
              vec3.normalize(from, from);
              quat.invert(
                inverse,
                pose.globalRotations[joint] as (typeof pose.globalRotations)[number],
              );
              quat.transformVec3(from, inverse, from);
              vec3.set(
                to,
                Math.abs(from[1] as number) < 0.9 ? 0 : 1,
                Math.abs(from[1] as number) < 0.9 ? 1 : 0,
                0,
              );
              vec3.cross(axis, from, to);
              quat.fromAxisAngle(delta, axis, Math.min(0.1, maxAngle));
              quat.multiply(
                pose.rotations[joint] as (typeof pose.rotations)[number],
                pose.rotations[joint] as (typeof pose.rotations)[number],
                delta,
              );
              constrain?.(joint);
              pose.update(joint);
            }
            for (; completed < iterations && error(target) > tolerance; completed++) {
              for (let i = rotating.length - 1; i >= 0; i--)
                rotateToward(rotating[i] as number, tip, target);
            }
          }
          // Analytical seeding respects step caps and limits; CCD finishes the bounded solve.
          if (controls.pole !== undefined && weight > 0) {
            const tip = indices[indices.length - 1] as number;
            for (; completed < iterations && error(target) > tolerance; completed++)
              for (let i = rotating.length - 1; i >= 0; i--)
                rotateToward(rotating[i] as number, tip, target);
          }
          if (weight > 0 && weight < 1) {
            for (let i = 0; i < rotating.length; i++) {
              const index = rotating[i] as number;
              quat.slerp(
                desired,
                originals[i] as (typeof originals)[number],
                pose.rotations[index] as (typeof pose.rotations)[number],
                weight,
              );
              (pose.rotations[index] as (typeof pose.rotations)[number]).set(desired);
              constrain?.(index);
            }
            pose.update(rotating[0] as number);
          }
          if (weight > 0) pose.write(rotating);
          const residual = error(target);
          return ok({ error: residual, reached: residual <= tolerance, iterations: completed });
        } catch (failure) {
          return err(solverFailure(failure));
        }
      },
    });
  } catch (failure) {
    return err(solverFailure(failure));
  }
}
