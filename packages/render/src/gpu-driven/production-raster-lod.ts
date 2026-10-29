import { mat4, vec3 } from '@forgeax/engine-math';
import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import type { CameraSnapshot } from '../render-contract';
import { batchLodLevelCount } from './batch-layout';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';

/** Indirect raster commands of admitted batches: one per LOD level slot. */
export function admittedRasterBatchCount(plan: SubmissionPlan): number {
  return plan.batches.reduce(
    (count, batch) => count + (batch.visibleCapacity > 0 ? batchLodLevelCount(batch) : 0),
    0,
  );
}

/** Only rigid Standard PBR shading reads the per-item LOD fade. */
export function lodCrossfadeCapable(batch: Pick<GpuDrivenBatch, 'prepared'>): boolean {
  return (
    isStandardPbrMaterialShader(batch.prepared?.identity.material) &&
    batch.prepared?.identity.deformation === 'rigid'
  );
}

/**
 * Whether the GPU cull may write a nonzero LOD fade into this batch's visible
 * items. A filtered batch keeps its source coverages and only upgrades
 * `crossfade` under this capability, so the source and every filtered view of
 * it give the same, conservative answer. False lets the Standard surface
 * compile out its dither discard.
 */
export function lodCoverageMayFade(batch: Pick<GpuDrivenBatch, 'prepared' | 'lod'>): boolean {
  return (
    batch.lod?.crossfade === true ||
    (lodCrossfadeCapable(batch) && (batch.lod?.coverages.length ?? 0) > 1)
  );
}

/**
 * The LOD camera equivalent of a light view-projection, so shadow casters
 * rank by their footprint in the shadow target with the main camera's height
 * semantics. The clip-y row norm is `2 / orthoHeight` (orthographic) or
 * `1 / tan(fov / 2)` (perspective); a perspective eye is the point clip w
 * vanishes at, `M^-1 * (0, 0, 1, 0)`.
 */
export function lodViewCameraFromMatrix(
  matrix: Float32Array,
): Pick<CameraSnapshot, 'position' | 'projection' | 'fov' | 'orthoTop' | 'orthoBottom'> {
  const rowY = Math.hypot(matrix[1] ?? 0, matrix[5] ?? 0, matrix[9] ?? 0);
  const perspective = (matrix[3] ?? 0) !== 0 || (matrix[7] ?? 0) !== 0 || (matrix[11] ?? 0) !== 0;
  if (!perspective) {
    const half = rowY > 0 ? 1 / rowY : 0;
    return {
      position: vec3.create(),
      projection: 'orthographic',
      fov: 0,
      orthoTop: half,
      orthoBottom: -half,
    };
  }
  const inverse = mat4.invert(mat4.create(), matrix);
  const w = inverse[11] ?? 0;
  return {
    position: vec3.create((inverse[8] ?? 0) / w, (inverse[9] ?? 0) / w, (inverse[10] ?? 0) / w),
    projection: 'perspective',
    fov: rowY > 0 ? 2 * Math.atan(1 / rowY) : 0,
    orthoTop: 1,
    orthoBottom: -1,
  };
}

/**
 * Coarsest level a shadow view rasters a caster at. A coarser silhouette would
 * self-shadow the visible mesh with depth it does not have; the bound depends
 * on no camera, so a retained shadow layer never re-rasters for camera motion.
 */
export const SHADOW_LOD_COARSEST = 1;
