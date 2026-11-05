import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type AssetHandle, ok, type RenderPipelineAsset } from '@forgeax/engine-types';
import { createRendererCaptureOwner } from '../capture/renderer-captures';
import { Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { StereoCamera } from '../components/stereo-camera';
import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import {
  createFeatureGraphConformanceTrace,
  readFeatureGraphConformanceTrace,
} from '../features/feature-graph-conformance-trace';
import type { CameraViewInspection } from '../inspection-types';
import type { RenderPublicationIdentity } from '../publication/contract';
import type { PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { DiffuseGiBudget } from '../raytracing/diffuse-gi-budget';
import type {
  CandidatePipelineDemandReader,
  CandidatePipelineInput,
} from '../record/candidate-pipeline-preparation';
import { readCandidateViewDemand } from '../record/candidate-view-demand';
import {
  readClusterWorkFrameTrace,
  readClusterWorkObservation,
  recordClusterWorkFrameReceiptForConformance,
} from '../record/cluster-work-conformance';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
import type {
  CameraSnapshot,
  DrawOwnerOptions,
  FramePresentation,
  FramePresentationPendingReason,
} from '../render-contract';
import { selectCameraRoles } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import { configureViewStandard, prepareViewCandidatePipelines } from '../view-configuration';
import {
  viewBloom,
  viewDiffuseGi,
  viewGraphInfo,
  viewPassNames,
  viewSsr,
  viewTemporal,
} from '../view-inspection';
import { registerCaptureSystems } from '../world/capture-systems';
import { registerGiSystems } from '../world/gi-systems';
import { lodObservationOf, registerLodObservationSystem } from '../world/lod-observation-systems';
import { registerPointsLinesSystems } from '../world/points-lines-systems';
import { viewRecordHistory } from '../world/record-history';
import {
  assertViewCameras,
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  ViewRecorder,
} from '../world/render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  renderSubmission,
} from '../world/render-world';
import { registerSceneRowSystems } from '../world/scene-row-systems';
import { retireAfterSubmission } from '../world/submission-systems';
import { registerViewDrawSystems, viewDrawReceipt } from '../world/view-draw-receipt';
import { stageRenderScene, viewPublication } from '../world/view-frame-systems';
import {
  registerViewOutputSystems,
  registerViewRecorderSystem,
  retireViews,
  throwViewFailure,
  type ViewRecorderFactory,
  type ViewRecorderState,
  viewComposition,
} from '../world/view-output-systems';
import { recordContext } from '../world/view-record-context';
import { createViewRecorder } from '../world/view-recorder';
import { type ViewSettlementOwner, viewOwnerOf } from '../world/view-settlement';
import { drainFramePreparation, type FramePreparation } from './frame-recording';
import type { LodObservationCapture, LodObservationViewCapture } from './lod-observation';
import { prepareRenderFrame } from './render-frame';
import { createViewCompositor } from './view-compositor';

/** Open this frame's GPU timing capture, recording why it could not begin. */
function beginGpuTimingFrame(internals: RenderSystemInternals, graphGeneration: number): void {
  internals.gpuPassTimingCapture = undefined;
  internals.gpuPassTimingSubmittedWork = undefined;
  internals.gpuPassTimingBeginReason = undefined;
  const timingIdentity = internals.gpuPassTimingFrameIdentity;
  if (timingIdentity === undefined) return;
  const started = internals.gpuPassTimingSession?.beginFrame({
    ...timingIdentity,
    graphGeneration,
  });
  if (started?.ok === true) internals.gpuPassTimingCapture = started.value;
  else if (started?.ok === false) internals.gpuPassTimingBeginReason = started.error;
}

/** Every view consumes the same precise accepted asset changes. */
function adoptPublicationAssets(
  internals: RenderSystemInternals,
  publication: PreparedRenderPublication,
): void {
  const store = internals.gpuStore;
  const resources = publication.resources;
  for (const change of publication.assetChanges) {
    const payload = resources.resolveAsset(change.handle).unwrap();
    store
      .adoptMeshChange(change, payload.kind === 'mesh' ? payload : undefined, resources)
      .unwrap();
    store
      .adoptTextureChange(change, payload.kind === 'texture' ? payload : undefined, resources)
      .unwrap();
    store.invalidateSampler(change.handle, resources);
    store.adoptCubemapChange(change, resources);
  }
  for (const handle of publication.packet.retiredAssets) {
    store.invalidateMesh(handle, resources);
    store.invalidateSampler(handle, resources);
    store.evictCubemap(handle, resources);
    store.invalidateTexture(handle as AssetHandle<'texture'>, resources);
  }
}

/** Membership-only probe: does any camera declare a composed CameraView or StereoCamera? */
function declaresComposedViews(world: World): boolean {
  for (const composed of [CameraView, StereoCamera]) {
    const query = world.query({ with: [Camera, composed] }).unwrap();
    for (const span of query.spans().unwrap()) if (span.length > 0) return true;
  }
  return false;
}

/** Membership-only probe: does any non-composed Camera name a RenderTarget? */
function declaresTargetCamera(world: World): boolean {
  const query = world.query({ with: [Camera], without: [CameraView, StereoCamera] }).unwrap();
  const reader = world[worldRead];
  for (const span of query.spans().unwrap()) {
    const entities = span.entities;
    for (let index = 0; index < span.length; index++)
      if (reader.getFieldValue(entities[index] as EntityHandle, Camera, 'target') !== 0)
        return true;
  }
  return false;
}

/** Selected auxiliary RenderTarget cameras; planar mirrors stay with their display view. */
function captureCameras(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
  cameraEntityKey: number | undefined,
): readonly CameraSnapshot[] {
  let auxiliary = publication?.frame.auxiliaryCameras;
  if (auxiliary === undefined) {
    if (world === undefined || !declaresTargetCamera(world)) return [];
    try {
      auxiliary = selectCameraRoles(world, cameraEntityKey).auxiliary;
    } catch {
      // Invalid camera facts belong to the primary extraction, which reports
      // the same structured failure for this frame.
      return [];
    }
  }
  return auxiliary.filter(
    (camera) => camera.planarReflection === undefined && camera.target !== undefined,
  );
}

/**
 * Renderer-owned views share one device, asset cache, frame encoder and
 * submission. Each view is a Render World entity ({@link RenderView}); its
 * private recording state is the entity's {@link ViewRecorder}.
 */
export function createCameraViews(
  internals: RenderSystemInternals,
  maxRenderShortSide = 0,
  borrowAcceptedDemand?: RenderPublicationReceiver['borrowAcceptedDemand'],
) {
  const renderWorld = internals.renderWorld ?? createRenderWorld();
  const views = new RenderViews(renderWorld);
  registerViewDrawSystems(renderWorld);
  registerPointsLinesSystems(renderWorld);
  registerGiSystems(renderWorld);
  /** The frame's camera declarations: one retained resource the frame entry rewrites. */
  const viewSource = new RenderViewFrameSource(internals);
  renderWorld.insertResource(RenderViewInput, viewSource);
  const plan = viewComposition(renderWorld);
  const primaryOwner = viewOwnerOf(internals);
  const composition = internals.sceneComposition;
  if (composition === undefined)
    throw new Error('The primary RenderSystem owns the scene composition');
  registerSceneRowSystems(renderWorld, composition, (error) => internals.errorRegistry.fire(error));
  // Every view's field splits the per-frame GI budgets through this one owner.
  internals.giBudget ??= new DiffuseGiBudget();
  if (internals.rendererCaptureOwner === undefined) {
    const captureOwner = createRendererCaptureOwner((target) =>
      internals.getRenderTargetPhysical?.(target),
    );
    internals.rendererCaptureOwner = captureOwner;
    registerCaptureSystems(renderWorld, captureOwner, (error) =>
      internals.errorRegistry.fire(error),
    );
  }
  let frame = 0;
  const retire = (view: ViewRecorderState) => {
    view.retired = true;
    const dispose = () => {
      if (view.output !== undefined) view.device.destroyTexture(view.output.texture);
      view.composite.dispose();
      view.owner.disposeFrameState();
      view.scope.dispose();
    };
    retireAfterSubmission(renderWorld, {
      generation: view.scope.generation,
      queue: view.device.queue,
      release: dispose,
    });
  };
  const clear = () => {
    viewSource.clear();
    retireViews(renderWorld, views, internals);
  };
  const recorderOf = (entity: EntityHandle): ViewRecorderState | undefined =>
    renderWorld.hasComponent(entity, ViewRecorder)
      ? renderWorld
          .resolveUniqueRef<ViewRecorderState>(renderWorld.get(entity, ViewRecorder).unwrap().state)
          .unwrap()
      : undefined;
  /** The first live recorder in composition order that satisfies `match`. */
  const findRecorder = (
    match: (view: ViewRecorderState) => boolean = () => true,
  ): ViewRecorderState | undefined => {
    for (const entity of views.ordered) {
      const recorder = recorderOf(entity);
      if (recorder !== undefined && match(recorder)) return recorder;
    }
    return undefined;
  };
  /** The first live display (composed) recorder that satisfies `match`. */
  const findDisplayRecorder = (
    match: (view: ViewRecorderState) => boolean = () => true,
  ): ViewRecorderState | undefined =>
    findRecorder((view) => view.capture === undefined && match(view));
  /** Live recorders in composition order, capture views first. */
  const recorders = (): ViewRecorderState[] => {
    const live: ViewRecorderState[] = [];
    findRecorder((view) => {
      live.push(view);
      return false;
    });
    return live;
  };
  const displayRecorders = (): ViewRecorderState[] =>
    recorders().filter((view) => view.capture === undefined);
  const captureRecorders = (): ViewRecorderState[] =>
    recorders().filter((view) => view.capture !== undefined);
  /** Composed display views replace the primary display recording. */
  const active = (): boolean => views.displayCount > 0;
  /** The owners whose recordings produce this frame: composed views, else the primary and captures. */
  const owners = (): readonly ViewSettlementOwner[] =>
    active()
      ? recorders().map((view) => view.owner)
      : [primaryOwner, ...captureRecorders().map((view) => view.owner)];
  const demandReader =
    (owner: ViewSettlementOwner): CandidatePipelineDemandReader =>
    (input, materials) => {
      const accepted = borrowAcceptedDemand?.();
      if (accepted === undefined) return undefined;
      const view =
        !active() && owner === primaryOwner
          ? views.primary
          : recorders().find(
              (entry) => entry.owner === owner && (active() || entry.capture !== undefined),
            )?.entity;
      if (view === undefined) return undefined;
      const pipeline = owner.internals.lookupMaterialShaderPipeline;
      const entry = owner.internals.lookupMaterialShaderPipelineEntry;
      if (pipeline === undefined || entry === undefined) return undefined;
      const demand = readCandidateViewDemand(owner, accepted, {
        materials,
        preparation: input.preparation,
        view,
        ...(input.world === undefined ? {} : { world: input.world }),
      });
      return demand === undefined ? undefined : { ...demand, lookup: { pipeline, entry } };
    };
  /** The draw receipts dynamic geometry reads: every recorder's, or the primary view's. */
  const drawReceipts = () =>
    active()
      ? recorders().map((view) => viewDrawReceipt(renderWorld, view.entity))
      : [viewDrawReceipt(renderWorld, views.primary)];
  const presentationOf = (entity: EntityHandle | undefined): FramePresentation =>
    viewRecordHistory(renderWorld, entity)?.presentation ?? 'pending';
  const isLodObservationViewCurrent = (
    capture: LodObservationCapture,
    row: LodObservationViewCapture,
  ): boolean => {
    if (lodObservationOf(renderWorld).capture !== capture) return false;
    if (row.primary) return !active() && row.owner === primaryOwner;
    const view = row.viewRef as ViewRecorderState | undefined;
    return view !== undefined && !view.retired && view.owner === row.owner;
  };
  const createRecorder: ViewRecorderFactory = (...args) =>
    createViewRecorder(renderWorld, internals, primaryOwner, retire, ...args);
  /**
   * Record the frame: capture views, composed display views and the primary
   * system share the one encoder RenderRecord opens and one submission.
   * `render-view-outputs` decided which views record.
   */
  function* prepareRecordedSubmission(
    timing: GpuTimingCapture | undefined,
    isCurrent: (() => boolean) | undefined,
  ): FramePreparation {
    return yield* prepareRenderFrame({
      world: renderWorld,
      device: internals.device,
      frameId: internals.observationFrameId ?? renderSubmission(renderWorld).frame,
      rendererInternals: internals,
      timingCapture: timing,
      isCurrent,
      composite: plan.active,
      shared: plan.active || views.captureCount > 0,
    });
  }
  const owner = registerViewOutputSystems(renderWorld, views, internals, () =>
    createViewCompositor(internals),
  );
  registerViewRecorderSystem(renderWorld, views, { internals, createRecorder });
  registerLodObservationSystem(renderWorld, views, { internals });
  return {
    async prepareCandidatePipelines(input: CandidatePipelineInput, signal?: AbortSignal) {
      const results = await Promise.all(
        owners().map((owner) =>
          prepareViewCandidatePipelines(owner, input, signal, demandReader(owner)),
        ),
      );
      const failed = results.find((result) => !result.ok);
      const release = () => {
        for (const result of results) if (result.ok) result.value.release();
      };
      if (failed !== undefined && !failed.ok) {
        release();
        return failed;
      }
      return ok({
        isCurrent: () => results.every((result) => result.ok && result.value.isCurrent()),
        release,
      });
    },
    terrainSections() {
      return active()
        ? displayRecorders().map((view) => ({
            view: view.key,
            sections: viewDrawReceipt(renderWorld, view.entity)?.terrain ?? [],
          }))
        : [
            {
              view: 'primary',
              sections: viewDrawReceipt(renderWorld, views.primary)?.terrain ?? [],
            },
          ];
    },
    get currentOwner(): ViewSettlementOwner {
      return active() ? (findDisplayRecorder()?.owner ?? primaryOwner) : primaryOwner;
    },
    get lastLodObservationCapture(): LodObservationCapture | undefined {
      return lodObservationOf(renderWorld).capture;
    },
    isLodObservationCaptureCurrent(capture: LodObservationCapture): boolean {
      return (
        lodObservationOf(renderWorld).capture === capture &&
        capture.views.every((row) => isLodObservationViewCurrent(capture, row))
      );
    },
    isLodObservationViewCurrent(
      capture: LodObservationCapture,
      row: LodObservationViewCapture,
    ): boolean {
      return isLodObservationViewCurrent(capture, row);
    },
    get perFramePassNames(): readonly string[] {
      return internals.submittedPassNames ?? [];
    },
    bounds(world: World | RenderPublicationIdentity, entity: number) {
      for (const view of owners()) {
        const bounds = view.scene.bounds(world, entity);
        if (bounds !== undefined) return bounds;
      }
      return undefined;
    },
    configureStandard(config: RenderPipelineAsset['config']) {
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)])
        configureViewStandard(owner, config);
    },
    setGtaoExecutionOverride(override: 'fragment' | 'compute' | undefined) {
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)])
        owner.frameState.gtaoExecutionOverride = override;
    },
    armGtaoCandidatePreparationFailureForConformance() {
      const owner = active() ? (findDisplayRecorder()?.owner ?? primaryOwner) : primaryOwner;
      owner.frameState.gtaoCandidatePreparationFailureGeneration = recordContext(
        owner.internals,
      ).deviceScope.generation;
    },
    setClusterWorkObservationForConformance(enabled: boolean) {
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)])
        owner.frameState.standardClusterWorkConformance = enabled ? { enabled: true } : undefined;
    },
    clusterWorkObservationForConformance() {
      const owner = active() ? (findDisplayRecorder()?.owner ?? primaryOwner) : primaryOwner;
      const state = owner.frameState.standardClusterWorkConformance;
      return state === undefined
        ? undefined
        : readClusterWorkObservation(state, recordContext(owner.internals).deviceScope.generation);
    },
    clusterWorkFrameTraceForConformance() {
      const owner = active() ? (findDisplayRecorder()?.owner ?? primaryOwner) : primaryOwner;
      return readClusterWorkFrameTrace(owner.frameState.standardClusterWorkConformance);
    },
    recordClusterWorkReceiptForConformance(
      input: Parameters<typeof recordClusterWorkFrameReceiptForConformance>[1],
    ) {
      let recorded = false;
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)]) {
        if (
          readClusterWorkFrameTrace(owner.frameState.standardClusterWorkConformance)
            ?.observationFrameId !== input.observationFrameId
        )
          continue;
        recorded =
          recordClusterWorkFrameReceiptForConformance(
            owner.frameState.standardClusterWorkConformance,
            input,
          ) || recorded;
      }
      return recorded;
    },
    setFeatureGraphTraceForConformance(identity: string | undefined) {
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)]) {
        const context = recordContext(owner.internals);
        if (identity === undefined) delete context.featureGraphConformanceTrace;
        else context.featureGraphConformanceTrace = createFeatureGraphConformanceTrace(identity);
      }
    },
    featureGraphTraceForConformance() {
      const owner = active() ? (findDisplayRecorder()?.owner ?? primaryOwner) : primaryOwner;
      return readFeatureGraphConformanceTrace(
        recordContext(owner.internals).featureGraphConformanceTrace,
      );
    },
    cancelGraphTargetCapture(
      request: import('../record/frame-snapshot').GraphTargetCaptureRequest,
    ) {
      for (const owner of [primaryOwner, ...recorders().map((view) => view.owner)])
        if (owner.frameState.graphTargetCapture === request)
          owner.frameState.graphTargetCapture = undefined;
    },
    isDynamicGeometryConsumed(
      world: RenderResourceScope,
      entity: number,
      meshHandle: number | undefined,
    ): boolean {
      return drawReceipts().some(
        (receipt) => receipt?.dynamicGeometry.isConsumed(world, entity, meshHandle) === true,
      );
    },
    dynamicGeometryRecordStageLane(
      world: RenderResourceScope,
      entity: number,
      meshHandle: number | undefined,
    ): DynamicGeometryRecordStageLane | undefined {
      for (const receipt of drawReceipts()) {
        const lane = receipt?.dynamicGeometry.recordStageLane(world, entity, meshHandle);
        if (lane !== undefined) return lane;
      }
      return undefined;
    },
    /** True while a progressive CubeCamera candidate still owns unfinished faces. */
    isCubeCapturePending(target: RenderTarget): boolean {
      return internals.rendererCaptureOwner?.isPending(target) ?? false;
    },
    get active() {
      return active();
    },
    /** A pending recorder holds the frame; without composed views the primary presents. */
    get presentation(): FramePresentation {
      if (findRecorder((view) => presentationOf(view.entity) !== 'ready') !== undefined)
        return 'pending';
      return active() ? 'ready' : presentationOf(views.primary);
    },
    get presentationPendingReason(): FramePresentationPendingReason | undefined {
      const primaryReason = active()
        ? undefined
        : viewRecordHistory(renderWorld, views.primary)?.pendingReason;
      if (primaryReason !== undefined) return primaryReason;
      const view = findRecorder((candidate) => presentationOf(candidate.entity) === 'pending');
      return view === undefined
        ? undefined
        : Object.freeze({
            ...(viewRecordHistory(renderWorld, view.entity)?.pendingReason ?? {
              code: 'camera-view-pending' as const,
            }),
            view: view.key.slice(0, 256),
          });
    },
    inspect(): readonly CameraViewInspection[] {
      return displayRecorders().map((v) => {
        const diffuseGi = viewDiffuseGi(v.owner);
        return {
          entityKey: v.camera,
          ...(v.eye === undefined ? {} : { eye: v.eye }),
          viewport: [v.viewport.x, v.viewport.y, v.viewport.width, v.viewport.height],
          width: v.output?.width ?? 0,
          height: v.output?.height ?? 0,
          renderedFrames: v.renderedFrames,
          output: v.target === undefined ? 'screen' : 'texture',
          passes: [...viewPassNames(v.owner)],
          bloom: viewBloom(v.owner),
          ssr: viewSsr(v.owner),
          dynamicResolution: v.owner.frameState.dynamicResolution?.inspect(),
          temporal: viewTemporal(v.owner),
          frustum: { ...v.owner.recorded.frustum },
          visibility: { ...v.owner.recorded.visibility },
          ...(diffuseGi === undefined ? {} : { diffuseGi }),
        };
      });
    },
    dispose() {
      clear();
      owner.compositor.dispose();
    },
    reset() {
      clear();
    },
    detach(world: World) {
      if (owner.identity === world.identity) clear();
    },
    draw(...args: Parameters<typeof this.prepareSubmission>): boolean {
      return drainFramePreparation(this.prepareSubmission(...args));
    },
    *prepareSubmission(
      worlds: readonly World[],
      opts: DrawOwnerOptions,
      leases?: readonly RenderReadLease[],
      timing?: GpuTimingCapture,
      source?: {
        readonly publication: PreparedRenderPublication;
        readonly receiver: RenderPublicationReceiver;
      },
      isCurrent?: () => boolean,
    ): FramePreparation {
      frame += 1;
      internals.rendererFrameNumber = frame;
      let frameSubmitted = false;
      beginGpuTimingFrame(
        internals,
        active() ? owner.compositor.generation : (viewGraphInfo(primaryOwner)?.generation ?? 0),
      );
      try {
        const publication = source?.publication;
        if (publication !== undefined) adoptPublicationAssets(internals, publication);
        const world = worlds[opts.cameraOwner];
        // The primary system owns extraction and diagnostic publication when no
        // composed view is declared. This admission probe reads membership only.
        const declaresViews =
          publication === undefined && world !== undefined && declaresComposedViews(world);
        const cap =
          Math.min(internals.canvas.width, internals.canvas.height) > maxRenderShortSide
            ? maxRenderShortSide
            : 0;
        const cameras =
          publication?.frame.cameras ??
          ((!declaresViews && cap === 0) || world === undefined
            ? []
            : selectCameraRoles(world, opts.cameraEntityKey).display);
        const captures = captureCameras(publication, world, opts.cameraEntityKey);
        assertViewCameras(cameras, cap > 0);
        viewSource.stage(
          cameras,
          captures,
          worlds,
          opts,
          leases,
          publication,
          source?.receiver,
          cap,
        );
        stageRenderScene(
          renderWorld,
          primaryOwner,
          worlds,
          opts,
          leases,
          viewPublication(viewSource, primaryOwner.scene),
        );
        beginRenderFrame(renderWorld, frame);
        // The view owner, recorder and output systems ran inside beginRenderFrame.
        throwViewFailure(renderWorld);
        if (plan.blocked) return false;
        frameSubmitted = yield* prepareRecordedSubmission(timing, isCurrent);
        return frameSubmitted;
      } finally {
        if (!frameSubmitted) internals.gpuPassTimingCapture?.abort({ code: 'frame-aborted' });
        endRenderFrame(renderWorld);
      }
    },
  };
}
