// Per-view recording kernels read the view owner directly; no constructor-captured frame state.
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { AssetHandle } from '@forgeax/engine-types';
import { standardBloomAdmitted } from './bloom-admission';
import { ProjectedDecalInvalidError } from './decals/component';
import { RenderFeatureInputUnavailableError } from './errors/render';
import { reportPendingRenderFeatureErrors } from './features/error-reporting';
import type { RenderFeatureFrameInput } from './features/host';
import { EMPTY_GPU_DRAW_SELECTION, type GpuDrawSelection } from './gpu-driven/draw-selection';
import { discardStandardOutputStates } from './pipeline/standard-output/resources';
import { DEFAULT_STANDARD_PROFILE } from './pipeline/standard-profile';
import { type RenderResourceScope, renderTime } from './publication/resource-scope';
import { createDrawObservation } from './record/draw-observation';
import {
  type CubeCaptureFrameInput,
  type FrameRecordingInput,
  type GpuDrivenRecordInput,
  planMissingError,
} from './record/frame';
import { resolveFrameMaterials } from './record/frame-admission';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import { makeZeroCameraFallbackSnapshot, worldEntityKey } from './record/frame-snapshot';
import type { RenderableDrawReceipt } from './record/gpu-draw-receipts';
import {
  type PipelineState,
  type RenderSystemInternals,
  recordProfileRunner,
  runProfiledRenderPhase,
} from './record/render-context';
import type { CameraSnapshot, RenderPhase, RenderPhaseSkipReason } from './render-contract';
import type { DispatchList, ExtractedFrame, GpuOwnedFrame } from './render-system-extract';
import {
  createPresentationDraws,
  initialFramePresentation,
  markPipelinePreparationPending,
  projectDisplayRenderables,
} from './render-system-presentation';
import {
  featurePreparationPendingReason,
  type RecordAttempt,
  type RecordFeatures,
  recordFailureError,
} from './render-system-record-attempt';
import { FrameProjection } from './scene/frame-list';
import type { PersistentGpuDrivenState } from './scene/render-scene';
import { recordsViewWork, type ViewCaptureFrame, viewCaptureWorkOf } from './world/capture-systems';
import { consumeViewEnvironment } from './world/environment-systems';
import {
  RENDER_FEATURE_PLAN_SYSTEM,
  type ViewFeaturePlan,
  viewFeaturePlanOf,
} from './world/feature-plan-systems';
import {
  featureFrameOutcome,
  type ViewFeatureFrameInput,
  viewFeatureInputOf,
} from './world/feature-systems';
import { featureViewIdentity } from './world/feature-view-systems';
import { stageViewGpuDrivenPrepareInput, viewGpuDrivenOf } from './world/gpu-driven-systems';
import { viewPassPlanQueue } from './world/pass-plan-systems';
import { postSubmissionsOf } from './world/post-systems';
import { viewPhaseQueue } from './world/queue-systems';
import { viewRecordHistory } from './world/record-history';
import { consumeViewReflectionProbes, viewCaptureFitsOf } from './world/reflection-systems';
import { type ViewLights, viewLightsOf } from './world/render-lights';
import { renderWorldFor, surfaceDynamicInputOf } from './world/render-world';
import { admitViewStandardLighting } from './world/standard-lighting-systems';
import { subsurfaceAdmissionInput } from './world/subsurface-admission-systems';
import { consumeViewStandardOutput } from './world/temporal-systems';
import { consumeViewTransmission } from './world/transmission-systems';
import { viewDrawReceipt } from './world/view-draw-receipt';
import { stagedViewInputs, viewFrameOf } from './world/view-frame-systems';
import { recordContext } from './world/view-record-context';
import type { ViewSettlementOwner } from './world/view-settlement';

/** A view `render-capture-fit` did not run for fits no face. */
const NO_CAPTURE_FITS: ReadonlyMap<object, ViewLights> = new Map();

/** A view `render-capture-schedule` did not prepare records no captures. */
const EMPTY_VIEW_CAPTURES: ViewCaptureFrame = Object.freeze({
  cube: [],
  sceneInputs: [],
  auxiliaryCameras: [],
  faces: [],
});
export type RecordView = NonNullable<ReturnType<typeof selectRecordView>>;
export type RecordScene = NonNullable<ReturnType<typeof prepareRecordScene>>;
export type RecordQueue = {
  readonly gpuDriven: GpuDrivenRecordInput;
  readonly records: boolean;
  /** The view's dispatch in phase order. */
  readonly dispatch: DispatchList;
};

export function recordProfileSkip(
  session: RecorderSession | undefined,
  phase: RenderPhase,
  reason: RenderPhaseSkipReason,
): void {
  if (session === undefined) return;
  try {
    session.recordSkip({ source: 'render', phase, reason });
  } catch {
    // Profiler failures never alter rendering.
  }
}

/**
 * Geometry observation identifies each draw's source World, revision and
 * mesh asset; a publication reports its source-realm World identity.
 */
export function beginGeometryObservation(owner: ViewSettlementOwner, attempt: RecordAttempt): void {
  const { composition, scopes, opts, publication } = attempt;
  owner.gpuDriven.beginGeometryObservation(
    opts.geometryObservation === true && attempt.mode === true
      ? (slot) => {
          const scope = scopes[slot.snapshot.worldId];
          const worldIdentity =
            publication === undefined
              ? (composition.leases?.[slot.snapshot.worldId]?.worldIdentity ??
                composition.worlds[slot.snapshot.worldId]?.identity)
              : opts.geometryObservationSourceWorldIdentity;
          if (!worldIdentity || scope === undefined) throw Error('geometry-source-unavailable');
          const handle = slot.snapshot.assetHandle as AssetHandle<'mesh'>;
          const source = 'sourceForAsset' in scope ? scope.sourceForAsset(handle) : undefined;
          return {
            worldIdentity,
            sourceRevision: publication?.packet.revision ?? slot.generation,
            ...(source === undefined
              ? {}
              : {
                  meshGuid: source.guid,
                  ...(source.sourceKey === undefined ? {} : { sourceKey: source.sourceKey }),
                }),
          };
        }
      : undefined,
  );
}

/** Reset per-attempt publication facts; returns whether this call owns the profiler frame. */
export function beginRecordAttempt(owner: ViewSettlementOwner, attempt: RecordAttempt): boolean {
  // A failed draw cannot publish a startup completion fact. Reset the
  // projection before extraction so a later receipt never reuses an old
  // scene's readiness.
  if (attempt.mode === true) {
    viewRecordHistory(
      renderWorldFor(owner.internals),
      owner.internals.viewEntity,
    )?.resetPresentation();
  }
  // A prior failed record/submit may have staged a temporal capture. A
  // capture belongs only to the draw call that created it; discard it
  // before this call can prepare or commit a new candidate.
  owner.scene.discardTemporalFrame();
  const profileSession = attempt.profileSession;
  if (profileSession === undefined || attempt.opts.profileFrame !== undefined) return false;
  try {
    return profileSession.beginFrame(++owner.recording.directFrameId).ok;
  } catch {
    return false;
  }
}

/**
 * Extraction, view selection, scene/feature preparation, submission and
 * publication of one record attempt. A rejected phase returns false and
 * leaves the last accepted frame published.
 */

/** Pending assets submit the preparation barrier; invalid motion blur rejects the frame. */

export function cameraScope(attempt: RecordAttempt): RenderResourceScope {
  return attempt.scopes[attempt.composition.owners.cameraOwner] as RenderResourceScope;
}

export function resourceScope(attempt: RecordAttempt): RenderResourceScope {
  return attempt.scopes[attempt.composition.owners.resourceOwner] as RenderResourceScope;
}

/** The selected display camera, its fitted lights and the Standard configuration it implies. */
export function selectRecordView(owner: ViewSettlementOwner):
  | {
      readonly cameras: CameraSnapshot[];
      readonly lights: ViewLights;
    }
  | undefined {
  const { cameras } = stagedViewScopes(owner);
  // A recording reads its view entity's `render-cascade-fit` lights.
  const lights = viewLightsOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
  if (lights === undefined) return undefined;
  // `render-standard-lighting` admitted the camera configuration in RenderPrepare.
  if (!admitViewStandardLighting(owner.internals)) return undefined;
  recordContext(owner.internals).gpuPassTimingViewId = cameras[0]?.entityKey;
  // `render-standard-output-stage` prepared the output resources and staged
  // the auto-exposure/LUT candidates in RenderPrepare.
  const stagedOutput = consumeViewStandardOutput(owner.internals);
  if (stagedOutput.kind === 'rejected') {
    owner.internals.errorRegistry.fire(stagedOutput.error);
    return undefined;
  }
  return { cameras, lights };
}

/**
 * Scene-side preparation for the selected view: shadow/probe/SSR state,
 * visibility projection, presentation candidate, LOD inspection and the
 * environment and transmission admission gates.
 */
export function prepareRecordScene(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  frame: ExtractedFrame,
  view: RecordView,
) {
  const { cameras, lights } = view;
  const shadowCasterProjection = owner.scene.shadowCasterProjection();
  const directionalShadow = viewRecordHistory(
    renderWorldFor(owner.internals),
    owner.internals.viewEntity,
  )?.directionalShadow;
  if (directionalShadow !== undefined) {
    directionalShadow.candidate = 'failed';
    directionalShadow.error = lights.directionalShadowError;
  }
  // `view-reflection-probes` prepared this view's probes and SSR dependencies in RenderPrepare.
  const { probes: reflectionProbes, ssr: ssrDependencies } = consumeViewReflectionProbes(
    renderWorldFor(owner.internals),
    owner.internals.viewEntity,
  );
  owner.recorded.camera = cameras[0];
  const visibility = projectRecordVisibility(owner, attempt.scopes, frame, cameras.length);
  owner.frameState.pipelinePreparationPending = false;
  delete owner.frameState.pipelinePreparationPendingReason;
  const presentation = initialFramePresentation(
    cameras.length,
    frame.environmentReady && frame.environment !== undefined,
  );
  const lodFrameId = observationFrameId(owner);
  const lodCandidateCount = owner.lod.inspectFrame(
    owner.recorded.camera,
    frame,
    visibility,
    attempt.scopes,
    attempt.composition.owners.cameraOwner,
    lodFrameId,
  );
  owner.scene.prepareTemporalFrame(visibility.projection.renderables, frame.gpuOwned?.slots);
  if (
    consumeViewEnvironment(renderWorldFor(owner.internals), owner.internals.viewEntity) !==
    'admitted'
  )
    return undefined;
  // The candidate gate runs before bind-group preparation, graph
  // construction, and record/submit. A missing capability therefore
  // cannot publish or execute a transmission graph.
  if (
    consumeViewTransmission(renderWorldFor(owner.internals), owner.internals.viewEntity) !==
    'admitted'
  )
    return undefined;
  return {
    shadowCasterProjection,
    reflectionProbes,
    ssrDependencies,
    visibility,
    presentation,
    lodFrameId,
    lodCandidateCount,
  };
}

/** The RenderPrepare view of this recording's staged, resolved frame. */
export function stagedViewScopes(owner: ViewSettlementOwner) {
  const renderWorld = renderWorldFor(owner.internals);
  const staged = viewFrameOf(renderWorld, owner.internals.viewEntity);
  if (staged === undefined)
    throw new Error('A view prepares only the frame render-view-frame resolved this frame');
  return stagedViewInputs(renderWorld, staged);
}

export function projectRecordVisibility(
  owner: ViewSettlementOwner,
  scopes: readonly RenderResourceScope[],
  frame: ExtractedFrame,
  cameraCount: number,
) {
  const worldKeys = owner.scene.visibilityWorldKeysFor(scopes);
  const projection = owner.scene.projectVisibility(
    scopes,
    frame.renderables,
    frame.dispatch,
    frame.gpuOwned?.slots,
  );
  // A GPU-owned frame derives its display rows from the submitted selection;
  // such frames carry no terrain or other view-generated rows.
  const presentationRenderables =
    cameraCount === 0 || frame.gpuOwned !== undefined
      ? []
      : projectDisplayRenderables(projection.renderables, projection.dispatch);
  return { worldKeys, projection, presentationRenderables };
}

/**
 * The public frame receipt is allocated by WebGPURenderer immediately
 * before this draw (`observationFrameId`). RenderSystem's private
 * frameNumber is an internal generation that also advances on failed record
 * attempts, so it is only the fallback identity.
 */
export function observationFrameId(owner: ViewSettlementOwner): number {
  return (
    (
      owner.internals as RenderSystemInternals & {
        readonly observationFrameId?: number;
      }
    ).observationFrameId ?? owner.frameState.frameNumber
  );
}

/**
 * Bind groups, then the feature host frame over the Feature input
 * `render-feature-views` prepared, and the plan `render-feature-plan`
 * planned from it. `undefined` rejects the frame.
 */
export function prepareRecordFeatures(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  frame: ExtractedFrame,
  view: RecordView,
): RecordFeatures | undefined {
  owner.recorded.bindGroups.createBindGroup = 0;
  owner.recorded.bindGroups.keys = [];
  buildFrameBindGroups(
    owner,
    attempt.profileSession,
    recordContext(owner.internals).getPipelineState(),
    frame.cameras.length,
  );
  retainFrameInspection(owner, frame);
  const prepared = consumeViewFeatureInput(owner, attempt.mode, view.cameras[0]);
  if (prepared === undefined) return undefined;
  const host = prepareFeatureHostFrame(owner, prepared.input);
  if (host === undefined) return undefined;
  const plan = runProfiledRenderPhase(attempt.profileSession, 'features', () =>
    admitViewFeaturePlan(owner, host.featureFrame),
  );
  return plan === undefined ? undefined : { ...host, plan };
}

/**
 * The Feature frame input `render-feature-views` prepared for this view. An
 * unavailable input is reported and rejects the recording; a failure
 * rethrows inside the recording's own recovery.
 */
export function consumeViewFeatureInput(
  owner: ViewSettlementOwner,
  mode: RecordAttempt['mode'],
  camera: CameraSnapshot | undefined,
): ViewFeatureFrameInput | undefined {
  const outcome = viewFeatureInputOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
  if (outcome === undefined) {
    owner.internals.errorRegistry.fire(
      new RenderFeatureInputUnavailableError({
        view: featureViewIdentity(mode, camera),
        reason: 'not-prepared',
      }),
    );
    return undefined;
  }
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'unavailable') {
    owner.internals.errorRegistry.fire(outcome.error);
    return undefined;
  }
  return outcome.value;
}

export function buildFrameBindGroups(
  owner: ViewSettlementOwner,
  profileSession: RecorderSession | undefined,
  pipelineState: PipelineState | null,
  cameraCount: number,
): void {
  const host = recordContext(owner.internals).featureHost;
  const skipReason: RenderPhaseSkipReason | undefined =
    host === undefined
      ? 'feature-host-unavailable'
      : host.size === 0
        ? 'feature-host-empty'
        : pipelineState === null
          ? 'pipeline-state-unavailable'
          : cameraCount === 0
            ? 'camera-unavailable'
            : undefined;
  if (skipReason !== undefined || pipelineState === null) {
    recordProfileSkip(profileSession, 'bind-groups', skipReason ?? 'pipeline-state-unavailable');
    return;
  }
  runProfiledRenderPhase(profileSession, 'bind-groups', () =>
    buildPerFrameBindGroups(
      owner.internals,
      owner.frameState,
      pipelineState,
      true,
      owner.recorded.bindGroups,
      undefined,
      false,
    ),
  );
}

export function retainFrameInspection(owner: ViewSettlementOwner, frame: ExtractedFrame): void {
  owner.recorded.frustum = frame.frustumStats;
  owner.recorded.visibility.explicitlyHidden = frame.visibilityStats.explicitlyHidden;
  if (frame.materialTextureSources === undefined) return;
  owner.recorded.materialTextureSources = Object.freeze({
    sourceFieldsVisited: frame.materialTextureSources.sourceFieldsVisited,
    producerRoutes: Object.freeze({ ...frame.materialTextureSources.producerRoutes }),
  });
}

/**
 * This view's capture work `render-capture-schedule` prepared, then the
 * shared Feature work its sealed Feature frame joins. `undefined` means the
 * host rejected the frame.
 */
export function prepareFeatureHostFrame(
  owner: ViewSettlementOwner,
  input: RenderFeatureFrameInput | undefined,
): Omit<RecordFeatures, 'plan'> | undefined {
  const captures = consumeViewCaptureWork(owner);
  let featureFrame: import('./features/host').RenderFeatureFrameResult | undefined;
  if (recordContext(owner.internals).featureHost !== undefined && input !== undefined) {
    featureFrame = sealedViewFeatureResult(owner, input.identity);
    if (featureFrame === undefined) return undefined;
  }
  return {
    scheduledCaptureWork: captures.cube,
    sceneInputWork: captures.sceneInputs,
    auxiliaryCameras: captures.auxiliaryCameras,
    faces: captures.faces,
    featureFrame,
  };
}

/**
 * The capture work `render-capture-schedule` prepared for this view. A view
 * it did not prepare records no captures; a failure rethrows inside the
 * recording's own recovery.
 */
export function consumeViewCaptureWork(owner: ViewSettlementOwner): ViewCaptureFrame {
  const outcome = viewCaptureWorkOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
  if (outcome?.kind === 'failed') throw outcome.cause;
  return outcome?.value ?? EMPTY_VIEW_CAPTURES;
}

/**
 * This view's result in the Feature batch RenderPrepare sealed. An
 * incomplete batch is reported and rejects the recording; a failed one
 * rethrows inside the recording's own recovery.
 */
export function sealedViewFeatureResult(
  owner: ViewSettlementOwner,
  view: string,
): import('./features/host').RenderFeatureFrameResult | undefined {
  const outcome = featureFrameOutcome(renderWorldFor(owner.internals));
  if (outcome === undefined) {
    owner.internals.errorRegistry.fire(
      new RenderFeatureInputUnavailableError({ view, reason: 'not-prepared' }),
    );
    return undefined;
  }
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'incomplete') {
    owner.internals.errorRegistry.fire(outcome.error);
    return undefined;
  }
  const result = outcome.batch.views.get(view);
  if (result === undefined) throw new Error('Renderer Feature batch omitted a prepared view');
  return result;
}

/**
 * Admit this view's sealed Feature result into the recording and read the
 * plan `render-feature-plan` planned from it in RenderQueue. A rejected plan
 * is reported and rejects the recording; a failed one rethrows inside the
 * recording's own recovery.
 */
export function admitViewFeaturePlan(
  owner: ViewSettlementOwner,
  featureFrame: import('./features/host').RenderFeatureFrameResult | undefined,
): ViewFeaturePlan | undefined {
  const outcome = viewFeaturePlanOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
  if (outcome === undefined) {
    owner.internals.errorRegistry.fire(
      planMissingError({ code: 'feature-plan-missing', system: RENDER_FEATURE_PLAN_SYSTEM }),
    );
    return undefined;
  }
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'rejected') {
    owner.internals.errorRegistry.fire(outcome.error);
    return undefined;
  }
  if (recordContext(owner.internals).featureHost === undefined || featureFrame === undefined)
    return outcome.plan;
  if (featureFrame.preparationPending)
    markPipelinePreparationPending(owner.frameState, featurePreparationPendingReason(featureFrame));
  owner.recorded.visibility.explicitlyHidden = featureFrame.hiddenEntityReports.length;
  reportPendingRenderFeatureErrors(
    featureFrame.errors,
    owner.frameState.frameNumber,
    owner.recording.pendingFeatureErrors,
    owner.internals.errorRegistry,
  );
  return outcome.plan;
}

/**
 * Stage this view's culled dispatch for `render-phase-sort`, then wait at the
 * frame's RenderQueue barrier. Native Scene Passes own their ordering, so a
 * GPU-driven view stages nothing; CPU-only and manual recording order
 * queue-selected or blended work without touching opaque slots.
 */
export function stageRecordQueue(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  frame: ExtractedFrame,
  view: RecordView,
  scene: RecordScene,
): {
  readonly gpuDriven: GpuDrivenRecordInput;
  readonly records: boolean;
  readonly sorted: boolean;
} {
  const world = renderWorldFor(owner.internals);
  const gpuDrivenScene = owner.scene.compositionGpuDrivenState();
  const sorted = scene.shadowCasterProjection === undefined || gpuDrivenScene === undefined;
  // selectRecordView admitted this view through its entity's ViewLights.
  const entity = owner.internals.viewEntity;
  if (entity === undefined) throw new Error('A queued recording requires its view entity');
  const phases = viewPhaseQueue(world, entity);
  const { projection } = scene.visibility;
  if (sorted)
    phases.stage({
      dispatch: projection.dispatch,
      scope: resourceScope(attempt),
      cameras: view.cameras,
      rows: new FrameProjection(projection.renderables, (source) => ({
        transform: source.transform,
        material: source.material.snapshot,
        worldId: source.worldId,
      })),
      profile: attempt.profileSession,
    });
  const captures = consumeViewCaptureWork(owner);
  const records = recordsViewWork(attempt.mode, captures);
  stageViewPassPlan(
    owner,
    world,
    entity,
    view,
    scene,
    sorted,
    attempt.mode !== true,
    records ? gpuDrivenScene : undefined,
  );
  const gpuDriven = recordingGpuDrivenInput(owner, attempt, frame, scene, gpuDrivenScene);
  const camera = view.cameras[0];
  if (records && camera !== undefined)
    stageViewGpuDrivenPrepareInput(world, entity, {
      internals: owner.internals,
      frameState: owner.frameState,
      worlds: attempt.scopes,
      camera,
      lights: view.lights,
      renderables: projection.renderables,
      shadowCasterProjection: scene.shadowCasterProjection,
      materialBindingClasses: scene.reflectionProbes.bindingClasses,
      gpuDriven,
      captureShadows:
        captures.faces.length > 0 ||
        scene.reflectionProbes.graph.work.some((work) => work.rawCaptureFace !== undefined),
      profilePhase: recordProfileRunner(attempt.profileSession),
    });
  return { gpuDriven, records, sorted };
}

/**
 * Stage what the pass-family RenderQueue systems plan this view from. A
 * Camera-less view is a clear-only frame without draws.
 */
export function stageViewPassPlan(
  owner: ViewSettlementOwner,
  world: World,
  entity: EntityHandle,
  view: RecordView,
  scene: RecordScene,
  phaseSorted: boolean,
  captureOnly: boolean,
  gpuDrivenScene: PersistentGpuDrivenState | undefined,
): void {
  const { projection } = scene.visibility;
  const cameraless = view.cameras.length === 0;
  const renderables = cameraless ? [] : projection.renderables;
  const shadowCasterProjection = scene.shadowCasterProjection;
  const { materials, manualSubsurface } = resolveFrameMaterials(
    shadowCasterProjection,
    shadowCasterProjection?.renderables ?? renderables,
  );
  const camera = view.cameras[0] ?? makeZeroCameraFallbackSnapshot();
  viewPassPlanQueue(world, entity).stage({
    requested: view.cameras[0]?.transparency ?? 'sorted',
    rgba16floatRenderable: owner.internals.device.caps.rgba16floatRenderable,
    renderables,
    dispatch: cameraless ? [] : projection.dispatch,
    phaseSorted: phaseSorted && !cameraless,
    materials,
    sceneTransmission: owner.scene.transmissionTopologyDemand(),
    preparation: owner.frameState.candidatePipelinePreparations?.materials,
    renderPath: (
      owner.frameState.cameraStandardProfile ??
      owner.internals.standardProfile ??
      DEFAULT_STANDARD_PROFILE
    ).renderPath,
    gpuOcclusion: owner.frameState.installedPipelineConfig?.gpuOcclusion,
    clearOnly: cameraless,
    ssr: {
      camera,
      dependencies: scene.ssrDependencies,
      probeFallbackDemand: scene.reflectionProbes.fallbackDemand === true,
      capabilities: owner.internals.device.caps,
    },
    subsurface: subsurfaceAdmissionInput(
      owner.internals,
      owner.frameState,
      camera,
      renderables.length,
      shadowCasterProjection,
      manualSubsurface,
      captureOnly,
    ),
    ...(gpuDrivenScene === undefined || cameraless ? {} : { gpuDrivenScene }),
  });
}

/** The same frame input is staged before Queue and consumed after it. */
export function recordingGpuDrivenInput(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  frame: ExtractedFrame,
  scene: RecordScene,
  gpuDrivenScene: PersistentGpuDrivenState | undefined,
): GpuDrivenRecordInput {
  const { projection } = scene.visibility;
  const frustumStats = frame.frustumStats;
  const captureOnly = attempt.mode === 'capture';
  const surfaceDynamicInput = surfaceDynamicInputOf(renderWorldFor(owner.internals));
  return {
    owner: owner.gpuDriven,
    scene: gpuDrivenScene,
    activeEntityKeys: projection.activeEntityKeys,
    activeEntityRevision: projection.activeEntityRevision,
    visibleRasterRows: () => Math.max(0, frustumStats.total - frustumStats.culled),
    ...(captureOnly || frame.cameraVisible === undefined
      ? {}
      : { cameraVisible: frame.cameraVisible }),
    ...(captureOnly || frame.cameraAdmission === undefined
      ? {}
      : { cameraAdmission: frame.cameraAdmission }),
    telemetryCandidateCount: scene.lodCandidateCount,
    telemetrySubmit: {
      frameId: scene.lodFrameId,
      deviceGeneration: recordContext(owner.internals).deviceScope.generation,
    },
    frameTime: cameraFrameTime(attempt),
    deviceGeneration: recordContext(owner.internals).deviceScope.generation,
    ...(surfaceDynamicInput === undefined ? {} : { surfaceDynamicInput }),
    ...(attempt.opts.geometryLane === undefined ? {} : { geometryLane: attempt.opts.geometryLane }),
  };
}

export function cameraFrameTime(attempt: RecordAttempt): number {
  const elapsed = renderTime(cameraScope(attempt)).elapsed;
  return Number.isFinite(elapsed) ? elapsed : 0;
}

/** Track actual draws so a clear/submit cannot claim visible geometry was presented. */
export function presentedRenderableRecorder(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  worldKeys: readonly number[],
  gpuOwnedFrame: GpuOwnedFrame | undefined,
) {
  const presentedDraws = createPresentationDraws();
  const drawObservation = createDrawObservation(owner.internals);
  const viewReceipt = viewDrawReceipt(renderWorldFor(owner.internals), owner.internals.viewEntity);
  const consumeDynamicGeometry = viewReceipt?.dynamicGeometry.onRenderableDraw(attempt.scopes);
  let gpuSelection = EMPTY_GPU_DRAW_SELECTION;
  // Rows the submitted selection draws get no per-row receipt; their
  // consumers ask the frozen frame and selection on demand.
  const gpuOwned =
    gpuOwnedFrame === undefined
      ? undefined
      : {
          frame: gpuOwnedFrame,
          submitted: (selection: GpuDrawSelection): void => {
            gpuSelection = selection;
            if (!selection.empty) drawObservation.recordGpuLane();
            viewReceipt?.dynamicGeometry.onGpuOwnedDraws(
              attempt.scopes,
              (worldId, entity, mesh) => {
                const row = gpuOwnedFrame.row(worldId, entity);
                return (
                  row?.assetHandle === mesh &&
                  row.gpuDrivenDraws?.some((draw, index) => selection.owns(row, draw, index)) ===
                    true
                );
              },
            );
          },
        };
  const sourceWorlds = attempt.composition.worlds;
  const markPresentedRenderable = (
    entry: Parameters<typeof drawObservation.record>[0],
    submeshIndex?: number,
    receipt?: RenderableDrawReceipt,
  ): void => {
    const entityKey = worldEntityKey(
      worldKeys[entry.source.worldId] ?? entry.source.worldId,
      entry.source.entityKey,
    );
    if (receipt?.ready !== false) {
      presentedDraws.record(
        entityKey,
        submeshIndex,
        submeshIndex === undefined ? undefined : entry.source.terrainSection?.index,
      );
    }
    drawObservation.record(entry, submeshIndex, receipt, sourceWorlds[entry.source.worldId]);
    consumeDynamicGeometry?.(entry, receipt?.lane ?? 'cpu');
  };
  return {
    presentedDraws,
    drawObservation,
    markPresentedRenderable,
    gpuOwned,
    readGpuSelection: () => gpuSelection,
  };
}

/**
 * Record and submit the frame. The record stage resolves each renderable's
 * mesh and material textures against the World it was extracted from
 * (`worlds[renderable.worldId]`); `resourceWorld` stays the singleton
 * resource owner (skybox equirect, transparent-sort config, video provider).
 */
export function prepareViewFrameInput(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  frame: ExtractedFrame,
  view: RecordView,
  scene: RecordScene,
  features: RecordFeatures,
  queued: RecordQueue,
) {
  const { cameras, lights } = view;
  const captureOnly = attempt.mode === 'capture';
  // Display media (volumes, cloud layers) never enter a capture view's raw scene.
  const displayMedia = !captureOnly && recordContext(owner.internals).captureView === undefined;
  const { projection } = scene.visibility;
  const environment = frame.environment;
  const { dispatch: orderedDispatch } = queued;
  const bloomAdmitted = standardBloomAdmitted(cameras[0]);
  if (bloomAdmitted)
    recordContext(owner.internals).getPipelineState()?.perPassResources.ensureBloomResources?.();
  // RenderCommit adopts this view's AA/DoF/bloom when its submission is accepted.
  postSubmissionsOf(renderWorldFor(owner.internals)).staged.push({
    entity: owner.internals.viewEntity,
    frameState: owner.frameState,
    internals: owner.internals,
    camera: cameras[0],
    bloomAdmitted,
  });
  const surfaceSubmissionCandidate = owner.surfaceSubmission.begin({
    frameId: observationFrameId(owner),
    requestedLane: attempt.opts.geometryLane === 'direct' ? 'direct' : 'gpu-driven',
    deviceGeneration: recordContext(owner.internals).deviceScope.generation,
    resourceGeneration: (() => {
      const gpu = viewGpuDrivenOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
      return gpu?.kind === 'selected' && gpu.preparation !== undefined
        ? gpu.preparation.resourceGeneration
        : owner.gpuDriven.resourceGeneration;
    })(),
  });
  owner.frameState.surfaceSubmissionObservation = surfaceSubmissionCandidate;
  const draws = presentedRenderableRecorder(
    owner,
    attempt,
    scene.visibility.worldKeys,
    frame.gpuOwned,
  );
  const input: FrameRecordingInput = {
    internals: owner.internals,
    world: resourceScope(attempt),
    cameras: cameras,
    lights: lights,
    renderables: projection.renderables,
    transparentDispatch: orderedDispatch,
    frameState: owner.frameState,
    dispatchCounts: owner.recording.dispatchCounts,
    bindGroupCounts: owner.recorded.bindGroups,
    skylight: frame.skylight,
    skylightCount: frame.skylightCount,
    skybox: frame.skybox,
    postProcessParams: frame.postProcessParams,
    worlds: attempt.scopes,
    profilePhase: recordProfileRunner(attempt.profileSession),
    gpuDriven: {
      ...queued.gpuDriven,
      ...(draws.gpuOwned === undefined ? {} : { gpuOwned: draws.gpuOwned }),
    },
    renderReadLeases: attempt.composition.leases,
    cubeCapture: cubeCaptureFrameInput(owner, attempt, scene, features),
    environmentSignature: environment?.environmentSignature ?? '',
    fogSignature: environment?.fogSignature ?? '',
    environmentReady: frame.environmentReady && environment !== undefined,
    volumetricFog: displayMedia ? frame.volumetricFog : undefined,
    timingCapture: attempt.timingCapture,
    shadowCasterProjection: scene.shadowCasterProjection,
    shadowCasterWorldKeys: scene.visibility.worldKeys,
    onRenderableDraw: draws.markPresentedRenderable,
    analyticFog: environment?.fog,
    sampleTimeSeconds: attempt.opts.sampleTimeSeconds,
    temporalReset: attempt.opts.temporalReset === true,
    cloudLayer: displayMedia ? frame.cloudLayer : undefined,
    directionalShadowCascadeCount: lights.cascades?.cascadeCount,
    rendererRecording: true,
  };
  return { input, draws, surfaceSubmissionCandidate };
}

/** Retained-scene captures recorded beside this view: Cube faces, planar mirrors, probes, scene inputs. */
export function hasCaptureConsumers(scene: RecordScene, features: RecordFeatures): boolean {
  return (
    features.auxiliaryCameras.length > 0 ||
    features.sceneInputWork.length > 0 ||
    features.scheduledCaptureWork.length > 0 ||
    scene.reflectionProbes.graph.work.some((work) => work.rawCaptureFace !== undefined)
  );
}

export function cubeCaptureFrameInput(
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
  scene: RecordScene,
  features: RecordFeatures,
): CubeCaptureFrameInput {
  const shadowCasterProjection = scene.shadowCasterProjection;
  return {
    scheduledWork: features.scheduledCaptureWork,
    captureOnly: attempt.mode !== true,
    sceneInputs: features.sceneInputWork,
    auxiliaryCameras: features.auxiliaryCameras,
    faces: features.faces,
    state: owner.captures,
    reflectionProbes: scene.reflectionProbes,
    fits:
      viewCaptureFitsOf(renderWorldFor(owner.internals), owner.internals.viewEntity) ??
      NO_CAPTURE_FITS,
    ...(shadowCasterProjection === undefined || !hasCaptureConsumers(scene, features)
      ? {}
      : { subsurfaceDemand: shadowCasterProjection.content.subsurface.authorVisible }),
  };
}

export function reportRecordFailure(owner: ViewSettlementOwner, cause: unknown): void {
  discardStandardOutputStates(owner.frameState);
  if (cause instanceof ProjectedDecalInvalidError) throw cause;
  owner.internals.errorRegistry.fire(recordFailureError(cause));
}
