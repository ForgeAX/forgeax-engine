import type { CloudRgb, CloudTracePolicy } from '../contracts';

export const CLOUD_UNTRACED_DEPTH_METERS = 65_504_000;

export interface CloudRay {
  readonly cameraRelativeToPlanetMeters: CloudRgb;
  /** Unit vector from camera to sample. */
  readonly direction: CloudRgb;
}

export interface CloudShell {
  readonly planetRadiusMeters: number;
  readonly bottomMeters: number;
  readonly thicknessMeters: number;
}

export interface CloudTraceClip {
  readonly tracingStartMaxDistanceMeters: number;
  readonly tracingMaxDistanceMeters: number;
  readonly tracingMaxDistanceMode: CloudTracePolicy['tracingMaxDistanceMode'];
  readonly tracingStartDistanceFromCameraMeters: number;
  readonly sceneDistanceMeters: number;
}

export interface CloudInterval {
  readonly entryMeters: number;
  readonly exitMeters: number;
}

export function sphereInterval(
  radialDistance: number,
  projection: number,
  radius: number,
): CloudInterval | undefined {
  // Factoring c avoids subtracting two squared Earth-scale distances.
  const c = (radialDistance - radius) * (radialDistance + radius);
  const discriminant = projection * projection - c;
  if (discriminant <= 0) return undefined;
  const q = -projection - (projection >= 0 ? 1 : -1) * Math.sqrt(discriminant);
  const second = c / q;
  return { entryMeters: Math.min(q, second), exitMeters: Math.max(q, second) };
}

function validCloudShell(
  shell: CloudShell,
  clip: CloudTraceClip,
  radial: number,
  projection: number,
): boolean {
  const { planetRadiusMeters, bottomMeters, thicknessMeters } = shell;
  return (
    Number.isFinite(radial) &&
    Number.isFinite(projection) &&
    Number.isFinite(planetRadiusMeters) &&
    planetRadiusMeters > 0 &&
    Number.isFinite(bottomMeters) &&
    bottomMeters >= 0 &&
    Number.isFinite(thicknessMeters) &&
    thicknessMeters > 0 &&
    clip.tracingStartMaxDistanceMeters >= 0 &&
    clip.tracingMaxDistanceMeters > 0 &&
    clip.tracingStartDistanceFromCameraMeters >= 0 &&
    clip.sceneDistanceMeters >= 0 &&
    radial >= planetRadiusMeters &&
    (radial !== planetRadiusMeters || projection >= 0)
  );
}

/** First continuous visible interval in the shell. Rays entering the planet terminate there. */
export function cloudShellInterval(
  ray: CloudRay,
  shell: CloudShell,
  clip: CloudTraceClip,
): CloudInterval | undefined {
  const { planetRadiusMeters, bottomMeters, thicknessMeters } = shell;
  const origin = ray.cameraRelativeToPlanetMeters;
  const direction = ray.direction;
  const radial = Math.hypot(...origin);
  const projection = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2];
  if (!validCloudShell(shell, clip, radial, projection)) return undefined;
  const innerRadius = planetRadiusMeters + bottomMeters;
  const outer = sphereInterval(radial, projection, innerRadius + thicknessMeters);
  if (outer === undefined || outer.exitMeters <= 0) return undefined;
  let entryMeters = Math.max(0, outer.entryMeters);
  let exitMeters = outer.exitMeters;
  const inner = sphereInterval(radial, projection, innerRadius);
  if (inner !== undefined && inner.exitMeters > entryMeters && inner.entryMeters < exitMeters) {
    if (inner.entryMeters <= entryMeters) {
      entryMeters = inner.exitMeters;
    } else {
      exitMeters = inner.entryMeters;
    }
  }
  if (entryMeters > clip.tracingStartMaxDistanceMeters) return undefined;
  const ground = sphereInterval(radial, projection, planetRadiusMeters);
  const groundDistance =
    ground !== undefined && ground.exitMeters > 0 ? Math.max(0, ground.entryMeters) : Infinity;
  const maxDistance =
    clip.tracingMaxDistanceMode === 'from-layer-entry'
      ? entryMeters + clip.tracingMaxDistanceMeters
      : clip.tracingMaxDistanceMeters;
  entryMeters = Math.max(entryMeters, clip.tracingStartDistanceFromCameraMeters);
  exitMeters = Math.min(exitMeters, groundDistance, maxDistance, clip.sceneDistanceMeters);
  return exitMeters > entryMeters ? { entryMeters, exitMeters } : undefined;
}
