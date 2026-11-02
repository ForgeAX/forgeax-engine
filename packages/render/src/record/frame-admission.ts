import { recordContext } from '../world/view-record-context';
// Frame admission and scene-input decisions made before any GPU-driven
// preparation: which camera records, whether the device/pipeline may record,
// whether the frame defers to a preparation barrier, and which material,
// subsurface, SSR, visible-surface and probe inputs the frame consumes.

import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import { RendererOperationError } from '../errors/render';
import { resolveDepthOfFieldFrameParams } from '../features/depth-of-field/depth-of-field-params';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { MaterialFrame } from '../scene/material-dispatch';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { SubsurfaceSelection } from '../subsurface/selection';
import { visibleSurfaceOf } from '../world/gi-systems';
import type { ViewLights } from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import type { CubeCaptureFrameInput, FrameRecordingInput } from './frame';
import {
  activeFrameCameras,
  type RenderFrameState,
  resetFrameRecordingOutputs,
  worldEntityKey,
} from './frame-snapshot';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import type { PipelineState, RenderSystemInternals } from './render-context';
import type { RenderFeatureGraphCandidate } from './typed-frame-graph';

/** Cube faces, auxiliary cameras or scene inputs recorded beside the display view. */
export function hasCubeCaptureViews(cubeCapture: CubeCaptureFrameInput | undefined): boolean {
  return (
    (cubeCapture?.scheduledWork.length ?? 0) > 0 ||
    (cubeCapture?.auxiliaryCameras.length ?? 0) > 0 ||
    (cubeCapture?.sceneInputs?.length ?? 0) > 0
  );
}

export function hasReflectionProbeCaptureWork(
  cubeCapture: CubeCaptureFrameInput | undefined,
): boolean {
  return (cubeCapture?.reflectionProbes?.graph.work.length ?? 0) > 0;
}

/** Case D: N>1 Camera fires onError and records the first hit (D-S7). */
export function resolveRecordCamera(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  activeCameras: readonly CameraSnapshot[],
): CameraSnapshot | undefined {
  if (activeCameras.length > 1) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'render-system-multi-camera',
        expected: 'world has exactly one entity with Transform + Camera',
        hint: 'attach CameraView to cameras for ordered simultaneous output; each record invocation accepts one camera',
      }),
    );
  }
  const requestedCamera = activeCameras[0];
  if (!requestedCamera) return undefined;
  const frameDepthOfField = resolveDepthOfFieldFrameParams(
    requestedCamera.depthOfField,
    requestedCamera.depthOfFieldError,
    frameState.depthOfFieldAccepted?.params,
  );
  return frameDepthOfField === undefined || frameDepthOfField === requestedCamera.depthOfField
    ? requestedCamera
    : { ...requestedCamera, depthOfField: frameDepthOfField };
}

/** Camera admission also determines whether this request has a scene draw domain. */
export function admitRecordScene(
  input: Pick<
    FrameRecordingInput,
    'internals' | 'frameState' | 'cameras' | 'renderables' | 'transparentDispatch' | 'gpuDriven'
  >,
) {
  const camera = resolveRecordCamera(
    input.internals,
    input.frameState,
    activeFrameCameras(input.cameras),
  );
  if (input.cameras.length === 0)
    return { camera, renderables: [], transparentDispatch: [], gpuDriven: undefined };
  return {
    camera,
    renderables: input.renderables,
    transparentDispatch: input.transparentDispatch,
    gpuDriven: input.gpuDriven,
  };
}

/** Probe placement admits only one perspective display view without capture views. */
export function assertProbePlacementSingleView(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  cameraCount: number,
  cubeCapture: CubeCaptureFrameInput | undefined,
  captureOnly: boolean,
): void {
  if (internals.standardProfile?.probePlacement === undefined) return;
  if (
    captureOnly ||
    cameraCount !== 1 ||
    camera.projection !== 'perspective' ||
    hasCubeCaptureViews(cubeCapture) ||
    hasReflectionProbeCaptureWork(cubeCapture) ||
    (recordContext(internals).featureSceneInputs?.work.length ?? 0) > 0 ||
    camera.planarReflection !== undefined
  ) {
    frameState.probePlacement?.disable();
    throw new RhiError({
      code: 'rhi-not-available',
      expected:
        'one perspective display view without auxiliary, Cube, reflection or scene-input capture views for probe placement',
      hint: 'disable placement or remove the additional views before recording',
    });
  }
}

function assertAtmosphereAdmission(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
): void {
  if (
    frameState.environmentFrame?.source.kind !== 'atmosphere' ||
    (pipelineState.atmosphereAvailable === true &&
      internals.device.caps.compute &&
      internals.device.caps.storageTexture &&
      internals.device.caps.rgba16floatRenderable &&
      (internals.device.limits.maxTextureDimension3D ?? 0) >= 32)
  ) {
    return;
  }
  throw new RhiError({
    code: 'rhi-not-available',
    expected: `Atmosphere admission: bindings=${pipelineState.atmosphereAvailable}, compute=${internals.device.caps.compute}, storage=${internals.device.caps.storageTexture}, float=${internals.device.caps.rgba16floatRenderable}, dimension3D=${internals.device.limits.maxTextureDimension3D}, sampled=${internals.device.limits.maxSampledTexturesPerShaderStage}`,
    hint: 'select a device meeting the atmosphere capabilities or remove Atmosphere',
    detail: {
      error: {
        code: 'atmosphere-capability-unavailable',
        message: 'Atmosphere device admission failed',
        detail: {
          atmosphereAvailable: pipelineState.atmosphereAvailable,
          caps: internals.device.caps,
          limits: internals.device.limits,
        },
      },
    },
  });
}

/** The installed pipeline state, or null when this frame cannot record on it. */
export function admitFramePipeline(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): PipelineState | null {
  const pipelineState = recordContext(internals).getPipelineState();
  if (pipelineState === null) return null;
  assertAtmosphereAdmission(internals, frameState, pipelineState);
  if (pipelineState.device !== internals.device) {
    internals.errorRegistry.fire(
      new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        cause: {
          code: 'pipeline-device-mismatch',
          expected: 'pipelineState.device === runtime.device',
          hint: 'discard stale pipeline state before recording the next frame',
          detail: {
            expected: 'pipelineState.device === runtime.device',
            hint: 'discard stale pipeline state before recording the next frame',
          },
        },
      }),
    );
    return null;
  }
  return pipelineState;
}

export function resetFrameAttemptOutputs(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): void {
  resetFrameRecordingOutputs(frameState.frameOutputs);
  if (frameState.reflectionFallbackReadback !== undefined) {
    internals.device.destroyBuffer(frameState.reflectionFallbackReadback.buffer);
    frameState.reflectionFallbackReadback = undefined;
  }
}

function authoredImagePending(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  skylight: SkylightSnapshot | undefined,
  skybox: SkyboxSnapshot | undefined,
): boolean {
  return [skylight?.equirectHandle, skybox?.equirectHandle].some(
    (handle) =>
      handle !== undefined &&
      handle !== 0 &&
      internals.gpuStore.getCubemapStatus(handle as AssetHandle<'equirect'>, world) === 'pending',
  );
}

function retainedPictureMatchesCanvas(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): boolean {
  const retained = frameState.lastSuccessfulBarrelDistortion;
  return (
    retained !== undefined &&
    retained.width === recordContext(internals).canvas.width &&
    retained.height === recordContext(internals).canvas.height
  );
}

/** The display carries no exposure, LUT or resolution history that a barrier would stall. */
function displayHasNoAdaptiveState(frameState: RenderFrameState, camera: CameraSnapshot): boolean {
  return (
    (camera.output === undefined ||
      (camera.output.exposure.kind === 'manual' && camera.output.colorLut === 0)) &&
    frameState.autoExposureState === undefined &&
    frameState.standardLutState.lastKnownGood === null &&
    camera.dynamicResolution === undefined
  );
}

function featureGraphCandidateIsEmpty(candidate: RenderFeatureGraphCandidate | undefined): boolean {
  return (
    (candidate?.plans.every(
      ({ plan }) => plan.resources.length === 0 && plan.passes.length === 0,
    ) ??
      true) &&
    (candidate?.fullscreenEffects.size ?? 0) === 0
  );
}

/**
 * Do not fill the GPU queue with fallback display frames while an authored
 * image is being prepared after its first picture, including planar reflections.
 * Cube/probe captures and nonempty Feature dependencies keep
 * their complete recording path.
 */
export function shouldDeferImageDisplay(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  cameraCount: number,
  captureOnly: boolean,
  skylight: SkylightSnapshot | undefined,
  skybox: SkyboxSnapshot | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  cubeCapture: CubeCaptureFrameInput | undefined,
): boolean {
  return (
    authoredImagePending(internals, world, skylight, skybox) &&
    retainedPictureMatchesCanvas(internals, frameState) &&
    !captureOnly &&
    cameraCount === 1 &&
    displayHasNoAdaptiveState(frameState, camera) &&
    featureGraphCandidateIsEmpty(featureGraphCandidate) &&
    // Planar views share this display's pending sky; independent captures
    // still need their own recording path.
    (cubeCapture?.scheduledWork.length ?? 0) === 0 &&
    (cubeCapture?.sceneInputs?.length ?? 0) === 0 &&
    !(cubeCapture?.auxiliaryCameras.some((view) => view.planarReflection === undefined) ?? false) &&
    !hasReflectionProbeCaptureWork(cubeCapture)
  );
}

/** Hand-authored recorder inputs have no Scene owner; freeze their roots once. */
export function resolveFrameMaterials(
  projection: PersistentShadowCasterProjection | undefined,
  sourceRenderables: FrameList<RenderableSnapshot>,
): { readonly materials: MaterialFrame; readonly manualSubsurface?: SubsurfaceSelection } {
  if (projection !== undefined) return { materials: projection.content.materials };
  const manualSubsurface = new SubsurfaceSelection();
  let materials = new MaterialFrame(undefined);
  for (const source of sourceRenderables) {
    for (const resource of source.materials.length === 0 ? [source.material] : source.materials)
      if (materials.get(resource) === undefined) materials = materials.with(resource);
    manualSubsurface.add(source, materials);
  }
  return { materials, manualSubsurface };
}

/** Renderer recording of a current retained scene may reuse fixed directional shadow meshes. */
export function isFixedShadowDomain(
  rendererRecording: boolean,
  captureOnly: boolean,
  nativeScene: PersistentGpuDrivenState | undefined,
  projection: PersistentShadowCasterProjection | undefined,
  lights: ViewLights,
  effectiveShadowMapSize: number | undefined,
): boolean {
  return (
    rendererRecording &&
    !captureOnly &&
    nativeScene?.retained?.isSourceCurrent() === true &&
    nativeScene.unbatchedSlots?.size === 0 &&
    projection !== undefined &&
    (projection.content.viewDraws?.length ?? 0) === 0 &&
    (lights.cascades?.cascadeCount ?? 0) > 0 &&
    (effectiveShadowMapSize ?? 0) > 0
  );
}

/** Admit the frame's shared visible-surface rows for this view's geometry. */
export function projectFrameVisibleSurface(
  internals: RenderSystemInternals,
  scene: PersistentGpuDrivenState | undefined,
  renderables: FrameList<RenderableSnapshot>,
): VisibleSurfaceProjection | undefined {
  if (internals.standardProfile?.visibleSurface !== true) return undefined;
  if (scene === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the retained RenderScene for visible-surface projection',
      hint: 'prepare the ordinary renderer scene before enabling visible surfaces',
    });
  // The `visible-surface-rows` RenderPrepare system projected the shared rows.
  const state = visibleSurfaceOf(renderWorldFor(internals));
  if (state?.failure !== undefined) throw state.failure;
  const visibleSurface = state?.projection;
  if (visibleSurface === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the visible-surface rows of the frame scene',
      hint: 'record visible surfaces inside a Render World frame of the composition owner',
    });
  for (const source of renderables) {
    if (
      (source.instances?.instanceCount ?? 1) * 128 >
      internals.device.limits.maxStorageBufferBindingSize
    ) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'qualified unchunked rigid instance addressing for visible surfaces',
        hint: 'this first admission does not yet cover storage-split instance draws',
      });
    }
  }
  return visibleSurface;
}

function manualProbeBlendRecords(renderables: FrameList<RenderableSnapshot>) {
  return renderables.flatMap((source) => {
    const record = source.probeBlendRecord;
    return record === undefined
      ? []
      : [{ cacheKey: worldEntityKey(source.worldId, source.entityKey), record }];
  });
}

/** The retained scene projection preserves its delta-upload fast path for deferred too. */
export function prepareDeferredProbeBuffer(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  standard: StandardTopologyInputValue,
  scene: PersistentGpuDrivenState | undefined,
  renderables: FrameList<RenderableSnapshot>,
): Buffer | undefined {
  if (standard.prepared.renderPath !== 'deferred') return undefined;
  const projection = scene?.probeBlend;
  const records = projection?.records ?? manualProbeBlendRecords(renderables);
  const capacity =
    projection?.capacity ??
    records.reduce((max, { record }) => Math.max(max, record.objectKey + 2), 1);
  if (capacity > 0x1000000)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'deferred probe rows fit 24 bits',
      hint: 'reduce the retained probe object roster',
    });
  return ensureProbeBlendRecordBuffer(internals.device, frameState, projection ?? records);
}
