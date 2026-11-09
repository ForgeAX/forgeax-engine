import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { RendererOperationError } from '../errors/render';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import {
  prepareFrameLighting,
  warnZeroLightStandard,
  writeShadowParamsBuffer,
} from '../record/frame-lighting';
import type { RenderFrameState } from '../record/frame-snapshot';
import { prepareViewSky, warnIgnoredDirectionalShadowCasters } from '../record/helpers';
import {
  type PipelineState,
  type RenderSystemInternals,
  recordProfileRunner,
  runRecordProfilePhase,
} from '../record/render-context';
import { resetRenderFeatureGraphState } from '../record/typed-frame-graph';
import type { CameraSnapshot } from '../render-contract';
import { ssaoStructuralIdentity } from '../ssao-config';
import { RENDER_CASCADE_FIT_SYSTEM } from './light-systems';
import { viewLightsOf } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission, renderWorldFor } from './render-world';
import { requireViewField } from './view-field';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
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
  if (entity === undefined || !world.hasComponent(entity, ViewStandardLighting)) return undefined;
  const state = world
    .resolveUniqueRef<ViewStandardLightingState>(
      requireViewField(world, entity, ViewStandardLighting, 'state'),
    )
    .unwrap();
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
function admitCameraConfiguration(
  { frameState, internals }: ViewSettlementOwner,
  camera: CameraSnapshot | undefined,
): boolean {
  const install = frameState.standardInstall;
  const lane = {
    storageBuffer: internals.device.caps.storageBuffer,
    maxColorAttachments: internals.device.caps.maxColorAttachments,
    maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
  };
  let configuration = deriveCameraStandardConfiguration(
    internals.standardProfile,
    install.configured,
    camera,
    lane,
  );
  if (!configuration.ok) {
    const failureKey = JSON.stringify([configuration.error.code, configuration.error.detail]);
    if (failureKey !== install.cameraFailure) {
      internals.errorRegistry.fire(configuration.error);
      install.cameraFailure = failureKey;
    }
    // Invalid AO cannot prevent an independently authored SSR request.
    configuration = deriveCameraStandardConfiguration(
      internals.standardProfile,
      install.configured,
      { screenSpaceReflection: camera?.screenSpaceReflection },
      lane,
    );
  } else {
    install.cameraFailure = '';
  }
  if (!configuration.ok) return false;
  const signature = JSON.stringify([
    configuration.value.profile?.renderPath,
    ssaoStructuralIdentity(
      configuration.value.config?.ssao,
      configuration.value.profile?.pipelineId === STANDARD_PIPELINE_ID,
    ),
  ]);
  frameState.cameraStandardProfile = configuration.value.profile;
  frameState.installedPipelineConfig = configuration.value.config;
  if (signature !== install.cameraSignature) {
    install.cameraSignature = signature;
    frameState.installedPipelineHandle += 1;
    resetRenderFeatureGraphState(internals);
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
    const { cameras, frame, resourceWorld } = stagedViewInputs(world, staged);
    const lights = viewLightsOf(world, entity);
    if (lights === undefined || !admitCameraConfiguration(owner, cameras[0]))
      return { kind: 'not-admitted' };
    const { internals, frameState } = owner;
    const pipelineState = recordContext(internals).getPipelineState();
    const camera = cameras[0];
    const lighting = runRecordProfilePhase(
      recordProfileRunner(internals.profiler?.activeSession()),
      'record/scene-state/lighting-prep',
      () =>
        prepareFrameLighting(
          internals,
          frameState,
          lights,
          camera,
          pipelineState ?? undefined,
          frame.renderables,
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
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_STANDARD_LIGHTING_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM, RENDER_CASCADE_FIT_SYSTEM],
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
    })
    .unwrap();
}
