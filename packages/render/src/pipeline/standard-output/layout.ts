import { standardBloomAdmitted } from '../../bloom-admission';
import { isFxaaAntialias, isTemporalAntialias } from '../../components/camera';
import type { RenderPipelineTopology } from '../../render-pipeline';

export const StandardOutputStage = {
  temporal: 1 << 0,
  bloom: 1 << 1,
  depthOfField: 1 << 2,
  chromaticAberration: 1 << 3,
  lensFlare: 1 << 4,
  outline: 1 << 5,
  barrelDistortion: 1 << 6,
  lensEffects: 1 << 7,
  fxaa: 1 << 8,
  smaa: 1 << 9,
  autoExposure: 1 << 10,
  whiteBalance: 1 << 11,
  colorLut: 1 << 12,
} as const;

function cameraOutputStages(camera: RenderPipelineTopology['camera']): number {
  const stage = StandardOutputStage;
  return (
    (isTemporalAntialias(camera.antialias) ? stage.temporal : 0) |
    (standardBloomAdmitted(camera) ? stage.bloom : 0) |
    (camera.depthOfField === undefined ? 0 : stage.depthOfField) |
    (camera.chromaticAberration === true ? stage.chromaticAberration : 0) |
    (camera.lensFlare === true ? stage.lensFlare : 0) |
    (camera.outline === true || typeof camera.outline === 'object' ? stage.outline : 0) |
    (camera.barrelDistortion === true ? stage.barrelDistortion : 0) |
    (camera.lensEffects === true ? stage.lensEffects : 0) |
    (isFxaaAntialias(camera.antialias) ? stage.fxaa : 0) |
    (camera.antialias === 'smaa' ? stage.smaa : 0)
  );
}

/** Post stages selected by this view. Their draw parameters stay frame-local. */
export function standardOutputStages(topology: RenderPipelineTopology): number {
  if (topology.clearOnly || topology.camera.postProcessing === false) return 0;
  const { camera, output } = topology;
  const stage = StandardOutputStage;
  return (
    cameraOutputStages(camera) |
    (output?.autoExposure === true ? stage.autoExposure : 0) |
    (output?.whiteBalance === true ? stage.whiteBalance : 0) |
    (output?.colorLut === true ? stage.colorLut : 0)
  );
}

export function premultipliedOutlineActive(camera: RenderPipelineTopology['camera']): boolean {
  return camera.postProcessing === true && camera.outline === true;
}

export function standardAutoExposureMode(
  lane: RenderPipelineTopology['lane'],
): 'compute' | 'fragment' {
  return lane.compute && lane.storageBuffer ? 'compute' : 'fragment';
}

/** Grade reads the issuing camera and writes directly to a display-capable surface. */
export function usesNativeGrade(topology: RenderPipelineTopology): boolean {
  return (
    topology.config?.outputContract === 'standard-output-v2' &&
    topology.surface.profile?.kind !== 'raw-only' &&
    !topology.clearOnly
  );
}

/** These consumers require a separately addressable linear image after Grade. */
export function nativeGradeNeedsLinearImage(
  camera: RenderPipelineTopology['camera'],
  observeLinear: boolean,
): boolean {
  return (
    observeLinear ||
    camera.editorAssistance === true ||
    camera.editorOutline === true ||
    (camera.postProcessing !== false &&
      (!!camera.outline || camera.barrelDistortion === true || camera.antialias === 'smaa'))
  );
}

/** A lens value changes overlay order only across a physical linear-image boundary. */
export function nativeGradeOverlaysLinearImage(
  camera: RenderPipelineTopology['camera'],
  observeLinear: boolean,
): boolean {
  return (
    camera.postProcessing !== false &&
    (camera.barrelDistortion === true || camera.lensEffects === true) &&
    nativeGradeNeedsLinearImage(camera, observeLinear)
  );
}
