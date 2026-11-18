import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { AssetError } from '@forgeax/engine-types';
import { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import { discardStandardOutputStates } from '../pipeline/standard-output/resources';
import {
  createFrameRecordingAttempt,
  type FrameRecordingAttempt,
  type FrameRecordingInput,
  prepareFrameGraphInputs,
  releaseFrameRecordingAttempt,
  settlePreparedViewGraph,
  stageFrameCaptureCompletion,
  stageFrameRecordingResources,
} from '../record/frame';
import { activeRenderProfileSession } from '../record/profile-session';
import { disposeTargetCaptureLighting } from '../record/target-capture-lighting';
import type { ExtractedFrame } from '../render-system-extract';
import {
  beginGeometryObservation,
  beginRecordAttempt,
  prepareRecordFeatures,
  prepareRecordScene,
  prepareViewFrameInput,
  type RecordScene,
  type RecordView,
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

import {
  stagePreparedViewGraph,
  ViewGraphSeal,
  type ViewGraphSealState,
} from './graph-seal-systems';

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
import { EMPTY_VIEW_STATE_UPDATE, readViewField, requireViewField } from './view-field';
import { ViewFrame, type ViewFrameState, viewFrameScopes } from './view-frame-systems';
import { viewComposition } from './view-output-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

type ViewFacts = {
  readonly frame: ExtractedFrame;
  readonly view: RecordView;
  readonly scene: RecordScene;
};
type ViewPreparation =
  | {
      readonly kind: 'queued';
      readonly facts: ViewFacts;
      readonly queue: ReturnType<typeof stageRecordQueue>;
    }
  | {
      readonly kind: 'graph';
      readonly facts: ViewFacts;
      readonly draws: ReturnType<typeof prepareViewFrameInput>['draws'];
    }
  | { readonly kind: 'pending' | 'held' | 'rejected' }
  | { readonly kind: 'failed'; readonly cause: unknown; readonly reported: boolean };

/** One attempt per view and frame. All continuation facts are data; no view generator. */
export interface ViewRecordAttemptState {
  frame: number;
  generation: number;
  attempt: RecordAttempt | undefined;
  ownsProfileFrame: boolean;
  preparation: ViewPreparation | undefined;
  recording:
    | { readonly input: FrameRecordingInput; readonly attempt: FrameRecordingAttempt }
    | undefined;
  settled: boolean;
}
export const ViewRecordAttempt = defineComponent('ViewRecordAttempt', {
  state: 'unique<ViewRecordAttempt>',
});
export const RENDER_VIEW_RECORD_START_SYSTEM = 'render-view-record-start';
export const RENDER_VIEW_GRAPH_PREPARE_SYSTEM = 'render-view-graph-prepare';
export const RENDER_VIEW_RECORD_SETTLE_SYSTEM = 'render-view-record-settle';
export const RENDER_VIEW_RECORD_RELEASE_SYSTEM = 'render-view-record-release';

export function adoptViewRecordAttempt(world: World, entity: EntityHandle): void {
  if (!world.hasComponent(entity, ViewSubmission))
    world
      .addComponent(entity, {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      })
      .unwrap();
  if (world.hasComponent(entity, ViewRecordAttempt)) return;
  const state: ViewRecordAttemptState = {
    frame: -1,
    generation: 0,
    attempt: undefined,
    ownsProfileFrame: false,
    preparation: undefined,
    recording: undefined,
    settled: false,
  };
  world
    .addComponent(entity, {
      component: ViewRecordAttempt,
      data: { state: world.allocUniqueRef('ViewRecordAttempt', state) },
    })
    .unwrap();
}

type Entry = {
  readonly entity: EntityHandle;
  readonly owner: ViewSettlementOwner;
  readonly staged: ViewFrameState;
  readonly state: ViewRecordAttemptState;
};
function orderEntries(world: World, entries: Entry[]): Entry[] {
  const order = viewComposition(world).recorded;
  const rank = (entry: Entry) => {
    const index = order.findIndex((v) => v.entity === entry.entity);
    return index < 0 ? order.length : index;
  };
  return entries.sort((a, b) => rank(a) - rank(b));
}
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
function startAttempt(world: World, entry: Entry): void {
  const { owner, staged, state } = entry;
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
function prepareGraph(world: World, entry: Entry): void {
  const { owner, state } = entry;
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
    const features = prepareRecordFeatures(owner, attempt, frame, view);
    if (features === undefined) {
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
    const dispatch = queued.queue.sorted
      ? viewPhaseQueue(world, entry.entity).take()
      : scene.visibility.projection.dispatch;
    const preparedInput = prepareViewFrameInput(owner, attempt, frame, view, scene, features, {
      ...queued.queue,
      dispatch,
    });
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
    stagePreparedViewGraph(prepared);
  } catch (cause) {
    prepareFailure(owner, state, cause);
  }
}

function settleViewRecording(
  owner: ViewSettlementOwner,
  state: ViewRecordAttemptState,
  seal: ViewGraphSealState | undefined,
): void {
  const attempt = state.attempt;
  if (attempt === undefined) return;
  const result = frameSubmitOutcome(renderWorldFor(owner.internals)).result;
  const ready = state.preparation;
  if (
    ready?.kind === 'graph' &&
    seal?.prepared !== undefined &&
    seal.outcome?.kind === 'sealed' &&
    seal.encoding?.kind === 'encoded'
  ) {
    attempt.submitted = settlePreparedViewGraph(
      seal.prepared,
      seal.outcome,
      seal.encoding.value,
      result,
    );
    attempt.sceneSubmitted = attempt.submitted && owner.frameState.frameOutputs.sceneSubmitted;
  } else if (
    ready?.kind === 'pending' ||
    ready?.kind === 'held' ||
    seal?.encoding?.kind === 'pending'
  ) {
    attempt.submitted = result.ok;
    if (state.recording !== undefined) state.recording.attempt.submitted = result.ok;
  }
  if (ready?.kind === 'graph') {
    const { frame, view, scene } = ready.facts;
    attempt.outcome = {
      frame,
      lights: view.lights,
      cameraCount: view.cameras.length,
      presentation: scene.presentation,
      presentationRenderables: scene.visibility.presentationRenderables,
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
function settleAttempt(world: World, entry: Entry, seal: ViewGraphSealState | undefined): void {
  const { owner, state, entity } = entry;
  const attempt = state.attempt;
  if (state.frame !== renderSubmission(world).frame || state.settled || attempt === undefined)
    return;
  state.settled = true;
  try {
    settleViewRecording(owner, state, seal);
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
          seal?.encoding?.kind === 'encoded',
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
    viewRecordHistory(world, entity)?.stage({
      configurationRevision: owner.frameState.compiledFrameGraph?.configurationRevision,
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
  const systemToken1 = defineSystem({
    commands: 'none',
    name: RENDER_VIEW_RECORD_START_SYSTEM,
    before: [RenderPhaseSortOrder, RenderFeaturePlanOrder],
    queries: [{ read: [ViewRecorder, ViewFrame], write: [ViewRecordAttempt] }],
    fn: (world, [rows]) => {
      if (!world.hasResource(RenderRecordInput)) return;
      const entries: Entry[] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        setDerivedComponent(world, entity, ViewRecordAttempt, EMPTY_VIEW_STATE_UPDATE).unwrap();
        entries.push({
          entity: entity,
          owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          staged: world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap(),
          state: world
            .resolveUniqueRef<ViewRecordAttemptState>(
              requireViewField(world, entity, ViewRecordAttempt, 'state'),
            )
            .unwrap(),
        });
      });
      // Staging Queue components happens after every query cursor has released its lock.
      for (const entry of orderEntries(world, entries)) startAttempt(world, entry);
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
      const entries: Entry[] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        setDerivedComponent(world, entity, ViewRecordAttempt, EMPTY_VIEW_STATE_UPDATE).unwrap();
        entries.push({
          entity: entity,
          owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          staged: world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap(),
          state: world
            .resolveUniqueRef<ViewRecordAttemptState>(
              requireViewField(world, entity, ViewRecordAttempt, 'state'),
            )
            .unwrap(),
        });
      });
      for (const entry of orderEntries(world, entries)) prepareGraph(world, entry);
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
        optional: [ViewGraphSeal, ViewRecordHistory],
      },
    ],
    fn: (world, [rows]) => {
      const entries: { entry: Entry; seal: ViewGraphSealState | undefined }[] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        setDerivedComponent(world, entity, ViewRecordAttempt, EMPTY_VIEW_STATE_UPDATE).unwrap();
        const entry: Entry = {
          entity: entity,
          owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          staged: world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap(),
          state: world
            .resolveUniqueRef<ViewRecordAttemptState>(
              requireViewField(world, entity, ViewRecordAttempt, 'state'),
            )
            .unwrap(),
        };
        const seal = readViewField(world, entity, ViewGraphSeal, 'state');
        entries.push({
          entry,
          seal:
            seal === undefined
              ? undefined
              : world.resolveUniqueRef<ViewGraphSealState>(seal).unwrap(),
        });
      });
      for (const { entry, seal } of entries) settleAttempt(world, entry, seal);
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
        optional: [ViewGraphSeal, ViewRecordHistory],
      },
    ],
    fn: (world, [rows]) => {
      if (frameSubmitOutcome(world).recordStarted) return;
      const entries: { entry: Entry; seal: ViewGraphSealState | undefined }[] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        setDerivedComponent(world, entity, ViewRecordAttempt, EMPTY_VIEW_STATE_UPDATE).unwrap();
        const entry: Entry = {
          entity: entity,
          owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          staged: world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap(),
          state: world
            .resolveUniqueRef<ViewRecordAttemptState>(
              requireViewField(world, entity, ViewRecordAttempt, 'state'),
            )
            .unwrap(),
        };
        const seal = readViewField(world, entity, ViewGraphSeal, 'state');
        entries.push({
          entry,
          seal:
            seal === undefined
              ? undefined
              : world.resolveUniqueRef<ViewGraphSealState>(seal).unwrap(),
        });
      });
      for (const { entry, seal } of entries) settleAttempt(world, entry, seal);
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

        setDerivedComponent(world, entity, ViewRecordAttempt, EMPTY_VIEW_STATE_UPDATE).unwrap();
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
