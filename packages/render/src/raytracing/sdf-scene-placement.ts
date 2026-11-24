import { mat4 } from '@forgeax/engine-math';
import { ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import type { SdfMeshInstance } from './sdf-query';
import { type SdfPlacementBounds, SdfTransformCertificate } from './sdf-transform-certificate';

/** The same canonical pair feeds raw Instance words and the surface row. */
export function sdfPlacementTransform(transform: ArrayLike<number>) {
  const values = Array.from(transform);
  if (
    values.length !== 16 ||
    !values.every((value) => Number.isFinite(Math.fround(value))) ||
    values[3] !== 0 ||
    values[7] !== 0 ||
    values[11] !== 0 ||
    values[15] !== 1
  )
    return rayReferenceFailure('expected finite affine SDF transform');
  const matrix = mat4.clone(values);
  const inverse = mat4.invert(mat4.create(), matrix);
  const check = mat4.multiply(mat4.create(), matrix, inverse);
  if (
    !mat4.equals(check, mat4.identity(mat4.create()), 1e-4) ||
    !Array.from(inverse).every(Number.isFinite)
  )
    return rayReferenceFailure('singular or ill-conditioned SDF transform');
  const scaleBound = Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((axis) => values[axis] ?? 0));
  return ok({ matrix, inverse, scaleBound });
}

export interface SdfPreparedPlacement {
  readonly matrix: Float32Array;
  readonly inverse: Float32Array;
  readonly scaleBound: number;
  readonly certificate: Result<SdfTransformCertificate, RayReferenceError>;
  /** Cold-pack snapshot only. This does not qualify geometry or material coverage. */
  readonly bounds: SdfPlacementBounds | undefined;
}

export function prepareSdfPlacements(source: readonly SdfMeshInstance[]) {
  const rows: SdfPreparedPlacement[] = [];
  for (const instance of source) {
    if (!instance) return rayReferenceFailure('missing SDF instance');
    const pose = sdfPlacementTransform(instance.transform);
    if (!pose.ok) return pose;
    const { matrix, inverse } = pose.value,
      certificate = SdfTransformCertificate.create(matrix, inverse),
      field = instance.field,
      local =
        !('missing' in field) && field.policy.kind === 'sampled-visibility'
          ? field.policy.traceBounds
          : field.bounds,
      enclosed = certificate.ok
        ? certificate.value.encloseBounds(matrix, inverse, local)
        : undefined;
    rows.push({ ...pose.value, certificate, bounds: enclosed?.ok ? enclosed.value : undefined });
  }
  return ok(rows as readonly SdfPreparedPlacement[]);
}
