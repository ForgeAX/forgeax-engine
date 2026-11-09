import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { err } from '@forgeax/engine-rhi';
import { createCloudFeatureFrameContext, createCloudFeatureView } from '../cloud/frame-context';
import {
  RenderFeatureInputUnavailableError,
  type RenderFeatureInputUnavailableReason,
} from '../errors/render';
import type { RenderFeatureFrameInput } from '../features/host';
import type { MotionBlurFeatureInput } from '../features/motion-blur/motion-blur-feature';
import { planMotionBlurFrame } from '../features/motion-blur/motion-blur-runtime';
import { createPreparedResolver } from '../features/prepared-resolver';
import { renderFeatureViewIdentity } from '../features/view';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { type RenderResourceScope, renderTime } from '../publication/resource-scope';
import { resolveMaterialSkylight } from '../record/main-pass-material';
import type { PipelineState } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { ExtractedFrame } from '../render-system-extract';
import { featureCameraSelection } from '../render-system-projections';
import {
  resolveFeatureTargets,
  unimplementedPublishedFeature,
} from '../render-system-record-attempt';
import {
  createStandardSceneSurfaceAdmission,
  type StandardSceneDataAdmissionInput,
  type StandardSceneDataContributor,
  standardSceneDataContributorForDispatch,
  standardSceneSurfaceContributorBaseline,
} from '../temporal/standard-scene-data-admission';
import {
  RENDER_FEATURE_VIEWS_SYSTEM,
  RENDER_MOTION_BLUR_PLAN_SYSTEM,
  type ViewFeatureFrameInput,
  ViewFeatureInput,
  type ViewFeatureInputOutcome,
  type ViewFeatureInputState,
  viewFeatureInputOf,
} from './feature-systems';
import { viewRecordHistory } from './record-history';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission } from './render-world';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  viewStandardLightingOf,
} from './standard-lighting-systems';
import { readViewField, requireViewField } from './view-field';
import {
  type StagedViewInputs,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/** A view's motion blur plan, or the unexpected cause its recording rethrows. */
export type ViewMotionBlurOutcome =
  | { readonly kind: 'planned'; readonly input: MotionBlurFeatureInput | undefined }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** A view's Feature scope: the shared capture recorder or its selected camera. */
export function featureViewIdentity(
  mode: ViewFrameState['mode'],
  camera: CameraSnapshot | undefined,
): string {
  return mode === 'capture' ? 'renderer:capture' : renderFeatureViewIdentity(camera);
}

/** The material skylight `render-feature-views` prepared for this view's Feature graphics. */
export function featureSkylightOf(
  world: World,
  entity: EntityHandle | undefined,
): SkylightBindGroupResources | undefined {
  const outcome = viewFeatureInputOf(world, entity);
  return outcome?.kind === 'prepared' ? outcome.value.skylight : undefined;
}

function featureInputUnavailable(
  mode: ViewFrameState['mode'],
  camera: CameraSnapshot | undefined,
  reason: RenderFeatureInputUnavailableReason,
  featureIdentity?: string,
): ViewFeatureInputOutcome {
  return {
    kind: 'unavailable',
    error: new RenderFeatureInputUnavailableError({
      view: featureViewIdentity(mode, camera),
      reason,
      ...(featureIdentity === undefined ? {} : { featureIdentity }),
    }),
  };
}

/** The view's Feature input: why it has none, or the input. */
function deriveViewFeatureInput(
  world: World,
  entity: EntityHandle,
  staged: ViewFrameState,
  owner: ViewSettlementOwner,
): ViewFeatureInputOutcome {
  if (staged.result?.ok !== true)
    return featureInputUnavailable(staged.mode, undefined, 'view-frame-failed');
  const view = stagedViewInputs(world, staged);
  const camera = view.cameras[0];
  const lighting = viewStandardLightingOf(world, entity);
  if (lighting?.kind === 'failed') return { kind: 'failed', cause: lighting.cause };
  if (lighting?.kind !== 'prepared')
    return featureInputUnavailable(view.mode, camera, 'camera-configuration-rejected');
  const { internals } = owner;
  // A capture view records no Features by contract; the Feature-owning
  // views of the same Renderer validate the published Feature roster.
  const unimplemented =
    recordContext(internals).captureView === undefined
      ? unimplementedPublishedFeature(staged.publication, recordContext(internals).featureHost)
      : undefined;
  if (unimplemented !== undefined)
    return featureInputUnavailable(
      view.mode,
      camera,
      'published-feature-unimplemented',
      unimplemented,
    );
  return {
    kind: 'prepared',
    value: prepareFeatureFrameInput(world, entity, owner, {
      ...view,
      publication: staged.publication,
    }),
  };
}

/** The staged view facts a Feature frame input derives from. */
type FeatureInputView = StagedViewInputs & Pick<ViewFrameState, 'publication'>;

/** The view's Feature targets, cloud frame and skylight. */
function prepareFeatureFrameInput(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  view: FeatureInputView,
): ViewFeatureFrameInput {
  const { internals, frameState } = owner;
  const pipelineState = recordContext(internals).getPipelineState();
  const { frame } = view;
  const camera = view.cameras[0];
  const projection = owner.scene.projectVisibility(
    view.scopes,
    frame.renderables,
    frame.dispatch,
    frame.gpuOwned?.slots,
  );
  const profile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const contributors: StandardSceneDataContributor[] = [];
  const admission: StandardSceneDataAdmissionInput = {
    viewIdentity: featureViewIdentity(view.mode, camera),
    generation: recordContext(internals).featureHost?.preparedGeneration ?? 0,
    deviceGeneration: recordContext(internals).deviceScope.generation,
    standardPipeline: frameState.activePipeline === recordContext(internals).standardPipeline,
    cameraAvailable: camera !== undefined,
    lane:
      internals.device.caps.backendKind === 'wgpu-webgl2'
        ? 'cpu-webgl2'
        : internals.device.caps.storageBuffer
          ? 'clustered'
          : 'direct',
    renderPath:
      frameState.activePipeline === recordContext(internals).standardPipeline
        ? profile?.renderPath
        : undefined,
    contributors,
  };
  const previousContributors = standardSceneSurfaceContributorBaseline(
    frameState.standardSceneSurfaceAdmission,
  );
  let contributionIndex = 0;
  projection.dispatch.forEach((dispatch) => {
    const row = projection.renderables.at(dispatch.renderableIndex);
    const contributor = standardSceneDataContributorForDispatch(
      row,
      dispatch,
      profile?.renderPath === 'deferred' ? 'deferred' : 'forward',
      previousContributors?.[contributionIndex],
    );
    if (contributor !== undefined) {
      contributors.push(contributor);
      contributionIndex++;
    }
  });
  frameState.standardSceneSurfaceAdmission = createStandardSceneSurfaceAdmission(
    admission,
    frameState.standardSceneSurfaceAdmission,
  );
  const skylight = resolveFeatureSkylight(owner, pipelineState, frame, view.resourceWorld);
  if (recordContext(internals).featureHost === undefined) return { input: undefined, skylight };
  const generation = recordContext(internals).deviceScope.generation;
  const cameraOwner = view.composition.owners.cameraOwner;
  const lastGeneration = viewRecordHistory(world, entity)?.lastGeneration;
  const featureView = createCloudFeatureView(
    camera,
    view.scopes,
    cameraOwner,
    recordContext(internals).canvas.width,
    recordContext(internals).canvas.height,
    generation,
    frameState.temporalView.accepted === undefined,
    lastGeneration !== undefined && lastGeneration !== generation,
  );
  const identity = featureViewIdentity(view.mode, camera);
  const targets = resolveFeatureTargets(internals, pipelineState, camera, frame.cloudLayer);
  return {
    input: featureFrameInput(owner, view, camera, targets, featureView, identity),
    skylight,
  };
}

function resolveFeatureSkylight(
  { internals }: ViewSettlementOwner,
  pipelineState: PipelineState | null,
  frame: ExtractedFrame,
  resourceWorld: RenderResourceScope,
): SkylightBindGroupResources | undefined {
  if (pipelineState === null) return undefined;
  const skylight = frame.skylight;
  return resolveMaterialSkylight(
    internals,
    pipelineState,
    skylight,
    frame.skylightCount,
    skylight === undefined
      ? undefined
      : internals.gpuStore.getCubemapIbl(skylight.equirectHandle, resourceWorld),
  ).skylightResources;
}

/** The motion blur the view's camera requests this frame. */
function planViewMotionBlur(
  world: World,
  staged: ViewFrameState,
  { internals, frameState }: ViewSettlementOwner,
): MotionBlurFeatureInput | undefined {
  if (staged.result?.ok !== true) return undefined;
  const view = stagedViewInputs(world, staged);
  const camera = view.cameras[0];
  const cameraScope = view.scopes[view.composition.owners.cameraOwner] as RenderResourceScope;
  const opts = staged.opts;
  const environment = view.frame.environment;
  let fallbackDelta = 0;
  try {
    const delta = renderTime(cameraScope).delta;
    fallbackDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
  } catch {
    fallbackDelta = 0;
  }
  const plan = planMotionBlurFrame({
    params: camera?.motionBlur,
    sampleTimeSeconds: opts.sampleTimeSeconds,
    acceptedSampleTimeSeconds: frameState.temporalView.accepted?.sampleTimeSeconds,
    fallbackDeltaSeconds: fallbackDelta,
    acceptedTemporal: frameState.temporalView.accepted,
    temporalReset: opts.temporalReset === true,
    width: Math.max(1, recordContext(internals).canvas.width),
    height: Math.max(1, recordContext(internals).canvas.height),
    cameraViewIdentity: featureViewIdentity(view.mode, camera),
    historyVersion: camera?.historyVersion ?? 0,
    environmentSignature: environment?.environmentSignature ?? '',
    fogSignature: environment?.fogSignature ?? '',
    deviceGeneration: recordContext(internals).deviceScope?.generation ?? 0,
  });
  return plan.featureInput;
}

function featureFrameInput(
  { internals, frameState, scene, preparedResolver }: ViewSettlementOwner,
  view: FeatureInputView,
  camera: CameraSnapshot | undefined,
  targets: ReturnType<typeof resolveFeatureTargets>,
  featureView: ReturnType<typeof createCloudFeatureView>,
  identity: string,
): RenderFeatureFrameInput {
  const { publication, scopes, frame } = view;
  const sceneInputs = recordContext(internals).featureSceneInputs;
  const featureGraphConformanceTrace = recordContext(internals).featureGraphConformanceTrace;
  return {
    identity,
    render: view.mode === true,
    worlds: view.composition.worlds,
    resolveAsset: (index, handle, revision) => {
      const source = scopes[index];
      return source === undefined
        ? err(new Error(`Missing feature asset source ${index}`))
        : source.resolveAsset(handle, revision);
    },
    ...(publication === undefined
      ? {}
      : {
          publishedFeatures: publication.packet.features,
          ...(publication.onFeatureSourceSubmitted === undefined
            ? {}
            : { onFeatureSourceSubmitted: publication.onFeatureSourceSubmitted }),
        }),
    owner: view.composition.owners.resourceOwner,
    frameNumber: internals.rendererFrameNumber ?? frameState.frameNumber,
    ...featureCameraSelection(camera),
    frameSize: {
      width: recordContext(internals).canvas.width,
      height: recordContext(internals).canvas.height,
    },
    visibilitySnapshots: frame.featureVisibilitySnapshots,
    hiddenEntityReports: frame.hiddenEntityReports,
    targets,
    generation: recordContext(internals).featureHost?.preparedGeneration ?? 0,
    deviceGeneration: recordContext(internals).deviceScope.generation,
    ...(frameState.standardSceneSurfaceAdmission === undefined
      ? {}
      : { surfaceAdmission: frameState.standardSceneSurfaceAdmission }),
    recordFrameNumber: frameState.frameNumber,
    ...(featureGraphConformanceTrace === undefined ? {} : { featureGraphConformanceTrace }),
    getFeatureShaderSource: internals.getFeatureShaderSource,
    caps: internals.device.caps,
    featureReadOnlyDepthBatchDiagnostic:
      (internals.standardProfile?.featureReadOnlyDepthBatchDiagnostic ??
        internals.standardProfile?.featureReadOnlyDepthBatching) === true,
    limits: internals.device.limits,
    frame: createCloudFeatureFrameContext(frame.cloudLayer, featureView),
    ...(internals.getMaterialShaderBindingContract === undefined
      ? {}
      : { materialShaderBindingContract: internals.getMaterialShaderBindingContract }),
    createPreparedGraphicsResolver: (input) =>
      createPreparedResolver(preparedResolver, input, scopes),
    gpuWork: preparedResolver.gpuWork,
    sceneResources:
      sceneInputs === undefined
        ? undefined
        : {
            prepare: (identity, resource) =>
              sceneInputs.prepare(identity, resource, {
                retained: scene.compositionRetainedScene(),
                scopes,
              }),
            abortFeature: (identity) => sceneInputs.abortFeature(identity),
            begin: (frameNumber) => sceneInputs.begin(frameNumber),
            complete: (submitted, completion) => sceneInputs.complete(submitted, completion),
          },
  };
}

function guardedFeatureInput(derive: () => ViewFeatureInputOutcome): ViewFeatureInputOutcome {
  try {
    return derive();
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

function guardedMotionBlur(plan: () => MotionBlurFeatureInput | undefined): ViewMotionBlurOutcome {
  try {
    return { kind: 'planned', input: plan() };
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * Register `render-feature-views` (RenderPrepare): each staged view derives
 * its Feature frame input (identity, targets, cloud frame, skylight,
 * published-Feature admission) from its resolved frame. It runs after
 * `render-standard-lighting`, which admits the camera configuration and
 * resets the Feature graph state it implies. `render-motion-blur-plan` then
 * plans each prepared view's motion blur. A failure is stored, never thrown.
 */
export function registerFeatureViewsSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_FEATURE_VIEWS_SYSTEM,
      after: [RENDER_STANDARD_LIGHTING_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewFeatureInput] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewFeatureInputState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame) return;
          const outcome = guardedFeatureInput(() =>
            deriveViewFeatureInput(
              world,
              entity,
              staged,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            ),
          );
          const stored = readViewField(world, entity, ViewFeatureInput, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome, motionBlur: undefined } });
            return;
          }
          const state = world.resolveUniqueRef<ViewFeatureInputState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
        });
        // A view's first input attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewFeatureInput,
              data: { state: world.allocUniqueRef('ViewFeatureInput', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_MOTION_BLUR_PLAN_SYSTEM,
      after: [RENDER_FEATURE_VIEWS_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame, ViewFeatureInput] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewFeatureInputState>(
              requireViewField(world, entity, ViewFeatureInput, 'state'),
            )
            .unwrap();
          if (state.frame !== frame || state.outcome.kind !== 'prepared') return;
          if (state.outcome.value.input === undefined) return;
          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          const planned = guardedMotionBlur(() =>
            planViewMotionBlur(
              world,
              staged,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            ),
          );
          if (planned.kind === 'failed') state.outcome = planned;
          else state.motionBlur = { frame, input: planned.input };
        });
      },
    })
    .unwrap();
}
