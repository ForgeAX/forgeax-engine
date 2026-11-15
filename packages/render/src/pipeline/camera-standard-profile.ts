import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type RenderPipelineAsset, type Result } from '@forgeax/engine-types';
import {
  type AmbientOcclusionData,
  ambientOcclusionParameters,
} from '../components/ambient-occlusion';
import type { Antialias } from '../components/camera';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type { PostProcessError } from '../post-process-errors';
import { DEFERRED_ATTACHMENT_BYTES } from '../standard-attachments';
import { supportsStandardDeferred } from './standard-deferred-capability';
import type { StandardProfile } from './standard-profile';

interface CameraStandardDemand {
  readonly antialias?: Antialias | undefined;
  readonly ambientOcclusion?: AmbientOcclusionData | undefined;
  readonly screenSpaceReflection?: object | undefined;
}

/** Camera effects and selected material work share one immutable view configuration. */
export function deriveCameraStandardConfiguration(
  profile: StandardProfile | undefined,
  config: RenderPipelineAsset['config'],
  camera: CameraStandardDemand | undefined,
  lane: {
    readonly storageBuffer: boolean;
    readonly maxColorAttachments: number;
    readonly maxColorAttachmentBytesPerSample?: number | undefined;
  },
  singleLayerWater = false,
): Result<
  {
    readonly profile: StandardProfile | undefined;
    readonly config: RenderPipelineAsset['config'];
  },
  PostProcessError | RenderGraphError
> {
  if (profile === undefined || camera === undefined) return ok({ profile, config });
  const waterMsaa = singleLayerWater && camera.antialias === 'msaa';
  if (singleLayerWater) {
    const rejected = !lane.storageBuffer
      ? {
          field: 'lane.storageBuffer',
          expected: 'storage buffers',
          actual: String(lane.storageBuffer),
        }
      : lane.maxColorAttachments < DEFERRED_COLOR_FORMATS.length
        ? {
            field: 'lane.maxColorAttachments',
            expected: `${DEFERRED_COLOR_FORMATS.length} color attachments`,
            actual: String(lane.maxColorAttachments),
          }
        : (lane.maxColorAttachmentBytesPerSample ?? 32) < DEFERRED_ATTACHMENT_BYTES.surface
          ? {
              field: 'lane.maxColorAttachmentBytesPerSample',
              expected: `${DEFERRED_ATTACHMENT_BYTES.surface} attachment bytes/sample`,
              actual: String(lane.maxColorAttachmentBytesPerSample ?? 32),
            }
          : undefined;
    if (rejected !== undefined)
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: `selected single-layer-water work requires ${rejected.expected}`,
          hint: 'use a storage/MRT-capable device for the selected Water materials',
          detail: { resourceLabel: 'single-layer-water', ...rejected },
        }),
      );
  }
  const aoRequested = camera.ambientOcclusion !== undefined;
  const deferredEligible = supportsStandardDeferred(lane, lane.maxColorAttachmentBytesPerSample);
  let selectedProfile = singleLayerWater
    ? { ...profile, renderPath: waterMsaa ? ('forward' as const) : ('deferred' as const) }
    : profile;
  if (!aoRequested && camera.screenSpaceReflection === undefined)
    return ok({ profile: selectedProfile, config });
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
  if (camera.screenSpaceReflection !== undefined && deferredEligible && !waterMsaa)
    selectedProfile = { ...selectedProfile, renderPath: 'deferred' };
  return ok({ profile: selectedProfile, config: selectedConfig });
}
