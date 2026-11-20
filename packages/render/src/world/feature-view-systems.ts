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
import type { MaterialResource } from '../material-resource';
import type { StandardProfile } from '../pipeline/standard-profile';
import { type RenderResourceScope, renderTime } from '../publication/resource-scope';
import { leanLightingFrame } from '../record/directional-shadow-simple';
import { resolveFrameMaterials } from '../record/frame-admission';
import { resolveMaterialSkylight } from '../record/main-pass-material';
import type { PipelineState } from '../record/render-context';
import { cloudShadowProjectionFor } from '../record/view-topology';
import type { CameraSnapshot } from '../render-contract';
import type {
  DispatchEntry,
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { featureCameraSelection } from '../render-system-projections';
import {
  resolveFeatureTargets,
  unimplementedPublishedFeature,
} from '../render-system-record-attempt';
import type { FrameList } from '../scene/frame-list';
import {
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
  createStandardSceneSurfaceAdmission,
  ProducedStandardSceneDataAdmissionInput,
  type StandardSceneDataAdmissionInput,
  type StandardSceneDataContributor,
  standardSceneDataContributorForDispatch,
  standardSceneDataContributorFromColumns,
  standardSceneSurfaceContributorBaseline,
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
  profile: Pick<StandardProfile, 'renderPath' | 'ambientOcclusion'> | undefined,
  standardPipeline: boolean,
  installedSsao: boolean | undefined,
  host: Pick<RenderFeatureHost, 'features'> | undefined,
  conformanceTrace = false,
): boolean {
  return (
    !standardPipeline ||
    profile?.renderPath !== 'forward' ||
    profile.ambientOcclusion.enabled ||
    installedSsao === true ||
    conformanceTrace ||
    host === undefined ||
    host.features.some(featureUsesSurfaceData)
  );
}

/**
 * Everything one complete contributor walk read. A later frame whose inputs
 * are these exact values derives the same admission, so it keeps the walk's
 * admission instead of judging every dispatched row again.
 */
interface SceneDataWalk {
  readonly header: SceneDataHeader;
  readonly lane: 'forward' | 'deferred';
  readonly dispatch: DispatchList;
  readonly rows: SceneDataRows;
  /** Each material a walked row carried, with the live snapshot it answered with. */
  readonly materials: readonly MaterialResource[];
  readonly snapshots: readonly MaterialSnapshot[];
}

const sceneDataWalks = new WeakMap<StandardSceneSurfaceAdmission, SceneDataWalk>();

function repeatsSceneDataWalk(
  walk: SceneDataWalk,
  header: SceneDataHeader,
  lane: 'forward' | 'deferred',
  dispatch: DispatchList,
  rows: SceneDataRows,
): boolean {
  const before = walk.header;
  if (
    walk.dispatch !== dispatch ||
    walk.lane !== lane ||
    before.viewIdentity !== header.viewIdentity ||
    before.generation !== header.generation ||
    before.deviceGeneration !== header.deviceGeneration ||
    before.standardPipeline !== header.standardPipeline ||
    before.cameraAvailable !== header.cameraAvailable ||
    before.lane !== header.lane ||
    before.renderPath !== header.renderPath ||
    (walk.rows !== rows && !walk.rows.readsSameContent(rows))
  )
    return false;
  const { materials, snapshots } = walk;
  for (let index = 0; index < materials.length; index++)
    if ((materials[index] as MaterialResource).snapshot !== snapshots[index]) return false;
  return true;
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
  const topology = viewTopologyOf(world, entity);
  const cloudLayer = topology?.kind === 'planned' ? topology.topology.cloudLayer : undefined;
  const camera = view.cameras[0];
  const profile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const context = recordContext(internals);
  if (
    needsSceneSurfaceAdmission(
      profile,
      frameState.activePipeline === context.standardPipeline,
      frameState.installedPipelineConfig?.ambientOcclusion?.enabled,
      context.featureHost,
      context.featureGraphConformanceTrace !== undefined,
    )
  ) {
    const projection = owner.scene.projectVisibility(
      view.source,
      frame.renderables,
      frame.dispatch,
      frame.gpuOwned?.slots,
    );
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
    const rows = sceneSurfaceRowsOf(projection.renderables, projection.renderables.at);
    const admitted = frameState.standardSceneSurfaceAdmission;
    const walk = admitted === undefined ? undefined : sceneDataWalks.get(admitted);
    if (
      walk === undefined ||
      rows === undefined ||
      !repeatsSceneDataWalk(walk, header, lane, projection.dispatch, rows)
    )
      frameState.standardSceneSurfaceAdmission = walkSceneDataContributors(
        header,
        lane,
        projection.renderables,
        projection.dispatch,
        rows,
        admitted,
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

/** Judge every dispatched row; a walk over captured roots is remembered with what it read. */
export function walkSceneDataContributors(
  header: SceneDataHeader,
  lane: 'forward' | 'deferred',
  renderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
  rows: SceneDataRows | undefined,
  previous: StandardSceneSurfaceAdmission | undefined,
): StandardSceneSurfaceAdmission {
  const admission = new ProducedStandardSceneDataAdmissionInput();
  const contributors = admission.contributors;
  admission.capture(header);
  const previousContributors = standardSceneSurfaceContributorBaseline(previous);
  if (rows === undefined) {
    dispatch.forEach((entry) => {
      const contributor = standardSceneDataContributorAt(
        renderables,
        entry,
        lane,
        previousContributors?.[contributors.length],
      );
      if (contributor !== undefined) contributors.push(contributor);
    });
    return createStandardSceneSurfaceAdmission(admission, previous);
  }
  const materials: MaterialResource[] = [];
  const snapshots: MaterialSnapshot[] = [];
  const seen = new Set<unknown>();
  const observe = (material: MaterialResource): void => {
    if (seen.has(material)) return;
    seen.add(material);
    materials.push(material);
    snapshots.push(material.snapshot);
  };
  let entry: Parameters<typeof standardSceneDataContributorFromColumns>[3] | undefined;
  const judge = (
    entityKey: number,
    content: Parameters<typeof standardSceneDataContributorFromColumns>[0],
    carried: Parameters<typeof standardSceneDataContributorFromColumns>[1],
  ): StandardSceneDataContributor | undefined => {
    if (carried !== undefined && !seen.has(carried)) {
      seen.add(carried);
      for (const material of carried.materials) observe(material);
      observe(carried.material);
    }
    return standardSceneDataContributorFromColumns(
      content,
      carried,
      entityKey,
      entry as Parameters<typeof standardSceneDataContributorFromColumns>[3],
      lane,
      previousContributors?.[contributors.length],
    );
  };
  const consume = (value: DispatchEntry) => {
    entry = value;
    const contributor = rows.read(value.renderableIndex, judge);
    if (contributor !== undefined) contributors.push(contributor);
  };
  const shared = isCapturedDispatch(dispatch) ? dispatchPassWork(dispatch) : undefined;
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
      if (shared.source === rows.source && work.slots !== undefined) {
        entry = work.pass;
        for (const slot of work.slots()) {
          const contributor = rows.readSlot(slot, judge);
          if (contributor !== undefined) contributors.push(contributor);
        }
      } else for (const value of work.entries()) consume(value);
    }
  const admitted = createStandardSceneSurfaceAdmission(admission, previous);
  if (isCapturedDispatch(dispatch))
    sceneDataWalks.set(admitted, { header, lane, dispatch, rows, materials, snapshots });
  return admitted;
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
  if (columns !== undefined)
    return columns.read(index, (entityKey, content, materials) =>
      standardSceneDataContributorFromColumns(
        content,
        materials,
        entityKey,
        dispatch,
        lane,
        previous,
      ),
    );
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
