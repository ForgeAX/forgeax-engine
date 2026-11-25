import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';

/** CPU exclusion and GPU recording must use the same accepted raster facts. */
export function gpuTemporalEligible(
  material: string | undefined,
  deformation: 'rigid' | 'skin' | undefined,
  lodLevels: number,
  filter?: RenderPipelineGpuDrivenFilter,
): boolean {
  const depthVelocity = filter === 'opaque-depth-velocity';
  return (
    deformation === 'rigid' &&
    (isStandardPbrMaterialShader(material) ||
      (depthVelocity && material === 'forgeax::default-unlit')) &&
    (depthVelocity || lodLevels > 1)
  );
}

export function gpuRasterFilterMatches(
  filter: RenderPipelineGpuDrivenFilter | undefined,
  materialPass: 'deferred' | 'forward-only' | undefined,
  medium: boolean,
): boolean {
  return !(
    (filter === 'single-layer-medium' && !medium) ||
    ((filter === 'opaque' ||
      filter === 'opaque-depth-velocity' ||
      filter === 'deferred-opaque' ||
      filter === 'forward-only-opaque') &&
      medium) ||
    (filter === 'deferred-opaque' && materialPass !== 'deferred') ||
    (filter === 'forward-only-opaque' && materialPass === 'deferred')
  );
}

export function isVelocityRasterEntry(entry: string | undefined): boolean {
  return entry === 'fs_temporal' || isDepthVelocityEntry(entry);
}

export function isDepthVelocityEntry(entry: string | undefined): boolean {
  return entry === 'fs_temporal_depth' || entry === 'fs_scene_velocity';
}
