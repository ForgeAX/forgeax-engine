import type { StandardProfile } from '../pipeline/standard-profile';
import type { LightRoster } from '../render-system-extract';

export function visibleSurfacePipelineDemand(profile: StandardProfile | undefined): boolean {
  return profile?.visibleSurface === true;
}

export function gpuDrivenPipelineLane(
  renderPath: 'forward' | 'deferred',
  reflectionFallbackCandidate: boolean,
): boolean {
  return !(reflectionFallbackCandidate && renderPath !== 'deferred');
}

export function hasShadowPipelineDemand(
  lights: Pick<LightRoster, 'pointShadow' | 'spot'>,
  directionalViews: number,
): boolean {
  return (
    directionalViews > 0 ||
    lights.pointShadow.length > 0 ||
    lights.spot.some((spot) => spot.lightViewProj !== undefined)
  );
}

/** The Standard shader lane does not retain the frame's light buffers or matrices. */
export function standardLightingPipelineDemand(
  camera: boolean,
  lights: Pick<LightRoster, 'point' | 'spot' | 'rect' | 'additionalDirectional'>,
  ssao: boolean,
  storageBuffer: boolean,
  pbrPipelineLayout: unknown,
): { readonly lightingKind: 'clustered' | 'no-local-lights'; readonly hasLocalLights: boolean } {
  const hasLocalLights =
    lights.point.length +
      lights.spot.length +
      lights.rect.length +
      (lights.additionalDirectional?.length ?? 0) >
    0;
  return {
    lightingKind:
      camera && ((storageBuffer && pbrPipelineLayout !== null) || hasLocalLights || ssao)
        ? 'clustered'
        : 'no-local-lights',
    hasLocalLights: camera && hasLocalLights,
  };
}

/** Actual shadow kinds select two raster specializations: point faces and all other views. */
export function shadowPipelineReflections(
  lights: Pick<LightRoster, 'pointShadow' | 'spot'>,
  directionalViews: number,
): ReadonlySet<boolean> {
  const reflected = new Set<boolean>();
  if (lights.pointShadow.length > 0) reflected.add(true);
  if (directionalViews > 0 || lights.spot.some((spot) => spot.lightViewProj !== undefined))
    reflected.add(false);
  return reflected;
}
