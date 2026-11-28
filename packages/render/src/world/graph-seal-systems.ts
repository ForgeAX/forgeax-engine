import { defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { ProjectedDecalInvalidError } from '../decals/component';
import { RendererOperationError } from '../errors/render';
import {
  compilePreparedViewGraph,
  encodePreparedFrameCaptures,
  encodePreparedViewGraph,
  type PreparedFrameGraph,
  prepareOrderedDisplayRecording,
  sealCompiledViewGraph,
  type ViewFrameEncodeOutcome,
  type ViewGraphSealOutcome,
} from '../record/frame';
import { EMPTY_CAPTURE_GRAPH_OUTCOME } from '../record/frame-capture';
import { markPipelinePreparationPending } from '../render-system-presentation';
import {
  RenderCaptureGraphCompileOrder,
  RenderCaptureGraphEncodeOrder,
  RenderEncoderOpenOrder,
  RenderFeatureGraphCompileOrder,
  RenderFeatureGraphEncodeOrder,
  RenderGraphSealOrder,
  RenderGraphSealReleaseOrder,
  RenderViewGraphEncodeOrder,
} from '../system-order';
import {
  captureGraphOutcome,
  stageCaptureGraphCompile,
  ViewCaptureGraphs,
} from './capture-graph-systems';
import { ViewCaptureWork, viewCaptureWorkOf } from './capture-systems';
import {
  deferSharedFeatureGraph,
  encodeSharedFeatureGraph,
  sharedFeatureGraphEncoded,
  sharedFeatureGraphEncodeError,
  sharedFeatureGraphOutcome,
  sharedFeaturePreparationPending,
  sharedFeatureSceneInputsPending,
} from './feature-graph-systems';
import { FrameViewList } from './frame-view-list';
import { renderFrameEncoder } from './record-systems';
import { RenderCleanup, RenderRecord, renderSubmission } from './render-world';
import { readViewState } from './view-field';
import { viewComposition } from './view-output-systems';
import { ViewRecordAttempt, type ViewRecordAttemptState } from './view-record-attempt';
import { recordContext } from './view-record-context';

export const RENDER_GRAPH_SEAL_SYSTEM = 'render-graph-seal';
export const RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM = 'render-capture-graph-encode';
export const RENDER_FEATURE_GRAPH_ENCODE_SYSTEM = 'render-feature-graph-encode';
export const RENDER_VIEW_GRAPH_ENCODE_SYSTEM = 'render-view-graph-encode';
export const RENDER_GRAPH_SEAL_RELEASE_SYSTEM = 'render-graph-seal-release';

function stateOf(world: World, entity: EntityHandle): ViewRecordAttemptState | undefined {
  const state = readViewState<ViewRecordAttemptState>(world, entity, ViewRecordAttempt);
  if (state === undefined) return undefined;
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

export function graphSealFailure(
  cause: unknown,
): Extract<ViewGraphSealOutcome, { kind: 'failed' }> {
  if (cause instanceof ProjectedDecalInvalidError) return { kind: 'failed', error: cause };
  return {
    kind: 'failed',
    error: new RendererOperationError('graph-build-failed', {
      operation: 'draw',
      cause: {
        code: 'graph-seal-unavailable',
        expected: 'render-graph-seal adopts and seals the current compiled view graph',
        hint: 'keep the RenderRecord graph seal system registered and retry after preparation',
        detail: cause,
      },
    }),
  };
}

/** Current sealed product; missing execution is structured data and never falls back to manual seal. */
export function viewGraphSealOutcome(world: World, entity: EntityHandle): ViewGraphSealOutcome {
  return stateOf(world, entity)?.outcome ?? graphSealFailure('No current graph seal product');
}

/** Stage graph and capture facts before the Record compiler systems run. */
export function stagePreparedViewGraph(
  state: ViewRecordAttemptState,
  prepared: PreparedFrameGraph,
): void {
  const { captureGraph } = prepared;
  if (captureGraph !== undefined && !stageCaptureGraphCompile(captureGraph))
    throw new Error('A production view must stage capture work before RenderRecord');
  state.prepared = prepared;
  state.outcome = undefined;
  state.awaitingPlan = prepared.featurePlan.candidate !== undefined;
  state.temporal = undefined;
  state.captures = undefined;
  state.encoding = undefined;
}

/** Current encoding outcome; removing an owner system never invokes manual fallback work. */
export function viewGraphEncodingOutcome(
  world: World,
  entity: EntityHandle,
): ViewFrameEncodeOutcome {
  return (
    stateOf(world, entity)?.encoding ?? {
      kind: 'failed',
      cause: graphSealFailure('No current graph encode product').error,
    }
  );
}

/** Every display waits for pending capture work before any surface is acquired. */
function deferPendingViews(states: readonly ViewRecordAttemptState[], frame: number): void {
  const pending = states.find(
    (state) => state.frame === frame && state.prepared?.frameState.pipelinePreparationPending,
  );
  if (pending?.prepared === undefined) return;
  const reason = pending.prepared.frameState.pipelinePreparationPendingReason ?? {
    code: 'scene-pipeline-preparation' as const,
  };
  for (const state of states) {
    if (state.frame !== frame || state.prepared === undefined) continue;
    markPipelinePreparationPending(state.prepared.frameState, reason);
    if (state.captures?.kind === 'ready') state.captures = { kind: 'pending' };
  }
}

function prepareRecordingGraph(
  prepared: PreparedFrameGraph,
  state: ViewRecordAttemptState,
): ViewGraphSealOutcome {
  const captures =
    prepared.captureGraph === undefined ? undefined : captureGraphOutcome(prepared.internals);
  if (captures?.ok === false || prepared.captureOnly)
    return sealCompiledViewGraph(
      prepared,
      undefined,
      captures ?? EMPTY_CAPTURE_GRAPH_OUTCOME,
      state.temporal,
    );

  const compiled = compilePreparedViewGraph(prepared);
  // A successful compile outcome carries the Feature candidate into adoption.
  // Early failures leave the consumed plan with this recording's cleanup.
  if (compiled.kind !== 'failed') state.awaitingPlan = false;
  if (compiled.kind === 'ordered-display')
    return prepareOrderedDisplayRecording(prepared, compiled, state.temporal, captures?.value);
  return sealCompiledViewGraph(
    prepared,
    compiled,
    captures ?? EMPTY_CAPTURE_GRAPH_OUTCOME,
    state.temporal,
  );
}

export function registerGraphSealSystems(world: World): void {
  // Capture and display encode the same submission in presentation order.
  const work = new FrameViewList<ViewRecordAttemptState>();
  let ordered: readonly ViewRecordAttemptState[] = [];
  let orderedFrame: number | undefined;
  const releaseOrder = () => {
    orderedFrame = undefined;
    work.clear();
  };
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderGraphSealOrder],
        commands: 'none',
        name: RENDER_GRAPH_SEAL_SYSTEM,
        after: [
          RenderEncoderOpenOrder,
          RenderCaptureGraphCompileOrder,
          RenderFeatureGraphCompileOrder,
        ],
        queries: [{ write: [ViewRecordAttempt], optional: [ViewCaptureGraphs] }],
        fn: (world, [rows]) => {
          releaseOrder();
          if (renderFrameEncoder(world).kind !== 'open') return;
          const frame = renderSubmission(world).frame;
          rows.forEach(({ entity }) => {
            const state = readViewState<ViewRecordAttemptState>(world, entity, ViewRecordAttempt);
            if (state?.frame !== frame || state.prepared === undefined) return;
            work.add(entity, state);
            if (state.outcome !== undefined) return;
            try {
              state.outcome = prepareRecordingGraph(state.prepared, state);
              if (state.outcome.kind === 'pending') state.encoding = state.outcome;
            } catch (cause) {
              state.outcome = graphSealFailure(cause);
            }
          });
          ordered = work.inOrder(viewComposition(world).recorded);
          orderedFrame = frame;
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderCaptureGraphEncodeOrder],
        commands: 'none',
        name: RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM,
        after: [RenderGraphSealOrder],
        queries: [],
        fn: (world) => {
          const frame = renderSubmission(world).frame;
          if (orderedFrame !== frame || renderFrameEncoder(world).kind !== 'open') return;
          // One physical frame cannot publish a mixture of prepared and pending
          // views. Keep every view at its preparation barrier before any capture
          // or scene work is encoded into the shared command encoder.
          deferPendingViews(ordered, frame);
          for (const state of ordered) {
            if (
              state.frame !== frame ||
              state.prepared === undefined ||
              state.outcome?.kind !== 'sealed'
            )
              continue;
            try {
              state.captures = encodePreparedFrameCaptures(state.prepared, state.outcome.value);
            } catch (cause) {
              state.encoding = { kind: 'failed', cause };
            }
          }
          deferPendingViews(ordered, frame);
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderFeatureGraphEncodeOrder],
        commands: 'none',
        name: RENDER_FEATURE_GRAPH_ENCODE_SYSTEM,
        after: [RenderCaptureGraphEncodeOrder, RenderFeatureGraphCompileOrder],
        queries: [{ read: [ViewCaptureWork], optional: [ViewRecordAttempt] }],
        fn: (world, [rows]) => {
          const encoder = renderFrameEncoder(world);
          if (encoder.kind !== 'open' || sharedFeatureGraphOutcome(world) === undefined) return;

          for (const row of rows) {
            const entity = row.entity;

            const route = viewCaptureWorkOf(world, entity);
            if (route?.kind !== 'prepared' || route.value.sceneInputs.length === 0) continue;
            const state = stateOf(world, entity);
            if (state?.captures?.kind !== 'ready') {
              // A routed input can stop before graph seal (assets or PSOs pending).
              // Its absent encode product must never acknowledge unwritten shared inputs.
              deferSharedFeatureGraph(world);
              return;
            }
          }
          // Encoding failures stay in the shared graph product; they never poison this World.
          encodeSharedFeatureGraph(world, encoder.encoder);
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderViewGraphEncodeOrder],
        commands: 'none',
        name: RENDER_VIEW_GRAPH_ENCODE_SYSTEM,
        after: [RenderFeatureGraphEncodeOrder],
        queries: [],
        fn: (world) => {
          const frame = renderSubmission(world).frame;
          if (orderedFrame !== frame) return;
          try {
            for (const state of ordered) {
              if (
                state.frame !== frame ||
                state.prepared === undefined ||
                state.outcome?.kind !== 'sealed' ||
                state.encoding !== undefined
              )
                continue;
              if (state.captures?.kind !== 'ready') {
                state.encoding = state.captures ?? {
                  kind: 'failed',
                  cause: graphSealFailure('No capture encode product').error,
                };
                continue;
              }
              if (
                recordContext(state.prepared.internals).featureHost !== undefined &&
                !sharedFeatureGraphEncoded(world)
              ) {
                const compiled = sharedFeatureGraphOutcome(world);
                const cause =
                  sharedFeatureGraphEncodeError(world) ??
                  (compiled?.ok === false ? compiled.error : undefined);
                state.encoding =
                  cause !== undefined
                    ? { kind: 'failed', cause }
                    : sharedFeatureSceneInputsPending(world) ||
                        sharedFeaturePreparationPending(world)
                      ? { kind: 'pending' }
                      : {
                          kind: 'failed',
                          cause: graphSealFailure('No shared Feature graph encode product').error,
                        };
                continue;
              }
              try {
                state.encoding = encodePreparedViewGraph(state.prepared, state.outcome);
              } catch (cause) {
                state.encoding = { kind: 'failed', cause };
              }
            }
          } finally {
            releaseOrder();
          }
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCleanup,
      defineSystem({
        sets: [RenderGraphSealReleaseOrder],
        commands: 'none',
        name: RENDER_GRAPH_SEAL_RELEASE_SYSTEM,
        queries: [{ write: [ViewRecordAttempt] }],
        fn: (world, [rows]) => {
          releaseOrder();
          rows.forEach((row) => {
            const state = readViewState<ViewRecordAttemptState>(
              world,
              row.entity,
              ViewRecordAttempt,
            );
            if (state === undefined) return;
            const plan = state.awaitingPlan ? state.prepared?.featurePlan?.candidate : undefined;
            state.awaitingPlan = false;
            state.temporal = undefined;
            state.captures = undefined;
            state.encoding = undefined;
            state.prepared = undefined;
            state.outcome = undefined;
            plan?.onAbandoned?.();
          });
        },
      }),
    )
    .unwrap();
}
