import { mat4 } from '@forgeax/engine-math';
import type { CameraSnapshot } from '../render-contract';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import type { VolumeBounds } from '../volume/component';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';

/** A view gate after full source validation, before density residency/upload. */
export function volumetricFogForView(
  fog: ExtractedVolumetricFog | undefined,
  camera: CameraSnapshot,
  width: number,
  height: number,
): ExtractedVolumetricFog | undefined {
  if (fog?.status !== 'available') return fog;
  // Unknown target/scaling extents cannot bound TAA's physical-pixel jitter.
  if (
    camera.antialias === 'taa' &&
    (camera.dynamicResolution !== undefined ||
      camera.target !== undefined ||
      camera.view !== undefined)
  )
    return fog;
  const sources = [fog, ...(fog.additional ?? [])];
  // Degraded or incomplete authoring retains the ordinary error/LKG path.
  if (sources.some((source) => source.status !== 'available' || source.fog === undefined))
    return fog;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return fog;
  const view = computeViewMatrix(camera, mat4.create());
  const projection = mat4.multiply(
    mat4.create(),
    computeProjectionMatrix(camera, mat4.create()),
    view,
  );
  if (!projection.every(Number.isFinite) || !view.every(Number.isFinite)) return fog;
  // Two internal pixels conservatively cover TAA's subpixel jitter and the
  // volume resolve boundary. Keep the complete original set if any owner can
  // reach the view: punctual owners also influence the integrator's subdivision.
  const x = 1 + 4 / width;
  const y = 1 + 4 / height;
  const outside = (bounds: VolumeBounds, nx: number, ny: number, nz: number, d: number) => {
    const px = nx >= 0 ? bounds.max[0] : bounds.min[0];
    const py = ny >= 0 ? bounds.max[1] : bounds.min[1];
    const pz = nz >= 0 ? bounds.max[2] : bounds.min[2];
    const support = nx * px + ny * py + nz * pz + d;
    const margin =
      1e-5 * (Math.abs(nx * px) + Math.abs(ny * py) + Math.abs(nz * pz) + Math.abs(d) + 1);
    return support < -margin;
  };
  const visible = (bounds: VolumeBounds): boolean => {
    if (
      !bounds.min.every(Number.isFinite) ||
      !bounds.max.every(Number.isFinite) ||
      bounds.max.some((value, axis) => value <= (bounds.min[axis] ?? value)) ||
      (bounds.min.every((value, axis) => value <= (camera.position[axis] ?? value)) &&
        bounds.max.every((value, axis) => value >= (camera.position[axis] ?? value)))
    )
      return true;
    for (const [row, pad] of [
      [0, x],
      [1, y],
    ] as const) {
      for (const sign of [-1, 1]) {
        if (
          outside(
            bounds,
            (projection[3] ?? 0) * pad + sign * (projection[row] ?? 0),
            (projection[7] ?? 0) * pad + sign * (projection[row + 4] ?? 0),
            (projection[11] ?? 0) * pad + sign * (projection[row + 8] ?? 0),
            (projection[15] ?? 0) * pad + sign * (projection[row + 12] ?? 0),
          )
        )
          return false;
      }
    }
    // Volume rays start in front of the eye. Do not reject by the camera far
    // plane: authored maxDistance can integrate past it against background depth.
    return !outside(bounds, -(view[2] ?? 0), -(view[6] ?? 0), -(view[10] ?? 0), -(view[14] ?? 0));
  };
  return sources.some((source) => source.fog === undefined || visible(source.fog.bounds))
    ? fog
    : undefined;
}
