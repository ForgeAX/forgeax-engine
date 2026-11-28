import { defineSystem, type EntityHandle, type QueryRow, type World } from '@forgeax/engine-ecs';
import { markDerivedComponentChanged } from '@forgeax/engine-ecs/projection';
import { AssetError } from '@forgeax/engine-types';
import { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import { discardStandardOutputStates } from '../pipeline/standard-output/resources';
import {
  createFrameRecordingAttempt,
  prepareFrameGraphInputs,
  releaseFrameRecordingAttempt,
  settlePreparedViewGraph,
  stageFrameCaptureCompletion,
  stageFrameRecordingResources,
} from '../record/frame';
import { activeRenderProfileSession } from '../record/profile-session';
import { disposeTargetCaptureLighting } from '../record/target-capture-lighting';
import {
  admitRecordFeatures,
  beginGeometryObservation,
  beginRecordAttempt,
  prepareRecordScene,
  prepareViewFrameInput,
  reportRecordFailure,
  selectRecordView,
  stageRecordQueue,
} from '../render-system-record';
import type { RecordAttempt } from '../render-system-record-attempt';
import {
  RenderFeaturePlanOrder,
  RenderFrameSubmitOrder,
  RenderGpuDrivenRasterOrder,
  RenderOpaquePlanOrder,
  RenderPhaseSortOrder,
  RenderRecordRetireOrder,
  RenderTransmissionPlanOrder,
  RenderTransparentPlanOrder,
  RenderViewGraphPrepareOrder,
  RenderViewRecordSettleOrder,
} from '../system-order';
import { sharedFeatureGraphStaged, stageSharedFeatureGraph } from './feature-graph-systems';
import { frameSubmitOutcome } from './frame-submit-systems';
import { FrameViewList } from './frame-view-list';

import { stagePreparedViewGraph } from './graph-seal-systems';
import { viewPhaseQueue } from './queue-systems';
import { ViewRecordHistory, viewRecordHistory } from './record-history';
import { RenderRecordInput } from './record-systems';
import { recordViewSubmission, ViewRecorder, ViewSubmission } from './render-views';
import {
  RenderCleanup,
  RenderQueue,
  RenderRecord,
  renderSubmission,
  renderWorldFor,
} from './render-world';
import { requireViewField } from './view-field';
import { ViewFrame, type ViewFrameState, viewFrameScopes } from './view-frame-systems';
import { viewComposition } from './view-output-systems';
import { ViewRecordAttempt, type ViewRecordAttemptState } from './view-record-attempt';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const RENDER_VIEW_RECORD_START_SYSTEM = 'render-view-record-start';
export const RENDER_VIEW_GRAPH_PREPARE_SYSTEM = 'render-view-graph-prepare';
export const RENDER_VIEW_RECORD_SETTLE_SYSTEM = 'render-view-record-settle';
export const RENDER_VIEW_RECORD_RELEASE_SYSTEM = 'render-view-record-release';

function prepareFailure(
  owner: ViewSettlementOwner,
  state: ViewRecordAttemptState,
  cause: unknown,
): void {
  state.preparation = { kind: 'failed', cause, reported: false };
  try {
    reportRecordFailure(owner, cause);
    state.preparation = { kind: 'failed', cause, reported: true };
  } catch (reporting) {
    state.preparation = {
      kind: 'failed',
      cause: new AggregateError([cause, reporting], 'Render failure reporting failed'),
      reported: false,
    };
  }
}
function startAttempt(
  world: World,
  owner: ViewSettlementOwner,
  staged: ViewFrameState,
  state: ViewRecordAttemptState,
): void {
  const frame = renderSubmission(world).frame;
  if (staged.frame !== frame || state.frame === frame) return;
  state.frame = frame;
  state.settled = false;
  try {
    state.generation = recordContext(owner.internals).deviceScope.generation;
    if (staged.result === undefined)
      throw new Error('render-view-frame did not prepare the recording view');
    const inputs = viewFrameScopes(world, staged);
    if (inputs.source === undefined)
      throw new Error('A recording requires its accepted source scope');
    owner.recording.preparedSourceScope = inputs.source;
    const input = world.getResource(RenderRecordInput);
    const attempt: RecordAttempt = {
      sourceWorld: inputs.world,
      readLease: inputs.lease,
      sourceScope: inputs.source,
      opts: staged.opts,
      publication: staged.publication,
      frame: staged.result,
      mode: staged.mode,
      timingCapture:
        !viewComposition(world).active && input.rendererInternals === owner.internals
          ? input.timingCapture
          : undefined,
      profileSession: activeRenderProfileSession(owner.internals),
      submitted: false,
      sceneSubmitted: false,
      outcome: undefined,
    };
    if (input.rendererInternals?.framePassNames !== undefined)
      owner.internals.framePassNames = input.rendererInternals.framePassNames;
    state.attempt = attempt;
    beginGeometryObservation(owner, attempt);
    state.ownsProfileFrame = beginRecordAttempt(owner, attempt);
    owner.recording.dispatchCounts.unlit = 0;
    if (!attempt.frame.ok) {
      classifyExtraction(owner, state, attempt.frame.cause);
      return;
    }
    owner.recorded.motionBlurInvalidParams = undefined;
    const view = selectRecordView(owner);
    if (view === undefined) {
      state.preparation = { kind: 'rejected' };
      return;
    }
    const scene = prepareRecordScene(owner, attempt, attempt.frame.value, view);
    if (scene === undefined) {
      state.preparation = { kind: 'rejected' };
      return;
    }
    const facts = { frame: attempt.frame.value, view, scene };
    state.preparation = {
      kind: 'queued',
      facts,
      queue: stageRecordQueue(owner, attempt, facts.frame, view, scene),
    };
  } catch (cause) {
    prepareFailure(owner, state, cause);
  }
}
function classifyExtraction(
  owner: ViewSettlementOwner,
  state: ViewRecordAttemptState,
  cause: unknown,
): void {
  if (cause instanceof AssetError && cause.code === 'asset-not-ready') {
    state.preparation = { kind: 'pending' };
    return;
  }
  if (cause instanceof MotionBlurValidationError) {
    owner.recorded.motionBlurInvalidParams = cause;
    owner.recorded.camera = undefined;
    owner.internals.errorRegistry.fire(cause);
    state.preparation = { kind: 'rejected' };
    return;
  }
  throw cause;
}
function prepareGraph(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  state: ViewRecordAttemptState,
): void {
  const queued = state.preparation;
  const attempt = state.attempt;
  if (
    state.frame !== renderSubmission(world).frame ||
    queued?.kind !== 'queued' ||
    attempt === undefined
  )
    return;
  try {
    const { frame, view, scene } = queued.facts;
    if (!admitRecordFeatures(owner, attempt, frame, view)) {
      state.preparation = {
        kind: owner.frameState.pipelinePreparationPending ? 'pending' : 'rejected',
      };
      return;
    }
    if (
      recordContext(owner.internals).featureHost !== undefined &&
      !sharedFeatureGraphStaged(world)
    )
      stageSharedFeatureGraph(world, owner.internals, [attempt.sourceScope]);
    if (!queued.queue.records) {
      if (attempt.mode === 'capture') disposeTargetCaptureLighting(owner.captures);
      state.preparation = { kind: 'held' };
      return;
    }
    const dispatch = queued.queue.sorted ? viewPhaseQueue(world, entity).take() : frame.dispatch;
    const preparedInput = prepareViewFrameInput(
      owner,
      attempt,
      frame,
      view,
      scene,
      queued.queue.captures,
      {
        ...queued.queue,
        dispatch,
      },
    );
    const recording = createFrameRecordingAttempt(preparedInput.input.volumetricFog);
    state.recording = { input: preparedInput.input, attempt: recording };
    state.preparation = { kind: 'graph', facts: queued.facts, draws: preparedInput.draws };
    const prepared = prepareFrameGraphInputs(preparedInput.input, recording);
    if (prepared.kind === 'pending') {
      state.preparation = { kind: 'pending' };
      prepared.featurePlan?.candidate?.onRejected?.();
      return;
    }
    if (prepared.kind === 'rejected') {
      state.preparation = { kind: 'rejected' };
      return;
    }
    stagePreparedViewGraph(state, prepared);
  } catch (cause) {
    prepareFailure(owner, state, cause);
  }
}

function settleViewRecording(owner: ViewSettlementOwner, state: ViewRecordAttemptState): void {
  const attempt = state.attempt;
  if (attempt === undefined) return;
  const result = frameSubmitOutcome(renderWorldFor(owner.internals)).result;
  const ready = state.preparation;
  if (
    ready?.kind === 'graph' &&
    state.prepared !== undefined &&
    state.outcome?.kind === 'sealed' &&
    state.encoding?.kind === 'encoded'
  ) {
    attempt.submitted = settlePreparedViewGraph(
      state.prepared,
      state.outcome,
      state.encoding.value,
      result,
    );
    attempt.sceneSubmitted = attempt.submitted && owner.frameState.frameOutputs.sceneSubmitted;
  } else if (
    ready?.kind === 'pending' ||
    ready?.kind === 'held' ||
    state.encoding?.kind === 'pending'
  ) {
    attempt.submitted = result.ok;
    if (state.recording !== undefined) state.recording.attempt.submitted = result.ok;
  }
  if (ready?.kind === 'graph') {
    const { frame, view, scene } = ready.facts;
    attempt.outcome = {
      frame,
      lights: view.lights,
      camera: view.cameras[0],
      presentation: scene.presentation,
      captureAdmits: state.recording?.attempt.captureAdmits,
      draws: {
        presentedDraws: ready.draws.presentedDraws,
        drawObservation: ready.draws.drawObservation,
        gpuSelection: ready.draws.readGpuSelection(),
      },
    };
  }
  if (!attempt.submitted) owner.frameState.surfaceSubmissionObservation?.abort();
  owner.frameState.surfaceSubmissionObservation = undefined;
  if (!attempt.sceneSubmitted) discardStandardOutputStates(owner.frameState);
}

/** Publish every physical fact before Commit; rejected inputs never advance accepted history. */
function settleAttempt(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  state: ViewRecordAttemptState,
): void {
  const attempt = state.attempt;
  if (state.frame !== renderSubmission(world).frame || state.settled || attempt === undefined)
    return;
  state.settled = true;
  try {
    settleViewRecording(owner, state);
  } catch (cause) {
    prepareFailure(owner, state, cause);
  } finally {
    if (state.recording !== undefined) {
      const { input, attempt: recording } = state.recording;
      try {
        stageFrameRecordingResources(owner.internals, owner.frameState, recording);
        stageFrameCaptureCompletion(
          owner.internals,
          owner.frameState,
          recording,
          input.cubeCapture,
          state.encoding?.kind === 'encoded',
        );
      } catch (cause) {
        prepareFailure(owner, state, cause);
      }
    }
    const { frame, accepted } = renderSubmission(world);
    const viewAccepted = attempt.submitted && accepted;
    recordViewSubmission(world, entity, {
      accepted: viewAccepted,
      attempt: frame,
      scene: attempt.sceneSubmitted,
      temporal: false,
    });
    const sealed = state.outcome;
    const revision = sealed?.kind === 'sealed' ? sealed.configurationRevision : undefined;
    const display = sealed?.kind === 'sealed' ? sealed.display : undefined;
    if (
      viewAccepted &&
      attempt.sceneSubmitted &&
      display !== undefined &&
      owner.frameState.compiledFrameGraph === display
    )
      display.configurationRevision = revision;
    viewRecordHistory(world, entity)?.stage({
      configurationRevision: revision,
      frame,
      generation: recordContext(owner.internals).deviceScope.generation,
      attempt,
      accepted: viewAccepted,
      failure: state.preparation?.kind === 'failed' ? state.preparation.cause : undefined,
      ownsProfileFrame: state.ownsProfileFrame,
    });
  }
}

export function registerViewRecordSystems(world: World): void {
  // Each system captures the current ECS owners before releasing its query lock.
  // Mutating callbacks consume these columns synchronously, in the required view order.
  const order = new FrameViewList<number>();
  const entities: EntityHandle[] = [];
  const owners: ViewSettlementOwner[] = [];
  const attempts: ViewRecordAttemptState[] = [];
  const staged: ViewFrameState[] = [];
  type ViewRow = Pick<QueryRow, 'entity'>;
  type Rows = { forEach(visit: (row: ViewRow) => void): void };
  const collect = (entity: EntityHandle): void => {
    markDerivedComponentChanged(world, entity, ViewRecordAttempt).unwrap();
    entities.push(entity);
    owners.push(ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')));
    attempts.push(
      world
        .resolveUniqueRef<ViewRecordAttemptState>(
          requireViewField(world, entity, ViewRecordAttempt, 'state'),
        )
        .unwrap(),
    );
  };
  const collectGraph = ({ entity }: ViewRow): void => {
    order.add(entity, entities.length);
    collect(entity);
  };
  const collectStart = (row: ViewRow): void => {
    collectGraph(row);
    staged.push(
      world
        .resolveUniqueRef<ViewFrameState>(requireViewField(world, row.entity, ViewFrame, 'state'))
        .unwrap(),
    );
  };
  const clear = (): void => {
    order.clear();
    entities.length = owners.length = attempts.length = staged.length = 0;
  };
  const settleRows = (rows: Rows): void => {
    try {
      rows.forEach(({ entity }) => {
        collect(entity);
      });
      for (let i = 0; i < entities.length; i++)
        settleAttempt(
          world,
          entities[i] as EntityHandle,
          owners[i] as ViewSettlementOwner,
          attempts[i] as ViewRecordAttemptState,
        );
    } finally {
      clear();
    }
  };
  const systemToken1 = defineSystem({
    commands: 'none',
    name: RENDER_VIEW_RECORD_START_SYSTEM,
    before: [RenderPhaseSortOrder, RenderFeaturePlanOrder],
    queries: [{ read: [ViewRecorder, ViewFrame], write: [ViewRecordAttempt] }],
    fn: (world, [rows]) => {
      if (!world.hasResource(RenderRecordInput)) return;
      try {
        rows.forEach(collectStart);
        for (const i of order.inOrder(viewComposition(world).recorded))
          startAttempt(
            world,
            owners[i] as ViewSettlementOwner,
            staged[i] as ViewFrameState,
            attempts[i] as ViewRecordAttemptState,
          );
      } finally {
        clear();
      }
    },
  });
  world.addSystem(RenderQueue, systemToken1).unwrap();
  const systemToken2 = defineSystem({
    sets: [RenderViewGraphPrepareOrder],
    commands: 'none',
    name: RENDER_VIEW_GRAPH_PREPARE_SYSTEM,
    after: [
      RenderPhaseSortOrder,
      RenderFeaturePlanOrder,
      RenderGpuDrivenRasterOrder,
      RenderOpaquePlanOrder,
      RenderTransparentPlanOrder,
      RenderTransmissionPlanOrder,
    ],
    queries: [{ read: [ViewRecorder, ViewFrame], write: [ViewRecordAttempt] }],
    fn: (world, [rows]) => {
      if (!world.hasResource(RenderRecordInput)) return;
      try {
        rows.forEach(collectGraph);
        for (const i of order.inOrder(viewComposition(world).recorded))
          prepareGraph(
            world,
            entities[i] as EntityHandle,
            owners[i] as ViewSettlementOwner,
            attempts[i] as ViewRecordAttemptState,
          );
      } finally {
        clear();
      }
    },
  });
  world.addSystem(RenderQueue, systemToken2).unwrap();
  const systemToken3 = defineSystem({
    sets: [RenderViewRecordSettleOrder],
    commands: 'none',
    name: RENDER_VIEW_RECORD_SETTLE_SYSTEM,
    after: [RenderFrameSubmitOrder],
    queries: [
      {
        read: [ViewRecorder, ViewFrame],
        write: [ViewRecordAttempt, ViewSubmission],
        optional: [ViewRecordHistory],
      },
    ],
    fn: (_world, [rows]) => {
      settleRows(rows);
    },
  });
  world.addSystem(RenderRecord, systemToken3).unwrap();
  const systemToken4 = defineSystem({
    commands: 'none',
    name: 'render-view-record-abandon',
    before: [RenderCleanup],
    queries: [
      {
        read: [ViewRecorder, ViewFrame],
        write: [ViewRecordAttempt, ViewSubmission],
        optional: [ViewRecordHistory],
      },
    ],
    fn: (world, [rows]) => {
      if (frameSubmitOutcome(world).recordStarted) return;
      settleRows(rows);
    },
  });
  world.addSystem(RenderCleanup, systemToken4).unwrap();
  const systemToken5 = defineSystem({
    commands: 'none',
    name: RENDER_VIEW_RECORD_RELEASE_SYSTEM,
    after: [RenderRecordRetireOrder],
    queries: [{ read: [ViewRecorder], write: [ViewRecordAttempt] }],
    fn: (world, [rows]) => {
      rows.forEach((row) => {
        const entity = row.entity;

        markDerivedComponentChanged(world, entity, ViewRecordAttempt).unwrap();
        const state = world
          .resolveUniqueRef<ViewRecordAttemptState>(
            requireViewField(world, entity, ViewRecordAttempt, 'state'),
          )
          .unwrap();
        const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
        try {
          if (state.recording !== undefined)
            releaseFrameRecordingAttempt(
              owner.internals,
              owner.frameState,
              state.recording.attempt,
              state.recording.input.lights,
              state.recording.input.cubeCapture,
            );
        } catch (cause) {
          prepareFailure(owner, state, cause);
        } finally {
          state.attempt = undefined;
          state.preparation = undefined;
          state.recording = undefined;
        }
      });
    },
  });
  world.addSystem(RenderCleanup, systemToken5).unwrap();
}
