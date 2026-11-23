import {
  beginScheduleWork,
  defineSystem,
  type EntityHandle,
  hasScheduleRunObservers,
  type World,
} from '@forgeax/engine-ecs';
import { err } from '@forgeax/engine-rhi';
import { type AssetHandle, ok, type TextureAsset } from '@forgeax/engine-types';
import type { ExtractedCloudLayer } from '../cloud/extract';
import {
  createCloudFeatureFrameContext,
  createCloudFeatureView,
} from '../cloud/reconstruction/frame-context';
import {
  RenderFeatureInputUnavailableError,
  type RenderFeatureInputUnavailableReason,
} from '../errors/render';
import type { RenderFeatureFrameInput, RenderFeatureHost } from '../features/host';
import type { MotionBlurFeatureInput } from '../features/motion-blur/motion-blur-feature';
import { planMotionBlurFrame } from '../features/motion-blur/motion-blur-runtime';
import { createPreparedResolver } from '../features/prepared-resolver';
import { featureUsesSurfaceData } from '../features/surface-data-usage';
import { renderFeatureViewIdentity } from '../features/view';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import type { StandardProfile } from '../pipeline/standard-profile';
import { type RenderResourceScope, renderTime } from '../publication/resource-scope';
import { leanLightingFrame } from '../record/directional-shadow-simple';
import { resolveFrameMaterials } from '../record/frame-admission';
import { resolveMaterialSkylight } from '../record/main-pass-material';
import type { PipelineState } from '../record/render-context';
import { cloudShadowProjectionFor } from '../record/view-topology';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { featureCameraSelection } from '../render-system-projections';
import {
  resolveFeatureTargets,
  unimplementedPublishedFeature,
} from '../render-system-record-attempt';
import type { FrameList } from '../scene/frame-list';
import {
  capturedDispatchAddresses,
  type DispatchList,
  dispatchPassWork,
  isCapturedDispatch,
} from '../scene/material-dispatch';
import { sceneSurfaceRowsOf } from '../scene/render-scene-view';
import {
  RenderFeatureViewsOrder,
  RenderMotionBlurPlanOrder,
  RenderStandardLightingOrder,
  RenderViewTopologyOrder,
  ViewDiffuseGiOrder,
} from '../system-order';
import { DEFERRED_PASS_SELECTOR, FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
import type { StandardSceneSurfaceAdmission } from '../temporal/scene-data';
import {
  CurrentSceneSurfaceInput,
  createStandardSceneSurfaceAdmission,
  missingStandardSurfaceProducer,
  type StandardSceneDataAdmissionInput,
  type StandardSceneDataContributor,
  selectSceneDataDispatchPass,
  standardSceneDataContributorForDispatch,
  standardSceneDataContributorFromColumns,
  standardSurfaceProducerPath,
} from '../temporal/standard-scene-data-admission';
import { captureWaterFluidFoamMaterials } from '../water/fluid-foam';
import {
  RENDER_FEATURE_VIEWS_SYSTEM,
  RENDER_MOTION_BLUR_PLAN_SYSTEM,
  type ViewFeatureFrameInput,
  ViewFeatureInput,
  type ViewFeatureInputOutcome,
  type ViewFeatureInputState,
  viewFeatureInputOf,
} from './feature-systems';
import { viewDiffuseGiOf } from './gi-systems';
import { viewRecordHistory } from './record-history';
import { viewLightsOf } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission, renderWorldFor } from './render-world';
import { RenderSceneDelta } from './scene-systems';
import { viewStandardLightingOf } from './standard-lighting-systems';
import { readViewField, requireViewField } from './view-field';
import {
  type StagedViewInputs,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';
import { viewTopologyOf } from './view-topology-systems';

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

type SceneDataHeader = Omit<StandardSceneDataAdmissionInput, 'contributors'>;
type SceneDataRows = NonNullable<ReturnType<typeof sceneSurfaceRowsOf>>;

/** Whether the stock view or any feature may consume Standard surface schemas. */
export function needsSceneSurfaceAdmission(
  renderPath: StandardProfile['renderPath'] | undefined,
  standardPipeline: boolean,
  host: Pick<RenderFeatureHost, 'features'> | undefined,
  conformanceTrace = false,
): boolean {
  return (
    !standardPipeline ||
    renderPath !== 'forward' ||
    conformanceTrace ||
    host === undefined ||
    host.features.some(featureUsesSurfaceData)
  );
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
  const { frame } = view;
  const topology = viewTopologyOf(world, entity);
  const cloudLayer = topology?.kind === 'planned' ? topology.topology.cloudLayer : undefined;
  const camera = view.cameras[0];
  const profile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const context = recordContext(internals);
  const pipelineState = context.getPipelineState();
  if (
    needsSceneSurfaceAdmission(
      profile?.renderPath,
      frameState.activePipeline === context.standardPipeline,
      context.featureHost,
      context.featureGraphConformanceTrace !== undefined,
    )
  ) {
    const header: SceneDataHeader = {
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
    };
    const lane = profile?.renderPath === 'deferred' ? 'deferred' : 'forward';
    const rows = sceneSurfaceRowsOf(frame.renderables, frame.renderables.at);
    frameState.standardSceneSurfaceAdmission = walkSceneDataContributors(
      header,
      lane,
      frame.renderables,
      frame.dispatch,
      rows,
      frameState.standardSceneSurfaceAdmission,
    );
  } else {
    // Never expose a proof from a prior consuming frame after demand disappears.
    frameState.standardSceneSurfaceAdmission = undefined;
  }
  const skylight = resolveFeatureSkylight(owner, pipelineState, frame, view.source);
  if (recordContext(internals).featureHost === undefined) return { input: undefined, skylight };
  const generation = recordContext(internals).deviceScope.generation;
  const lastGeneration = viewRecordHistory(world, entity)?.lastGeneration;
  const featureView = createCloudFeatureView(
    camera,
    view.source,
    recordContext(internals).canvas.width,
    recordContext(internals).canvas.height,
    generation,
    frameState.temporalView.accepted === undefined,
    lastGeneration !== undefined && lastGeneration !== generation,
  );
  const identity = featureViewIdentity(view.mode, camera);
  const materialProjection = owner.scene.shadowCasterProjection();
  const { materials } = resolveFrameMaterials(
    materialProjection,
    materialProjection?.renderables ?? frame.renderables,
  );
  const targets = resolveFeatureTargets(
    internals,
    pipelineState,
    camera,
    cloudLayer,
    materials.hasWater || frameState.candidatePipelinePreparations?.materials.hasWater === true,
  );
  const gi = viewDiffuseGiOf(world, entity);
  const extent = gi?.ok === true ? gi.value.renderExtent : undefined;
  const lights = viewLightsOf(world, entity);
  const leanLighting =
    lights !== undefined &&
    leanLightingFrame(lights, frame.environment?.source.kind, cloudShadowProjectionFor(cloudLayer));
  return {
    input: {
      ...featureFrameInput(
        world,
        owner,
        view,
        camera,
        targets,
        featureView,
        identity,
        lights?.directional,
        cloudLayer,
        leanLighting,
      ),
      ...(extent === undefined ? {} : { renderExtent: extent }),
    },
    skylight,
  };
}

/** Evaluate surface coverage in current dispatch order, sharing material facts across pass members. */
export function walkSceneDataContributors(
  header: SceneDataHeader,
  lane: 'forward' | 'deferred',
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
  rows: SceneDataRows | undefined,
  previous: StandardSceneSurfaceAdmission | undefined,
): StandardSceneSurfaceAdmission {
  if (standardSurfaceProducerPath(header) === undefined)
    return missingStandardSurfaceProducer(header);
  const admission = new CurrentSceneSurfaceInput(header, previous);
  if (rows === undefined) {
    dispatch.forEach((entry) => {
      const contributor = standardSceneDataContributorAt(
        renderables,
        entry,
        lane,
        admission.previousRow,
      );
      admission.append(contributor);
    });
    return createStandardSceneSurfaceAdmission(admission, previous);
  }
  let group: ReturnType<typeof selectSceneDataDispatchPass> | undefined;
  let entry: Parameters<typeof standardSceneDataContributorFromColumns>[3] | undefined;
  const judge = (
    entityKey: number,
    content: Parameters<typeof standardSceneDataContributorFromColumns>[0],
    carried: Parameters<typeof standardSceneDataContributorFromColumns>[1],
  ): void => {
    const contributor = standardSceneDataContributorFromColumns(
      content,
      carried,
      entityKey,
      entry as Parameters<typeof standardSceneDataContributorFromColumns>[3],
      lane,
      admission.previousRow,
      group,
    );
    admission.append(contributor);
  };
  const walk = rows.surfaceWalk(judge);
  const consume = (value: DispatchEntry) => {
    entry = value;
    walk.readRank(value.renderableIndex);
  };
  const shared = isCapturedDispatch(dispatch) ? dispatchPassWork(dispatch) : undefined;
  const sharedAddresses =
    shared !== undefined &&
    walk.roster !== undefined &&
    capturedDispatchAddresses(dispatch, walk.roster);
  if (shared === undefined) dispatch.forEach(consume);
  else
    for (const work of shared.work) {
      // Pass tags select the surface lane before expanding any members. A
      // ShadowCaster cannot contribute camera normals. Deferred still judges
      // Forward-only surfaces through the ordinary per-row material predicate.
      if (
        !matchPass(work.pass.tags, FORWARD_PASS_SELECTOR) &&
        !(lane === 'deferred' && matchPass(work.pass.tags, DEFERRED_PASS_SELECTOR))
      )
        continue;
      group = selectSceneDataDispatchPass(work.resource, work.pass, lane);
      if (sharedAddresses && work.visitSlots !== undefined) {
        entry = work.pass;
        work.visitSlots(walk.readSlot);
      } else for (const value of work.entries()) consume(value);
    }
  return createStandardSceneSurfaceAdmission(admission, previous);
}

/** Read the selected Scene row for the same contributor judgement used by Feature preparation. */
export function standardSceneDataContributorAt(
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchEntry,
  lane: 'forward' | 'deferred',
  previous?: StandardSceneDataContributor,
): StandardSceneDataContributor | undefined {
  const at = renderables.at;
  const index = dispatch.renderableIndex;
  const columns = sceneSurfaceRowsOf(renderables, at);
  if (columns !== undefined) {
    let contributor: StandardSceneDataContributor | undefined;
    columns
      .surfaceWalk((entityKey, content, materials) => {
        contributor = standardSceneDataContributorFromColumns(
          content,
          materials,
          entityKey,
          dispatch,
          lane,
          previous,
        );
      })
      .readRank(index);
    return contributor;
  }
  return standardSceneDataContributorForDispatch(
    Reflect.apply(at, renderables, [index]),
    dispatch,
    lane,
    previous,
  );
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
  const cameraScope = view.source as RenderResourceScope;
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
  renderWorld: World,
  { internals, frameState, scene, preparedResolver }: ViewSettlementOwner,
  view: FeatureInputView,
  camera: CameraSnapshot | undefined,
  targets: ReturnType<typeof resolveFeatureTargets>,
  featureView: ReturnType<typeof createCloudFeatureView>,
  identity: string,
  cloudSun: Parameters<typeof createCloudFeatureFrameContext>[3],
  cloudLayer: ExtractedCloudLayer | undefined,
  leanLighting: boolean,
): RenderFeatureFrameInput {
  const { publication, source, frame } = view;
  const sceneInputs = recordContext(internals).featureSceneInputs;
  const sourceFeatures =
    publication === undefined && renderWorld.hasResource(RenderSceneDelta)
      ? renderWorld.getResource(RenderSceneDelta).featureSources
      : undefined;
  const featureGraphConformanceTrace = recordContext(internals).featureGraphConformanceTrace;
  const profileWorld = renderWorldFor(internals);
  const beginProfileWork = hasScheduleRunObservers(profileWorld)
    ? (work: string) => beginScheduleWork(profileWorld, work)
    : undefined;
  return {
    ...(beginProfileWork === undefined ? {} : { beginProfileWork }),
    identity,
    render: view.mode === true,
    graphResources: {
      owner: frameState.graphResourceOwner,
      retained: frameState.compiledFrameGraph !== null,
    },
    world: view.world,
    ...(sourceFeatures === undefined ? {} : { sourceFeatures }),
    ...(source?.resolveMaterialTemplate === undefined
      ? {}
      : { resolveMaterialTemplate: source.resolveMaterialTemplate }),
    resolveAsset: (handle, revision) => {
      return source === undefined
        ? err(new Error('Missing feature asset source'))
        : source.resolveAsset(handle, revision);
    },
    resolveResidentTextureView: (_index, guid, revision) => {
      const handle = source?.handleForGuid(guid);
      if (source === undefined || handle === undefined)
        return err(new Error(`Missing Renderer texture source ${guid}`));
      const texture = source.resolveAsset(handle, revision);
      if (!texture.ok || texture.value.kind !== 'texture')
        return err(
          new Error(`Renderer texture source ${guid} is unavailable at revision ${revision}`),
        );
      const resident = internals.gpuStore.ensureTextureRevisionResident(
        handle as AssetHandle<'texture'>,
        texture.value as TextureAsset,
        source,
        revision,
      );
      if (!resident.ok) return resident;
      return ok({
        view: resident.value.view,
        retain: () => {
          const lease = internals.gpuStore.retainTextureRevisionResidency(
            handle as AssetHandle<'texture'>,
            revision,
            source,
          );
          if (lease === undefined)
            throw new Error(`Renderer texture source ${guid} has no revision lease`);
          return (evict = false) => {
            void lease.release(evict);
          };
        },
      });
    },
    ...(publication === undefined
      ? {}
      : {
          publishedFeatures: publication.packet.features,
          ...(publication.onFeatureSourceSubmitted === undefined
            ? {}
            : { onFeatureSourceSubmitted: publication.onFeatureSourceSubmitted }),
        }),
    frameNumber: internals.rendererFrameNumber ?? frameState.frameNumber,
    ...featureCameraSelection(camera),
    frameSize: {
      width: recordContext(internals).canvas.width,
      height: recordContext(internals).canvas.height,
    },
    visibilitySnapshot: frame.visibilitySnapshot,
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
    frame: {
      ...createCloudFeatureFrameContext(cloudLayer, featureView, frame.environment, cloudSun),
      waterFoamMaterials: captureWaterFluidFoamMaterials(
        frame.renderables,
        identity,
        frame.dispatch,
      ),
    },
    ...(internals.getMaterialShaderBindingContract === undefined
      ? {}
      : { materialShaderBindingContract: internals.getMaterialShaderBindingContract }),
    createPreparedGraphicsResolver: (input) =>
      createPreparedResolver(
        { ...preparedResolver, leanLighting },
        input,
        source as RenderResourceScope,
      ),
    gpuWork: preparedResolver.gpuWork,
    sceneResources:
      sceneInputs === undefined
        ? undefined
        : {
            prepare: (identity, resource) =>
              sceneInputs.prepare(identity, resource, {
                retained: scene.compositionRetainedScene(),
                sourceScope: view.source,
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
  const systemToken1 = defineSystem({
    sets: [RenderFeatureViewsOrder],
    commands: 'none',
    name: RENDER_FEATURE_VIEWS_SYSTEM,
    after: [RenderStandardLightingOrder, RenderViewTopologyOrder, ViewDiffuseGiOrder],
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
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
  const systemToken2 = defineSystem({
    sets: [RenderMotionBlurPlanOrder],
    commands: 'none',
    name: RENDER_MOTION_BLUR_PLAN_SYSTEM,
    after: [systemToken1],
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
  });
  world.addSystem(RenderPrepare, systemToken2).unwrap();
}
