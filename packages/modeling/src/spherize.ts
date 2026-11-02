import { err, type Result } from '@forgeax/engine-types';
import { applyDeformation } from './deform';
import { type ModelingError, modelingError } from './errors';
import { checkFalloff, type Falloff, falloffWeights } from './falloff';
import { length, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';

export interface SpherizeOptions {
  /** Blend toward the sphere: 0 keeps the shape, 1 lands on it (may exceed [0, 1]). */
  readonly factor: number;
  /** Center (default: the bounds center of the selected vertices). */
  readonly center?: Tuple3;
  /**
   * Ellipsoid radii in meters (default: a sphere whose radius is the mean distance of the
   * selected vertices from the center, so the volume barely changes).
   */
  readonly radii?: Tuple3;
  /** Soft blend: unselected vertices within the radius move by their falloff weight. */
  readonly falloff?: Falloff;
}

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

const finite3 = (v: unknown): v is Tuple3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

/**
 * Cast / spherize: each vertex moves along its direction
 * from the center toward the ellipsoid, by `factor` times its falloff weight. Pole-free
 * quad-cage heads start from a subdivided box spherized to a ball. Topology never
 * changes; a vertex at the center has no direction and stays.
 */
export function spherize(
  mesh: EditMesh,
  vertices: readonly number[],
  options: SpherizeOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const factor = options?.factor;
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    return invalid('factor is a finite number (0 keeps the shape, 1 reaches the sphere)', {
      factor,
    });
  }
  if (options.center !== undefined && !finite3(options.center)) {
    return invalid('center is three finite numbers', { center: options.center });
  }
  if (
    options.radii !== undefined &&
    (!finite3(options.radii) || !options.radii.every((r) => r > 0))
  ) {
    return invalid('radii are three lengths > 0', { radii: options.radii });
  }
  let falloff: Required<Falloff> | undefined;
  if (options.falloff !== undefined) {
    const checked = checkFalloff(options.falloff);
    if (!checked.ok) return checked;
    falloff = checked.value;
  }
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  const center: Tuple3 = options.center ?? [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  let radii = options.radii;
  if (radii === undefined) {
    let sum = 0;
    for (const v of vertices) {
      const p = mesh.position(v);
      sum += length([p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
    }
    const r = sum / vertices.length;
    radii = [r, r, r];
  }
  const [rx, ry, rz] = radii;
  const weights = falloffWeights(mesh, vertices, falloff);
  const moving = [...weights.keys()].sort((a, b) => a - b);
  const target = (p: Tuple3): Tuple3 => {
    const q: Tuple3 = [(p[0] - center[0]) / rx, (p[1] - center[1]) / ry, (p[2] - center[2]) / rz];
    const l = length(q);
    if (l === 0) return p;
    return [center[0] + (q[0] / l) * rx, center[1] + (q[1] / l) * ry, center[2] + (q[2] / l) * rz];
  };
  return applyDeformation(
    mesh,
    'spherize',
    moving,
    {
      kind: 'positions',
      position: (v) => {
        const p = mesh.position(v);
        const t = target(p);
        const w = factor * (weights.get(v) as number);
        return [p[0] + (t[0] - p[0]) * w, p[1] + (t[1] - p[1]) * w, p[2] + (t[2] - p[2]) * w];
      },
    },
    tolerance,
    diagnostics,
    () => ({ center, radii, factor, weighted: moving.length - vertices.length }),
  );
}
