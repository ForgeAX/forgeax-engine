import { err, ok, type RenderPipelineAsset, type Result } from '@forgeax/engine-types';
import {
  type AmbientOcclusionData,
  ambientOcclusionParameters,
} from '../components/ambient-occlusion';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type { PostProcessError } from '../post-process-errors';
import type { StandardProfile } from './standard-profile';

export interface CameraStandardDemand {
  readonly ambientOcclusion?: AmbientOcclusionData | undefined;
  readonly screenSpaceReflection?: object | undefined;
}

/** Author configuration is immutable; the selected view owns this projection. */
export function deriveCameraStandardConfiguration(
  profile: StandardProfile | undefined,
  config: RenderPipelineAsset['config'],
  camera: CameraStandardDemand | undefined,
  lane: { readonly storageBuffer: boolean; readonly maxColorAttachments: number },
): Result<
  {
    readonly profile: StandardProfile | undefined;
    readonly config: RenderPipelineAsset['config'];
  },
  PostProcessError
> {
  if (
    profile === undefined ||
    (camera?.ambientOcclusion === undefined && camera?.screenSpaceReflection === undefined) ||
    !lane.storageBuffer ||
    lane.maxColorAttachments < DEFERRED_COLOR_FORMATS.length
  ) {
    return ok({ profile, config });
  }
  if (camera.ambientOcclusion === undefined) {
    return ok({ profile: { ...profile, renderPath: 'deferred' }, config });
  }
  const parameters = ambientOcclusionParameters(camera.ambientOcclusion);
  if (!parameters.ok) return err(parameters.error);
  return ok({
    profile: { ...profile, renderPath: 'deferred', ssao: parameters.value },
    config: { ...config, ssao: { enabled: true, ...parameters.value } },
  });
}
