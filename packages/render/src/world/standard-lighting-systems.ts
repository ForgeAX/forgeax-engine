import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { RendererOperationError } from '../errors/render';
import { resetViewFeatures } from '../features/view-feature-work';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { resolveFrameMaterials } from '../record/frame-admission';
import {
  prepareFrameLighting,
  warnZeroLightStandard,
  writeShadowParamsBuffer,
} from '../record/frame-lighting';
import type { RenderFrameState } from '../record/frame-snapshot';
import { prepareViewSky, warnIgnoredDirectionalShadowCasters } from '../record/helpers';
import { activeRenderProfileSession } from '../record/profile-session';
import {
  type PipelineState,
  type RenderSystemInternals,
  recordProfileRunner,
  runRecordProfilePhase,
} from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import { sameAmbientOcclusionSettings } from '../ssao-config';
import {
  RenderCascadeFitOrder,
  RenderEnvironmentAdmitOrder,
  RenderStandardLightingOrder,
  RenderViewFrameOrder,
} from '../system-order';

import { viewLightsOf } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission, renderWorldFor } from './render-world';
import { readViewState, requireViewField } from './view-field';
import { stagedViewInputs, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const RENDER_STANDARD_LIGHTING_SYSTEM = 'render-standard-lighting';

/** A view's prepared Standard lighting: directional fallback, local corpus and Cluster topology. */
export type FrameLighting = ReturnType<typeof prepareFrameLighting>;

/** What prepared Standard lighting was derived against; recording rejects a moved fence. */
export interface StandardLightingFence {
  readonly pipelineState: PipelineState | null;
  readonly pipelineHandle: number;
  readonly deviceGeneration: number;
}

/**
 * One view's `render-standard-lighting` outcome. `not-admitted`: the view has
 * no fitted lights or its camera Standard configuration was rejected (and
 * reported), so the view records nothing this frame.
 */
export type ViewStandardLightingOutcome =
  | {
      readonly kind: 'prepared';
      readonly lighting: FrameLighting;
      readonly fence: StandardLightingFence;
    }
  | { readonly kind: 'not-admitted' }
  | { readonly kind: 'failed'; readonly cause: unknown };

interface ViewStandardLightingState {
  frame: number;
  outcome: ViewStandardLightingOutcome;
}

/** A recording view's RenderPrepare Standard lighting; written only by `render-standard-lighting`. */
export const ViewStandardLighting = defineComponent('ViewStandardLighting', {
  state: 'unique<ViewStandardLighting>',
});

/** The view's lighting prepared this renderer frame; undefined when the system did not run for it. */
export function viewStandardLightingOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewStandardLightingOutcome | undefined {
  const state = readViewState<ViewStandardLightingState>(world, entity, ViewStandardLighting);
  if (state === undefined) return undefined;
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** Store `entity`'s Standard lighting outcome of the current renderer frame. */
export function storeViewStandardLighting(
  world: World,
  entity: EntityHandle,
  outcome: ViewStandardLightingOutcome,
): void {
  const frame = renderSubmission(world).frame;
  if (!world.hasComponent(entity, ViewStandardLighting)) {
    const state = world.allocUniqueRef('ViewStandardLighting', { frame, outcome });
    world.addComponent(entity, { component: ViewStandardLighting, data: { state } }).unwrap();
    return;
  }
  const state = world
    .resolveUniqueRef<ViewStandardLightingState>(
      requireViewField(world, entity, ViewStandardLighting, 'state'),
    )
    .unwrap();
  state.frame = frame;
  state.outcome = outcome;
}

/**
 * Whether this recording's view admitted its camera Standard configuration.
 * A view whose preparation failed rethrows inside its own record recovery.
 */
export function admitViewStandardLighting(internals: RenderSystemInternals): boolean {
  const outcome = viewStandardLightingOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_STANDARD_LIGHTING_SYSTEM} did not prepare the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome.kind === 'prepared';
}

/**
 * The Standard lighting this recording draws with. A Render World view takes
 * what `render-standard-lighting` prepared and rejects the submission when the
 * pipeline state, its configuration epoch or the device moved since
 * RenderPrepare; the next frame prepares again. A direct recorder outside a
 * Render World view prepares its own lighting.
 */
export function consumeViewStandardLighting(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  direct: () => FrameLighting,
): FrameLighting {
  if (internals.viewEntity === undefined) return direct();
  const outcome = viewStandardLightingOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined || outcome.kind === 'not-admitted')
    throw new Error(`A view records only the lighting ${RENDER_STANDARD_LIGHTING_SYSTEM} prepared`);
  if (outcome.kind === 'failed') throw outcome.cause;
  const { fence } = outcome;
  if (
    fence.pipelineState !== pipelineState ||
    fence.pipelineHandle !== frameState.installedPipelineHandle ||
    fence.deviceGeneration !== recordContext(internals).deviceScope.generation
  )
    throw new RendererOperationError('frame-submit-rejected', {
      operation: 'draw',
      stage: 'submit',
      accepted: false,
    });
  return outcome.lighting;
}

/**
 * Derive the view's Standard configuration from its selected camera before
 * its lighting prepares. Capture-only snapshots omit display companions and
 * therefore restore the author configuration. A changed render path or SSAO
 * brands a new installed pipeline and re-contributes its Feature graph state;
 * the prior compiled graph remains last-known-good until compilation.
 */
function resolveCameraViewportOutput(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
) {
  const install = frameState.standardInstall;
  const vpExt = internals.viewportOutput;
  const previousVpBucket = frameState.viewportOutputResolution?.topologyBucket;
  const isCaptureView = recordContext(internals).captureView !== undefined;
  let vpResolution: import('../viewport-output-contract').ViewportOutputResolution | undefined;
  if (vpExt !== undefined && !isCaptureView && vpExt.getMode() !== 'lit') {
    const baseAo =
      camera?.ambientOcclusion !== undefined
        ? camera.ambientOcclusion.enabled
        : (install.configured?.ambientOcclusion?.enabled ??
          internals.standardProfile?.ambientOcclusion?.enabled ??
          false);
    vpResolution = vpExt.resolveView({
      deviceCaps: internals.device.caps,
      deviceLimits: internals.device.limits,
      antialias: camera?.antialias,
      profile: internals.standardProfile,
      ambientOcclusionEnabled: baseAo,
      compactGbuffer: internals.standardProfile?.gbufferFormat === 'default',
      hasReceiverGeometry: internals.standardProfile?.gbufferFormat !== 'default',
    });
  }
  frameState.viewportOutputResolution = vpResolution;
  const forceDeferredForDebug = vpResolution?.activePath === 'gbuffer-visualizer';
  const effectiveCamera =
    forceDeferredForDebug &&
    camera !== undefined &&
    (vpResolution?.suspendMsaa || vpResolution?.suspendTemporalAa)
      ? { ...camera, antialias: 'none' as const }
      : camera;
  const effectiveProfile = forceDeferredForDebug
    ? {
        ...(internals.standardProfile ?? DEFAULT_STANDARD_PROFILE),
        renderPath: 'deferred' as const,
      }
    : internals.standardProfile;
  const effectiveRequestedPath = forceDeferredForDebug
    ? ('deferred' as const)
    : internals.requestedStandardProfile?.renderPath;
  return {
    previousVpBucket,
    vpResolution,
    effectiveCamera,
    effectiveProfile,
    effectiveRequestedPath,
  };
}

function admitCameraConfiguration(
  { frameState, internals }: ViewSettlementOwner,
  camera: CameraSnapshot | undefined,
  singleLayerWater: boolean,
): boolean {
  const install = frameState.standardInstall;
  const lane = {
    storageBuffer: internals.device.caps.storageBuffer,
    maxColorAttachments: internals.device.caps.maxColorAttachments,
    maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
  };
  const {
    previousVpBucket,
    vpResolution,
    effectiveCamera,
    effectiveProfile,
    effectiveRequestedPath,
  } = resolveCameraViewportOutput(frameState, internals, camera);
  let configuration = deriveCameraStandardConfiguration(
    effectiveProfile,
    install.configured,
    effectiveCamera,
    lane,
    singleLayerWater,
    effectiveRequestedPath,
  );
  if (!configuration.ok) {
    const failureKey = JSON.stringify([configuration.error.code, configuration.error.detail]);
    if (failureKey !== install.cameraFailure) {
      internals.errorRegistry.fire(configuration.error);
      install.cameraFailure = failureKey;
    }
    if (configuration.error.code === 'resource-descriptor-invalid') return false;
    // Invalid AO cannot prevent independently required material or SSR work.
    configuration = deriveCameraStandardConfiguration(
      effectiveProfile,
      install.configured,
      {
        antialias: effectiveCamera?.antialias,
        screenSpaceReflection: effectiveCamera?.screenSpaceReflection,
      },
      lane,
      singleLayerWater,
      effectiveRequestedPath,
    );
  } else {
    install.cameraFailure = '';
  }
  if (!configuration.ok) return false;
  const previousProfile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const previousPath = previousProfile?.renderPath;
  const previousAo = frameState.installedPipelineConfig?.ambientOcclusion;
  const { profile, config } = configuration.value;
  const changed =
    !install.cameraConfigured ||
    profile?.renderPath !== previousPath ||
    profile?.cloudMode0Model !== previousProfile?.cloudMode0Model ||
    !sameAmbientOcclusionSettings(previousAo, config?.ambientOcclusion) ||
    vpResolution?.topologyBucket !== previousVpBucket;
  frameState.cameraStandardProfile = profile;
  frameState.installedPipelineConfig = config;
  if (changed) {
    install.cameraConfigured = true;
    frameState.installedPipelineHandle += 1;
    resetViewFeatures(frameState);
    install.built = frameState.installedPipelineHandle;
  }
  return true;
}

/**
 * Admit a staged view's camera Standard configuration and prepare its
 * Standard lighting from its fitted lights. Never throws: a failure is the
 * view's outcome, rethrown by its recording.
 */
function prepareViewStandardLighting(
  world: World,
  owner: ViewSettlementOwner,
  entity: EntityHandle,
  staged: ViewFrameState,
): ViewStandardLightingOutcome {
  try {
    const { cameras, frame, source: resourceWorld } = stagedViewInputs(world, staged);
    const lights = viewLightsOf(world, entity);
    const projection = owner.scene.shadowCasterProjection();
    const { materials } = resolveFrameMaterials(
      projection,
      projection?.renderables ?? frame.renderables,
    );
    const singleLayerWater =
      materials.hasWater ||
      owner.frameState.candidatePipelinePreparations?.materials.hasWater === true;
    if (lights === undefined || !admitCameraConfiguration(owner, cameras[0], singleLayerWater))
      return { kind: 'not-admitted' };
    const { internals, frameState } = owner;
    const pipelineState = recordContext(internals).getPipelineState();
    const camera = cameras[0];
    const lighting = runRecordProfilePhase(
      recordProfileRunner(activeRenderProfileSession(internals)),
      'record/scene-state/lighting-prep',
      () =>
        prepareFrameLighting(
          internals,
          frameState,
          lights,
          camera,
          pipelineState ?? undefined,
          frame.renderables,
          projection?.renderables,
        ),
    );
    prepareViewSky(internals, resourceWorld, frameState, frame);
    warnIgnoredDirectionalShadowCasters(frameState, frame.lights);
    if (lighting.ok) {
      warnZeroLightStandard(
        frameState,
        frame.renderables,
        frame.skylight,
        lighting.value.totalLightCount,
      );
      // The point/spot shadow params follow the lights this view just prepared.
      if (pipelineState !== null) writeShadowParamsBuffer(internals, frameState, pipelineState);
    }
    return {
      kind: 'prepared',
      lighting,
      fence: {
        pipelineState,
        pipelineHandle: frameState.installedPipelineHandle,
        deviceGeneration: recordContext(internals).deviceScope.generation,
      },
    };
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * Register `render-standard-lighting` (RenderPrepare): each staged view whose
 * frame resolved admits its camera's Standard configuration (render path,
 * SSAO, Cluster grid) and prepares its Standard lighting from its
 * `render-cascade-fit` lights. A failure is stored, never thrown; the view's
 * recording rethrows it.
 */
export function registerStandardLightingSystem(world: World): void {
  const systemToken1 = defineSystem({
    sets: [RenderStandardLightingOrder],
    commands: 'none',
    name: RENDER_STANDARD_LIGHTING_SYSTEM,
    after: [RenderViewFrameOrder, RenderCascadeFitOrder, RenderEnvironmentAdmitOrder],
    queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewStandardLighting] }],
    fn: (world, [rows]) => {
      const frame = renderSubmission(world).frame;
      const prepared: [EntityHandle, ViewStandardLightingOutcome][] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        const staged = world
          .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
          .unwrap();
        if (staged.frame !== frame || staged.result?.ok !== true) return;
        const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
        prepared.push([entity, prepareViewStandardLighting(world, owner, entity, staged)]);
      });
      // A view's first lighting attaches its component after the iteration.
      for (const [entity, outcome] of prepared) storeViewStandardLighting(world, entity, outcome);
    },
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
}
