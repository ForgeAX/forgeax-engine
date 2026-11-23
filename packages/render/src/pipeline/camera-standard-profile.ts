import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type RenderPipelineAsset, type Result } from '@forgeax/engine-types';
import {
  type AmbientOcclusionData,
  ambientOcclusionParameters,
} from '../components/ambient-occlusion';
import { type Antialias, isMultisampleAntialias } from '../components/camera';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type { PostProcessError } from '../post-process-errors';
import { applyAmbientOcclusionQuality } from '../quality';
import type { RenderProfile } from '../render-contract';
import { DEFERRED_ATTACHMENT_BYTES } from '../standard-attachments';
import { supportsStandardDeferred } from './standard-deferred-capability';
import { standardDeferredAntialiasError } from './standard-path-admission';
import type { StandardProfile } from './standard-profile';

interface CameraStandardDemand {
  readonly antialias?: Antialias | undefined;
  readonly ambientOcclusion?: AmbientOcclusionData | undefined;
  readonly screenSpaceReflection?: object | undefined;
}

interface CameraStandardLane {
  readonly storageBuffer: boolean;
  readonly maxColorAttachments: number;
  readonly maxColorAttachmentBytesPerSample?: number | undefined;
}

function singleLayerWaterFailure(lane: CameraStandardLane): RenderGraphError | undefined {
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
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `selected single-layer-water work requires ${rejected.expected}`,
      hint: 'use a storage/MRT-capable device for the selected Water materials',
      detail: { resourceLabel: 'single-layer-water', ...rejected },
    });
  return undefined;
}

function profileRequiresDeferred(
  profile: StandardProfile,
  requestedPath: RenderProfile['renderPath'] | undefined,
): boolean {
  return (
    requestedPath === 'deferred' ||
    profile.visibleSurface === true ||
    profile.diffuseGi !== undefined ||
    profile.probePlacement !== undefined
  );
}

function shouldSelectDeferredForSsr(
  camera: CameraStandardDemand,
  lane: CameraStandardLane,
  multisample: boolean,
  singleLayerWater: boolean,
  requestedPath: RenderProfile['renderPath'] | undefined,
): boolean {
  return (
    !singleLayerWater &&
    requestedPath !== 'forward' &&
    camera.screenSpaceReflection !== undefined &&
    !multisample &&
    supportsStandardDeferred(lane, lane.maxColorAttachmentBytesPerSample)
  );
}

/** Camera effects and selected material work share one immutable view configuration. */
export function deriveCameraStandardConfiguration(
  profile: StandardProfile | undefined,
  config: RenderPipelineAsset['config'],
  camera: CameraStandardDemand | undefined,
  lane: CameraStandardLane,
  singleLayerWater = false,
  requestedPath?: RenderProfile['renderPath'],
): Result<
  {
    readonly profile: StandardProfile | undefined;
    readonly config: RenderPipelineAsset['config'];
  },
  PostProcessError | RenderGraphError
> {
  if (profile === undefined || camera === undefined) return ok({ profile, config });
  const multisample = isMultisampleAntialias(camera.antialias);
  if (multisample && profileRequiresDeferred(profile, requestedPath ?? profile.renderPath)) {
    const failure = standardDeferredAntialiasError(camera.antialias);
    if (failure !== undefined) return err(failure);
  }
  if (singleLayerWater) {
    const failure = singleLayerWaterFailure(lane);
    if (failure !== undefined) return err(failure);
  }
  const aoRequested = camera.ambientOcclusion !== undefined;
  let selectedProfile =
    multisample && profile.renderPath !== 'forward'
      ? { ...profile, renderPath: 'forward' as const }
      : profile;
  if (!aoRequested && camera.screenSpaceReflection === undefined)
    return ok({ profile: selectedProfile, config });
  let selectedConfig = config;
  if (aoRequested) {
    const defaults = config?.ambientOcclusion ?? profile.ambientOcclusion;
    let ambientOcclusion = { ...defaults, enabled: false };
    if (camera.ambientOcclusion.enabled) {
      const parameters = ambientOcclusionParameters(camera.ambientOcclusion);
      if (!parameters.ok) return err(parameters.error);
      const effective = applyAmbientOcclusionQuality(
        { ...defaults, ...parameters.value },
        profile.quality?.ambientOcclusion,
      );
      ambientOcclusion = { ...effective, enabled: true };
    }
    selectedProfile = { ...selectedProfile, ambientOcclusion };
    selectedConfig = { ...selectedConfig, ambientOcclusion };
  }
  // A Water view uses the selected renderer. The ordinary SSR auto-selection
  // policy still applies to views without Water.
  if (shouldSelectDeferredForSsr(camera, lane, multisample, singleLayerWater, requestedPath))
    selectedProfile = { ...selectedProfile, renderPath: 'deferred' };
  return ok({ profile: selectedProfile, config: selectedConfig });
}
