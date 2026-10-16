import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, type Vec3Like, vec3 } from '@forgeax/engine-math';
import type { PreparedPath } from '@forgeax/engine-path';
import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import { skeletalMotionWriterEntities } from './skeletal-motion';
import { SkeletonPose } from './skeleton-pose';
import { AnimationBindingError } from './solver-errors';
import { SplineIKError } from './spline-ik-errors';
import { SplineCurveSampler } from './spline-ik-sampling';

export interface SplineIKControls {
  readonly origin?: Vec3Like;
  /** World distance from the traversal start; reverse traverses from the open end. */
  readonly offset?: number;
  readonly direction?: 1 | -1;
  readonly weight?: number;
  readonly lengthMode?: 'preserve' | 'fit';
  readonly twistStart?: number;
  readonly twistEnd?: number;
}
export interface SplineIKResult {
  readonly curveLength: number;
  readonly extended: boolean;
}
export interface SplineIKSolver {
  readonly joints: readonly EntityHandle[];
  /** Restore the last sampled base before evaluating this frame's animation. */
  restoreBase(): Result<void, SplineIKError>;
  /** Read the current base, stage all local TRS, then commit this whole valid chain. */
  solve(path: PreparedPath, controls?: SplineIKControls): Result<SplineIKResult, SplineIKError>;
}

function failure(cause: unknown): SplineIKError {
  if (cause instanceof SplineIKError) return cause;
  if (cause instanceof AnimationBindingError)
    return new SplineIKError('spline-ik-stale', { reason: cause.code, ...cause.detail });
  throw cause;
}

/** Compiled explicit chain over ordinary Scene transforms; Skin has no second pose owner. */
export function createSplineIKSolver(
  world: World,
  options: {
    readonly joints: readonly EntityHandle[];
    readonly forwardAxis?: number;
    readonly upAxis?: number;
  },
): Result<SplineIKSolver, SplineIKError> {
  try {
    const joints = Object.freeze([...options.joints]);
    const forward = options.forwardAxis ?? 4,
      up = options.upAxis ?? 2;
    if (joints.length < 2 || joints.length > 256 || new Set(joints).size !== joints.length)
      throw new SplineIKError('spline-ik-invalid', { reason: '2..256 unique joints required' });
    if (
      !Number.isInteger(forward) ||
      !Number.isInteger(up) ||
      forward < 0 ||
      forward > 5 ||
      up < 0 ||
      up > 5 ||
      forward >> 1 === up >> 1
    )
      throw new SplineIKError('spline-ik-invalid', {
        reason: 'distinct signed forward/up axes required',
      });
    for (let i = 1; i < joints.length; i++) {
      const relation = world.get(joints[i] as EntityHandle, ChildOf);
      if (!relation.ok || relation.value.parent !== joints[i - 1])
        throw new SplineIKError('spline-ik-invalid', { reason: 'noncontiguous chain' });
    }
    // Bound ancestor traversal before the existing pose compiler walks it.
    const ancestors = new Set<EntityHandle>();
    let ancestor: EntityHandle | null = joints[0] as EntityHandle;
    while (ancestor !== null) {
      if (ancestors.has(ancestor) || ancestors.size > 128)
        throw new SplineIKError('spline-ik-invalid', {
          reason: 'cyclic or >128 ancestor hierarchy',
        });
      ancestors.add(ancestor);
      if (!world.hasComponent(ancestor, ChildOf)) break;
      ancestor = world.get(ancestor, ChildOf).unwrap().parent;
    }
    const admitWriters = () => {
      const motionWriters = new Set(skeletalMotionWriterEntities(world));
      const joint = joints.find((entity) => motionWriters.has(entity));
      if (joint !== undefined)
        throw new SplineIKError('spline-ik-conflict', {
          reason: 'controlled joint is an active skeletal motion writer',
          joint,
        });
    };
    admitWriters();
    const pose = new SkeletonPose(world, joints);
    const indices = joints.map((joint) => pose.indices.get(joint) as number);
    const basePositions = indices.map((i) =>
      vec3.clone(pose.positions[i] as (typeof pose.positions)[number]),
    );
    const baseRotations = indices.map((i) =>
      quat.clone(pose.rotations[i] as (typeof pose.rotations)[number]),
    );
    const points = joints.map(() => vec3.create());
    const rotations = joints.map(() => quat.create());
    const lengths = new Float64Array(joints.length);
    const sampler = new SplineCurveSampler();
    const inverse = quat.create(),
      blend = quat.create(),
      from = vec3.create(),
      to = vec3.create();
    const parentScale = (index: number) => {
      if (index < 0) return 1;
      const m = pose.matrices[index] as Float32Array;
      return Math.hypot(m[0] as number, m[1] as number, m[2] as number);
    };
    return ok({
      joints,
      restoreBase() {
        try {
          admitWriters();
          pose.read();
          for (let j = 0; j < indices.length; j++) {
            (pose.positions[indices[j] as number] as (typeof pose.positions)[number]).set(
              basePositions[j] as (typeof basePositions)[number],
            );
            (pose.rotations[indices[j] as number] as (typeof pose.rotations)[number]).set(
              baseRotations[j] as (typeof baseRotations)[number],
            );
          }
          pose.update(0);
          pose.write(indices, true);
          return ok(undefined);
        } catch (cause) {
          return err(failure(cause));
        }
      },
      solve(path, controls = {}) {
        try {
          admitWriters();
          const weight = controls.weight ?? 1;
          const mode = controls.lengthMode ?? 'preserve';
          const offset = controls.offset ?? 0,
            direction = controls.direction ?? 1;
          const startTwist = controls.twistStart ?? 0,
            endTwist = controls.twistEnd ?? 0;
          const origin = controls.origin ?? [0, 0, 0];
          if (
            ![weight, offset, startTwist, endTwist, origin[0], origin[1], origin[2]].every(
              Number.isFinite,
            ) ||
            weight < 0 ||
            weight > 1 ||
            offset < 0 ||
            (direction !== 1 && direction !== -1) ||
            (mode !== 'preserve' && mode !== 'fit')
          )
            throw new SplineIKError('spline-ik-invalid', {
              reason:
                'finite controls, weight [0,1], nonnegative offset and declared mode/direction required',
            });
          if (
            path.closed &&
            Math.abs(
              (endTwist - startTwist) / (2 * Math.PI) -
                Math.round((endTwist - startTwist) / (2 * Math.PI)),
            ) > 1e-6
          )
            throw new SplineIKError('spline-ik-invalid', {
              reason: 'closed twist delta must be a whole turn for seam continuity',
            });
          pose.read();
          for (let j = 0; j < indices.length; j++) {
            const index = indices[j] as number;
            (basePositions[j] as (typeof basePositions)[number]).set(
              pose.positions[index] as (typeof pose.positions)[number],
            );
            (baseRotations[j] as (typeof baseRotations)[number]).set(
              pose.rotations[index] as (typeof pose.rotations)[number],
            );
          }
          let total = 0;
          for (let j = 1; j < indices.length; j++) {
            const index = indices[j] as number;
            lengths[j] =
              vec3.length(basePositions[j] as (typeof basePositions)[number]) *
              parentScale(pose.parents[index] as number);
            if (!((lengths[j] as number) > 1e-6))
              throw new SplineIKError('spline-ik-invalid', {
                reason: 'zero-length segment',
                joint: joints[j] as EntityHandle,
              });
            total += lengths[j] as number;
          }
          if (weight === 0) return ok({ curveLength: path.length, extended: false });
          sampler.begin(path, direction, origin, forward, up);
          const start = path.closed ? offset : Math.min(path.length, offset);
          let distance = start;
          let cumulative = 0;
          for (let j = 0; j < joints.length; j++) {
            if (j > 0) {
              cumulative += lengths[j] as number;
              distance =
                mode === 'fit'
                  ? start +
                    (cumulative / total) *
                      (path.closed ? path.length : Math.max(0, path.length - start))
                  : sampler.next(
                      points[j - 1] as (typeof points)[number],
                      distance,
                      lengths[j] as number,
                    );
            }
            const twistFraction = path.closed ? distance / path.length : cumulative / total;
            sampler.sample(
              points[j] as (typeof points)[number],
              rotations[j] as (typeof rotations)[number],
              distance,
              startTwist + (endTwist - startTwist) * twistFraction,
            );
          }
          // Convert against the solved parent, retaining current ancestor scale.
          for (let j = 0; j < joints.length; j++) {
            const index = indices[j] as number,
              parent = pose.parents[index] as number;
            const position = pose.positions[index] as (typeof pose.positions)[number],
              rotation = pose.rotations[index] as (typeof pose.rotations)[number];
            if (j > 0) {
              from.set(points[j - 1] as (typeof points)[number]);
              quat.invert(inverse, rotations[j - 1] as (typeof rotations)[number]);
            } else if (parent >= 0) {
              const m = pose.matrices[parent] as Float32Array;
              vec3.set(from, m[12] as number, m[13] as number, m[14] as number);
              quat.invert(
                inverse,
                pose.globalRotations[parent] as (typeof pose.globalRotations)[number],
              );
            } else {
              from.fill(0);
              quat.identity(inverse);
            }
            vec3.sub(position, points[j] as (typeof points)[number], from);
            quat.transformVec3(position, inverse, position);
            vec3.scale(position, position, 1 / parentScale(parent));
            quat.multiply(rotation, inverse, rotations[j] as (typeof rotations)[number]);
            if (weight < 1) {
              if (mode === 'preserve' && j > 0) {
                vec3.normalize(from, basePositions[j] as (typeof basePositions)[number]);
                vec3.normalize(to, position);
                quat.fromUnitVectors(blend, from, to);
                quat.slerp(blend, [0, 0, 0, 1], blend, weight);
                quat.transformVec3(
                  position,
                  blend,
                  basePositions[j] as (typeof basePositions)[number],
                );
              } else
                vec3.lerp(
                  position,
                  basePositions[j] as (typeof basePositions)[number],
                  position,
                  weight,
                );
              quat.slerp(
                rotation,
                baseRotations[j] as (typeof baseRotations)[number],
                rotation,
                weight,
              );
            }
            quat.normalize(rotation, rotation);
          }
          pose.update(0);
          pose.validate();
          pose.write(indices, true);
          return ok({ curveLength: path.length, extended: !path.closed && distance > path.length });
        } catch (cause) {
          return err(failure(cause));
        }
      },
    });
  } catch (cause) {
    return err(failure(cause));
  }
}
