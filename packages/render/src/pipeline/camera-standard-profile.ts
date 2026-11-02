import { err, ok, type RenderPipelineAsset, type Result } from '@forgeax/engine-types';
import {
  type AmbientOcclusionData,
  ambientOcclusionParameters,
} from '../components/ambient-occlusion';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type { PostProcessError } from '../post-process-errors';
import type { StandardProfile } from './standard-profile';

interface CameraStandardDemand {
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
  if (profile === undefined || camera === undefined) return ok({ profile, config });
  const aoRequested = camera.ambientOcclusion !== undefined;
  const deferredEligible =
    lane.storageBuffer && lane.maxColorAttachments >= DEFERRED_COLOR_FORMATS.length;
  if (!aoRequested && camera.screenSpaceReflection === undefined) return ok({ profile, config });

  let selectedProfile = profile;
  let selectedConfig = config;
  if (aoRequested) {
    const parameters = ambientOcclusionParameters(camera.ambientOcclusion);
    if (!parameters.ok) return err(parameters.error);
    // AO is a view-local lighting input and does not require the Deferred
    // GBuffer. Its own SceneData producer admits Forward on no-storage lanes.
    selectedProfile = { ...selectedProfile, ssao: parameters.value };
    selectedConfig = { ...selectedConfig, ssao: { enabled: true, ...parameters.value } };
  }
  // SSR retains its independent storage/MRT admission policy. When AO is also
  // requested on an ineligible device, keep Forward and still honor AO.
  if (camera.screenSpaceReflection !== undefined && deferredEligible)
    selectedProfile = { ...selectedProfile, renderPath: 'deferred' };
  return ok({ profile: selectedProfile, config: selectedConfig });
}
