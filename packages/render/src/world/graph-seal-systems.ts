import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { ProjectedDecalInvalidError } from '../decals/component';
import { RendererOperationError } from '../errors/render';
import {
  encodePreparedFrameCaptures,
  encodePreparedViewGraph,
  type FrameCaptureEncodeOutcome,
  type PreparedFrameGraph,
  type QueuedFrameTemporalOutcome,
  sealCompiledViewGraph,
  type ViewFrameEncodeOutcome,
  type ViewGraphSealOutcome,
} from '../record/frame';
import { ensureShadowDepthLayers } from '../record/typed-frame-graph';
import {
  captureGraphOutcome,
  prepareCaptureGraphs,
  RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM,
  ViewCaptureGraphs,
} from './capture-graph-systems';
import { ViewCaptureWork, viewCaptureWorkOf } from './capture-systems';
import {
  deferSharedFeatureGraph,
  encodeSharedFeatureGraph,
  RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
  sharedFeatureGraphEncoded,
  sharedFeatureGraphEncodeError,
  sharedFeatureGraphOutcome,
  sharedFeatureSceneInputsPending,
} from './feature-graph-systems';
import {
  RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
  RENDER_GRAPH_COMPILE_SYSTEM,
  stageViewGraphCompile,
  takeViewGraphCompile,
  ViewGraphCandidate,
} from './graph-systems';
import { renderFrameEncoder } from './record-systems';
import { RenderCleanup, RenderRecord, renderSubmission, renderWorldFor } from './render-world';
import { subsurfaceCaptureClass } from './subsurface-admission-systems';
import { readViewField, requireViewField } from './view-field';
import { viewComposition } from './view-output-systems';
import { recordContext } from './view-record-context';

export const RENDER_GRAPH_SEAL_SYSTEM = 'render-graph-seal';
export const RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM = 'render-capture-graph-encode';
export const RENDER_FEATURE_GRAPH_ENCODE_SYSTEM = 'render-feature-graph-encode';
export const RENDER_VIEW_GRAPH_ENCODE_SYSTEM = 'render-view-graph-encode';
export const RENDER_GRAPH_SEAL_RELEASE_SYSTEM = 'render-graph-seal-release';

export interface ViewGraphSealState {
  frame: number;
  prepared: PreparedFrameGraph | undefined;
  outcome: ViewGraphSealOutcome | undefined;
  temporal?: QueuedFrameTemporalOutcome | undefined;
  captures?: FrameCaptureEncodeOutcome | undefined;
  encoding?: ViewFrameEncodeOutcome | undefined;
}

/** One view's actual graph preparation and sealed resource product; never an executable continuation. */
export const ViewGraphSeal = defineComponent('ViewGraphSeal', { state: 'unique<ViewGraphSeal>' });

function stateOf(world: World, entity: EntityHandle): ViewGraphSealState | undefined {
  if (!world.hasComponent(entity, ViewGraphSeal)) return undefined;
  const state = world
    .resolveUniqueRef<ViewGraphSealState>(requireViewField(world, entity, ViewGraphSeal, 'state'))
    .unwrap();
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

/** Wait only at the real Record boundary; the system owns all resource sealing work. */
/** Stage graph and capture facts before the Record compiler systems run. */
export function stagePreparedViewGraph(prepared: PreparedFrameGraph): void {
  const {
    internals,
    frameState,
    pipelineState,
    cubeCapture,
    cubeCaptureWork,
    graphShadowMapSize,
    terrainReceivers,
  } = prepared;
  prepareCaptureGraphs({
    internals,
    frameState,
    pipelineState,
    capture: cubeCapture,
    work: cubeCaptureWork,
    shadowMapSize: graphShadowMapSize,
    terrainReceivers,
  });
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined) throw new Error('A production recording requires its view entity');
  if (!prepared.captureOnly)
    stageViewGraphCompile(world, entity, {
      camera: prepared.camera,
      clearOnly: prepared.cameras.length === 0,
      subsurfaceClass: subsurfaceCaptureClass(cubeCapture, prepared.captureOnly),
      rendererRecording: prepared.rendererRecording,
      shadowDepthLayers: ensureShadowDepthLayers(frameState, internals.device),
    });
  let state = stateOf(world, entity);
  if (state === undefined) {
    state = { frame: renderSubmission(world).frame, prepared, outcome: undefined };
    if (world.hasComponent(entity, ViewGraphSeal)) {
      const retained = world
        .resolveUniqueRef<ViewGraphSealState>(
          requireViewField(world, entity, ViewGraphSeal, 'state'),
        )
        .unwrap();
      Object.assign(retained, state);
    } else
      world
        .addComponent(entity, {
          component: ViewGraphSeal,
          data: { state: world.allocUniqueRef('ViewGraphSeal', state) },
        })
        .unwrap();
  } else {
    state.prepared = prepared;
    state.outcome = undefined;
  }
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

export function registerGraphSealSystems(world: World): void {
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_GRAPH_SEAL_SYSTEM,
      after: [RENDER_GRAPH_COMPILE_SYSTEM, RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM],
      queries: [
        { write: [ViewGraphSeal, ViewGraphCandidate], optional: [ViewCaptureGraphs] },
        { write: [ViewGraphSeal], without: [ViewGraphCandidate], optional: [ViewCaptureGraphs] },
      ],
      fn: (world, groups) => {
        if (renderFrameEncoder(world).kind !== 'open') return;
        const frame = renderSubmission(world).frame;
        for (const rows of groups) {
          for (const row of rows) {
            const entity = row.entity;

            const state = world
              .resolveUniqueRef<ViewGraphSealState>(
                requireViewField(world, entity, ViewGraphSeal, 'state'),
              )
              .unwrap();
            if (
              state.frame !== frame ||
              state.prepared === undefined ||
              state.outcome !== undefined
            )
              continue;
            try {
              state.outcome = sealCompiledViewGraph(
                state.prepared,
                takeViewGraphCompile(world, entity),
                captureGraphOutcome(state.prepared.internals),
                state.temporal,
              );
            } catch (cause) {
              state.outcome = graphSealFailure(cause);
            }
          }
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM,
      after: [RENDER_GRAPH_SEAL_SYSTEM],
      queries: [{ write: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        if (renderFrameEncoder(world).kind !== 'open') return;
        const frame = renderSubmission(world).frame;
        const states: ViewGraphSealState[] = [];

        rows.forEach((row) => {
          const entity = row.entity;
          states.push(
            world
              .resolveUniqueRef<ViewGraphSealState>(
                requireViewField(world, entity, ViewGraphSeal, 'state'),
              )
              .unwrap(),
          );
        });
        const order = viewComposition(world).recorded;
        const rank = (state: ViewGraphSealState) => {
          const index = order.findIndex(
            (view) => view.entity === state.prepared?.internals.viewEntity,
          );
          return index < 0 ? order.length : index;
        };
        states.sort((a, b) => rank(a) - rank(b));
        for (const state of states) {
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
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_FEATURE_GRAPH_ENCODE_SYSTEM,
      after: [RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM, RENDER_FEATURE_GRAPH_COMPILE_SYSTEM],
      queries: [{ read: [ViewCaptureWork], optional: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        const encoder = renderFrameEncoder(world);
        if (encoder.kind !== 'open' || sharedFeatureGraphOutcome(world) === undefined) return;
        const frame = renderSubmission(world).frame;

        for (const row of rows) {
          const entity = row.entity;

          const route = viewCaptureWorkOf(world, entity);
          if (route?.kind !== 'prepared' || route.value.sceneInputs.length === 0) continue;
          const seal = readViewField(world, entity, ViewGraphSeal, 'state');
          const state =
            seal === undefined
              ? undefined
              : world.resolveUniqueRef<ViewGraphSealState>(seal).unwrap();
          if (state?.frame !== frame || state.captures?.kind !== 'ready') {
            // A routed input can stop before graph seal (assets or PSOs pending).
            // Its absent encode product must never acknowledge unwritten shared inputs.
            deferSharedFeatureGraph(world);
            return;
          }
        }
        // Encoding failures stay in the shared graph product; they never poison this World.
        encodeSharedFeatureGraph(world, encoder.encoder);
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_VIEW_GRAPH_ENCODE_SYSTEM,
      after: [RENDER_FEATURE_GRAPH_ENCODE_SYSTEM],
      queries: [{ write: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const states: ViewGraphSealState[] = [];

        rows.forEach((row) => {
          const entity = row.entity;
          states.push(
            world
              .resolveUniqueRef<ViewGraphSealState>(
                requireViewField(world, entity, ViewGraphSeal, 'state'),
              )
              .unwrap(),
          );
        });
        const order = viewComposition(world).recorded;
        const rank = (state: ViewGraphSealState) => {
          const index = order.findIndex(
            (view) => view.entity === state.prepared?.internals.viewEntity,
          );
          return index < 0 ? order.length : index;
        };
        states.sort((a, b) => rank(a) - rank(b));
        for (const state of states) {
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
                : sharedFeatureSceneInputsPending(world)
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
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_GRAPH_SEAL_RELEASE_SYSTEM,
      before: [RENDER_GRAPH_COMPILE_RELEASE_SYSTEM],
      queries: [{ write: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewGraphSealState>(
              requireViewField(world, entity, ViewGraphSeal, 'state'),
            )
            .unwrap();
          state.temporal = undefined;
          state.captures = undefined;
          state.encoding = undefined;
          state.prepared = undefined;
          state.outcome = undefined;
        });
      },
    })
    .unwrap();
}
