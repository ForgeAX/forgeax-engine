import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';

/** CPU exclusion and GPU recording must use the same accepted raster facts. */
export function gpuTemporalEligible(
  material: string | undefined,
  deformation: 'rigid' | 'skin' | undefined,
  lodLevels: number,
): boolean {
  return isStandardPbrMaterialShader(material) && deformation === 'rigid' && lodLevels > 1;
}

export function gpuRasterFilterMatches(
  filter: RenderPipelineGpuDrivenFilter | undefined,
  materialPass: 'deferred' | 'forward-only' | undefined,
  medium: boolean,
): boolean {
  return !(
    (filter === 'single-layer-medium' && !medium) ||
    ((filter === 'opaque' || filter === 'deferred-opaque' || filter === 'forward-only-opaque') &&
      medium) ||
    (filter === 'deferred-opaque' && materialPass !== 'deferred') ||
    (filter === 'forward-only-opaque' && materialPass === 'deferred')
  );
}
