import type { RenderPipelineTopology } from '../../render-pipeline';

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
