import { defineResource, defineSystem, type World } from '@forgeax/engine-ecs';
import {
  type CompiledRenderGraph,
  type CompiledRenderGraphInfo,
  compiledRenderGraphGeneration,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import {
  compileSharedFeatureGraph,
  sharedFeatureHoistedPlans,
} from '../assembly/feature-frame-graph';
import { RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureGraphReceipt } from '../features/graph-receipt';
import {
  encodeSharedFrameCommands,
  type SharedFeatureCommandFrame,
  sharedFrameNativeExecutions,
} from '../features/shared-frame-native-commands';
import { publishSharedGraphTextures } from '../features/shared-graph-textures';
import type { SharedFeatureGraphInspection } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  createRenderGraphPassInstrumentation,
  renderGraphPassInstrumentationActive,
} from '../record/frame-targets';
import { createPassTimingInstrumentation } from '../record/gpu-pass-timing/instrumentation';
import type { RenderSystemInternals } from '../record/render-context';
import {
  RenderEncoderOpenOrder,
  RenderFeatureGraphCompileOrder,
  RenderFeatureGraphRetireOrder,
  RenderGraphCompileOrder,
  RenderSubmissionRetireOrder,
} from '../system-order';
import type { WaterFluidGraphFrame } from '../water/fluid-graph';
import { featureFrameOutcome, stageRecordedFeatureGraph } from './feature-systems';

import { renderFrameEncoder } from './record-systems';

import { RenderCleanup, RenderRecord, renderSubmission } from './render-world';
import { retireAfterSubmission } from './submission-systems';
import { recordContext } from './view-record-context';

export const RENDER_FEATURE_GRAPH_COMPILE_SYSTEM = 'render-feature-graph-compile';
export const RENDER_FEATURE_GRAPH_RETIRE_SYSTEM = 'render-feature-graph-retire';

type Graph = CompiledRenderGraph<SharedFeatureCommandFrame & WaterFluidGraphFrame>;

export type SharedGraphOutcome =
  | { readonly ok: true; readonly receipt: RenderFeatureGraphReceipt<Graph> }
  | { readonly ok: false; readonly error: RenderFeatureStageFailedError };

/** One frame owns its receipt; only fallback graphs share its retirement lifetime. */
interface SharedFeatureGraphState {
  readonly frame: number;
  readonly internals: RenderSystemInternals;
  readonly resources: readonly RenderResourceScope[];
  readonly generation: number;
  readonly queue: RenderSystemInternals['device']['queue'];
  outcome: SharedGraphOutcome | undefined;
  readonly scope: RenderSystemInternals['deviceScope'] | undefined;
  encoding:
    | {
        readonly kind:
          | 'waiting'
          | 'preparation-pending'
          | 'scene-input-pending'
          | 'encoding'
          | 'encoded';
      }
    | { readonly kind: 'failed'; readonly error: RenderFeatureStageFailedError };
}

const SharedFeatureGraph = defineResource<SharedFeatureGraphState>('SharedFeatureGraph');
const SharedFeatureGraphOwner = defineResource<SharedOwner>('SharedFeatureGraphOwner');

interface SharedOwner {
  current:
    | {
        graph: Graph;
        generation: number;
        queue: RenderSystemInternals['device']['queue'];
        owner: object | undefined;
        frame: number;
      }
    | undefined;
  nativeFrames: number;
  fallbackFrames: number;
  emptyFrames: number;
  encodeFailures: number;
  last: SharedFeatureGraphInspection['last'];
}

function sharedOwner(world: World): SharedOwner {
  if (!world.hasResource(SharedFeatureGraphOwner))
    world.insertResource<SharedOwner>(SharedFeatureGraphOwner, {
      current: undefined,
      nativeFrames: 0,
      fallbackFrames: 0,
      emptyFrames: 0,
      encodeFailures: 0,
      last: { frame: 0, generation: 0, route: 'none', receipt: undefined, encoded: false },
    });
  return world.getResource(SharedFeatureGraphOwner);
}

/** Detached inspection; reading it never creates an owner or changes admission. */
export function inspectSharedFeatureGraphs(world: World): SharedFeatureGraphInspection | undefined {
  if (!world.hasResource(SharedFeatureGraphOwner)) return undefined;
  const { current: _current, ...counters } =
    world.getResource<SharedOwner>(SharedFeatureGraphOwner);
  return Object.freeze({
    ...counters,
    shellBuilds: 0,
    shellReuses: 0,
    last: Object.freeze({ ...counters.last }),
  });
}

function retireHistory(world: World, owner: SharedOwner): void {
  const current = owner.current;
  if (current === undefined) return;
  owner.current = undefined;
  if (current.owner !== undefined) publishSharedGraphTextures(current.owner, undefined);
  retireAfterSubmission(world, {
    generation: current.generation,
    queue: current.queue,
    release: () => {
      void current.graph.retire();
    },
  });
}

export function releaseSharedFeatureGraphHistory(world: World): void {
  if (world.hasResource(SharedFeatureGraphOwner)) retireHistory(world, sharedOwner(world));
}

export function sharedFeatureGraphInspection(world: World):
  | {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly graph: CompiledRenderGraphInfo;
    }
  | undefined {
  if (!world.hasResource(SharedFeatureGraphOwner)) return undefined;
  const current = sharedOwner(world).current;
  return current === undefined
    ? undefined
    : {
        frameId: current.frame,
        deviceGeneration: current.generation,
        graph: current.graph.inspect(),
      };
}

function sharedGraphOf(world: World): SharedFeatureGraphState | undefined {
  if (!world.hasResource(SharedFeatureGraph)) return undefined;
  const state = world.getResource(SharedFeatureGraph);
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

function stageFailure(cause: unknown): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError('renderer:shared', -1, 'record', 'next-frame', cause);
}

/** The submission selects its shared view before RenderRecord; no callback or batch mirror. */
export function stageSharedFeatureGraph(
  world: World,
  internals: RenderSystemInternals,
  resources: readonly RenderResourceScope[],
): void {
  if (internals.featureHost !== undefined)
    publishSharedGraphTextures(internals.featureHost, undefined);
  world.insertResource<SharedFeatureGraphState>(SharedFeatureGraph, {
    frame: renderSubmission(world).frame,
    internals,
    resources,
    generation: recordContext(internals).deviceScope?.generation ?? 0,
    queue: internals.device.queue,
    outcome: undefined,
    scope: recordContext(internals).deviceScope,
    encoding: { kind: 'waiting' },
  });
}

function compileSharedGraph(
  world: World,
  state: SharedFeatureGraphState,
): SharedGraphOutcome | undefined {
  const sealed = featureFrameOutcome(world);
  if (sealed?.kind !== 'sealed')
    return { ok: false, error: stageFailure('Feature frame is not sealed') };
  if (sealed.batch.frame.preparationPending) {
    state.encoding = { kind: 'preparation-pending' };
    return undefined;
  }
  try {
    const owner = sharedOwner(world);
    const receipt = prepareSharedWork(state, sealed.batch.frame, owner, sealed.batch.views);
    owner.last = {
      frame: state.frame,
      generation: state.generation,
      route:
        receipt.kind === 'commands'
          ? 'native-commands'
          : receipt.kind === 'compiled'
            ? 'compiled-graph'
            : 'empty',
      receipt: receipt.kind,
      encoded: false,
    };
    return {
      ok: true,
      receipt,
    };
  } catch (cause) {
    sharedOwner(world).last = {
      frame: state.frame,
      generation: state.generation,
      route: 'failed',
      receipt: undefined,
      encoded: false,
    };
    return { ok: false, error: stageFailure(cause) };
  }
}

function prepareSharedWork(
  state: SharedFeatureGraphState,
  result: import('../features/host').RenderFeatureFrameResult,
  owner: SharedOwner,
  views: import('../features/host').RenderFeatureFrameBatch['views'],
): RenderFeatureGraphReceipt<Graph> {
  const identity = {
    frame: state.frame,
    generation: state.generation,
    view: undefined,
    plans: result.plans,
  };
  const { internals } = state;
  const sharedInputs = internals.featureSceneInputs?.hasSharedWork === true;
  const hoistedWork = sharedFeatureHoistedPlans(views).some((plan) => plan.passes.length !== 0);
  const executions =
    sharedInputs || hoistedWork
      ? undefined
      : sharedFrameNativeExecutions(result, internals.device.caps);
  if (executions?.every((execution) => execution.passes.length === 0)) {
    owner.emptyFrames++;
    return { kind: 'empty', ...identity };
  }
  if (executions !== undefined && state.scope?.isAlive?.() === true) {
    owner.nativeFrames++;
    return { kind: 'commands', executions, ...identity };
  }
  owner.fallbackFrames++;
  const graph = compileSharedFeatureGraph(
    internals,
    result,
    state.resources,
    views,
    owner.current?.generation === state.generation ? owner.current.graph : undefined,
  );
  return graph === undefined
    ? { kind: 'empty', ...identity }
    : { kind: 'compiled', graph, ...identity };
}

/** Current frame already selected its shared producer. */
export function sharedFeatureGraphStaged(world: World): boolean {
  return sharedGraphOf(world) !== undefined;
}

/** Current compile outcome for inspection and same-path verification. */
export function sharedFeatureGraphOutcome(world: World): SharedGraphOutcome | undefined {
  return sharedGraphOf(world)?.outcome;
}

/** Current shared encoding failure, preserved for the frame driver without throwing in a system. */
export function sharedFeatureGraphEncodeError(
  world: World,
): RenderFeatureStageFailedError | undefined {
  const encoding = sharedGraphOf(world)?.encoding;
  return encoding?.kind === 'failed' ? encoding.error : undefined;
}

/** Whether Record encoded the current shared graph, including an empty receipt. */
export function sharedFeatureGraphEncoded(world: World): boolean {
  return sharedGraphOf(world)?.encoding.kind === 'encoded';
}

/** Only a genuinely pending scene input can defer the shared graph to a later frame. */
export function deferSharedFeatureGraph(world: World): void {
  const state = sharedGraphOf(world);
  if (state !== undefined) state.encoding = { kind: 'scene-input-pending' };
}
export function sharedFeatureSceneInputsPending(world: World): boolean {
  return sharedGraphOf(world)?.encoding.kind === 'scene-input-pending';
}

/** Required Feature inputs have not produced a graph for this frame yet. */
export function sharedFeaturePreparationPending(world: World): boolean {
  return sharedGraphOf(world)?.encoding.kind === 'preparation-pending';
}

/** Execute only the graph compiled in RenderRecord, after its scene-input captures encoded. */
export function encodeSharedFeatureGraph(
  world: World,
  encoder: RhiCommandEncoder,
): Result<RenderFeatureGraphReceipt<Graph>, RenderFeatureStageFailedError> {
  const state = sharedGraphOf(world);
  const outcome = state?.outcome;
  if (state === undefined || outcome === undefined)
    return err(stageFailure(`${RENDER_FEATURE_GRAPH_COMPILE_SYSTEM} did not compile this frame`));
  if (!outcome.ok) return err(outcome.error);
  if (state.encoding.kind === 'failed') return err(state.encoding.error);
  if (state.encoding.kind === 'encoding' || state.encoding.kind === 'encoded')
    return err(stageFailure('Shared Feature graph was already encoded'));
  const receipt = outcome.receipt;
  const owner = sharedOwner(world);
  state.encoding = { kind: 'encoding' };
  try {
    if (receipt.kind !== 'empty') {
      const { internals } = state;
      const graph = receipt.kind === 'compiled' ? receipt.graph : undefined;
      const graphGeneration = graph === undefined ? 0 : compiledRenderGraphGeneration(graph);
      internals.observationGraphGeneration = graphGeneration;
      const timing = internals.gpuPassTimingCapture;
      const instrumentation =
        (renderGraphPassInstrumentationActive(internals)
          ? createRenderGraphPassInstrumentation<SharedFeatureCommandFrame & WaterFluidGraphFrame>(
              graph === undefined
                ? { internals, owner: 'shared', generation: 0 }
                : { internals, graph, owner: 'shared' },
            )
          : undefined) ??
        (timing === undefined ? undefined : createPassTimingInstrumentation(timing));
      const frame = {
        encoder,
        runtime: internals,
        nativePassNames: internals.framePassNames,
        reportError: (error: import('../errors/render').RenderError) =>
          internals.errorRegistry.fire(error),
      };
      if (receipt.kind === 'commands') {
        if (
          state.scope !== recordContext(internals).deviceScope ||
          !state.scope?.isAlive() ||
          state.queue !== internals.device.queue
        )
          throw new Error('Shared Feature submission belongs to a retired device');
        const length = frame.nativePassNames?.length;
        try {
          encodeSharedFrameCommands(frame, receipt.executions, instrumentation);
        } catch (cause) {
          if (length !== undefined && frame.nativePassNames !== undefined)
            frame.nativePassNames.length = length;
          throw cause;
        }
      } else {
        const encoded = receipt.graph.execute(frame, undefined, instrumentation);
        if (!encoded.ok) throw encoded.error;
        if (internals.observationFrameId !== undefined)
          internals.observationCaptureOwner?.recordGraph(
            internals.observationFrameId,
            graphGeneration,
          );
      }
    }
    state.encoding = { kind: 'encoded' };
    owner.last = { ...owner.last, encoded: true };
    // Only the compile receipt supplies the shared plans acknowledged by Commit.
    stageRecordedFeatureGraph(world, receipt);
    return ok(receipt);
  } catch (cause) {
    const error = stageFailure(cause);
    owner.encodeFailures++;
    state.encoding = { kind: 'failed', error };
    return err(error);
  }
}

export function registerFeatureGraphSystems(world: World): void {
  sharedOwner(world);
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderFeatureGraphCompileOrder],
        commands: 'none',
        name: RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
        after: [RenderEncoderOpenOrder],
        before: [RenderGraphCompileOrder],
        queries: [],
        fn: (world) => {
          const state = sharedGraphOf(world);
          if (state === undefined || renderFrameEncoder(world).kind !== 'open') return;
          state.outcome = compileSharedGraph(world, state);
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCleanup,
      defineSystem({
        sets: [RenderFeatureGraphRetireOrder],
        commands: 'none',
        name: RENDER_FEATURE_GRAPH_RETIRE_SYSTEM,
        before: [RenderSubmissionRetireOrder],
        queries: [],
        fn: (world) => {
          const state = sharedGraphOf(world);
          world.removeResource(SharedFeatureGraph);
          const outcome = state?.outcome;
          if (state === undefined || outcome?.ok !== true) return;
          if (outcome.receipt.kind !== 'compiled') {
            const history = sharedOwner(world);
            if (
              renderSubmission(world).accepted &&
              (outcome.receipt.kind === 'empty' || state.encoding.kind === 'encoded')
            )
              retireHistory(world, history);
            return;
          }
          const graph = outcome.receipt.graph;
          if (state.encoding.kind !== 'encoded') {
            void graph.retire();
            return;
          }
          const history = sharedOwner(world);
          const previous = history.current;
          const submission = renderSubmission(world);
          const accepted = submission.accepted;
          if (accepted) graph.commitExecution();
          else graph.discardExecution();
          if (accepted)
            history.current = {
              graph,
              generation: state.generation,
              queue: state.queue,
              owner: state.internals.featureHost,
              frame: state.frame,
            };
          const retired = accepted ? previous?.graph : graph;
          if (retired === undefined) return;
          retireAfterSubmission(world, {
            generation: accepted && previous !== undefined ? previous.generation : state.generation,
            queue: accepted && previous !== undefined ? previous.queue : state.queue,
            release: () => {
              void retired.retire();
            },
          });
        },
      }),
    )
    .unwrap();
}
