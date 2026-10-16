import type { EntityHandle } from '@forgeax/engine-ecs';
import { quat, type Vec3Like } from '@forgeax/engine-math';
import type { SkeletonPose } from './skeleton-pose';
import { AnimationBindingError } from './solver-errors';

/** Intrinsic XYZ radians relative to the compiled local reference rotation. */
export interface IKJointLimit {
  readonly joint: EntityHandle;
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

export function compileIKLimits(
  pose: SkeletonPose,
  rotating: readonly number[],
  limits: readonly IKJointLimit[],
): ((index: number) => void) | undefined {
  if (limits.length === 0) return undefined;
  const compiled = new Map<
    number,
    {
      min: number[];
      max: number[];
      rest: ReturnType<typeof quat.create>;
      inverse: ReturnType<typeof quat.create>;
    }
  >();
  for (const limit of limits) {
    const index = pose.indices.get(limit.joint);
    if (index === undefined || !rotating.includes(index) || compiled.has(index))
      throw new AnimationBindingError('animation-skeleton-invalid', {
        joint: limit.joint,
        reason: 'limits require unique rotating chain joints',
      });
    const min = [limit.min[0] as number, limit.min[1] as number, limit.min[2] as number];
    const max = [limit.max[0] as number, limit.max[1] as number, limit.max[2] as number];
    for (let axis = 0; axis < 3; axis++) {
      const bound = axis === 1 ? Math.PI / 2 : Math.PI;
      if (
        !Number.isFinite(min[axis]) ||
        !Number.isFinite(max[axis]) ||
        (min[axis] as number) < -bound ||
        (max[axis] as number) > bound ||
        (min[axis] as number) > (max[axis] as number)
      )
        throw new AnimationBindingError('animation-solver-options-invalid', {
          reason: 'limits require ordered canonical XYZ bounds: X/Z +/- pi, Y +/- pi/2',
        });
    }
    const rest = quat.clone(pose.rotations[index] as ReturnType<typeof quat.create>);
    compiled.set(index, { min, max, rest, inverse: quat.invert(quat.create(), rest) });
  }
  const delta = quat.create();
  return (index) => {
    const limit = compiled.get(index);
    if (limit === undefined) return;
    const rotation = pose.rotations[index] as ReturnType<typeof quat.create>;
    quat.multiply(delta, limit.inverse, rotation);
    quat.normalize(delta, delta);
    const x = delta[0] as number;
    const y = delta[1] as number;
    const z = delta[2] as number;
    const w = delta[3] as number;
    // Intrinsic XYZ extraction. At gimbal lock choose Z=0, as the canonical chart does.
    const sineY = Math.max(-1, Math.min(1, 2 * (x * z + w * y)));
    const ey = Math.asin(sineY);
    const ex =
      Math.abs(sineY) < 0.9999999
        ? Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y))
        : Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z));
    const ez =
      Math.abs(sineY) < 0.9999999 ? Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z)) : 0;
    quat.fromEuler(
      delta,
      Math.max(limit.min[0] as number, Math.min(limit.max[0] as number, ex)),
      Math.max(limit.min[1] as number, Math.min(limit.max[1] as number, ey)),
      Math.max(limit.min[2] as number, Math.min(limit.max[2] as number, ez)),
      'XYZ',
    );
    quat.multiply(rotation, limit.rest, delta);
    quat.normalize(rotation, rotation);
  };
}
