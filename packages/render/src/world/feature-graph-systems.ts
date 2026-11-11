import type { World } from '@forgeax/engine-ecs';
import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { err, ok, type Result, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import { compileSharedFeatureGraph } from '../assembly/feature-frame-graph';
import { RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureGraphReceipt } from '../features/graph-receipt';
import type { RenderFeaturePlanExecution } from '../features/host';
import {
  type SharedFeatureCommandFrame,
  SharedFrameNativeCommands,
  sharedFrameNativeExecutions,
  sharedFrameNativeFailure,
} from '../features/shared-frame-native-commands';
import type { SharedFeatureGraphInspection } from '../inspection-types';
import { createPassTimingInstrumentation } from '../record/gpu-pass-timing/instrumentation';
import type { RenderSystemInternals } from '../record/render-context';
import { featureFrameOutcome, stageRecordedFeatureGraph } from './feature-systems';
import { RENDER_ENCODER_OPEN_SYSTEM, renderFrameEncoder } from './record-systems';
import { RenderCleanup, RenderRecord, renderSubmission } from './render-world';
import { RENDER_SUBMISSION_RETIRE_SYSTEM, retireAfterSubmission } from './submission-systems';
import { recordContext } from './view-record-context';

export const RENDER_FEATURE_GRAPH_COMPILE_SYSTEM = 'render-feature-graph-compile';
export const RENDER_FEATURE_GRAPH_RETIRE_SYSTEM = 'render-feature-graph-retire';

type Graph = CompiledRenderGraph<SharedFeatureCommandFrame>;

export type SharedGraphOutcome =
  | { readonly ok: true; readonly receipt: RenderFeatureGraphReceipt<Graph> }
  | { readonly ok: false; readonly error: RenderFeatureStageFailedError };

/** One frame owns its receipt; only fallback graphs share its retirement lifetime. */
interface SharedFeatureGraphState {
  readonly frame: number;
  readonly internals: RenderSystemInternals;
  readonly generation: number;
  readonly queue: RenderSystemInternals['device']['queue'];
  outcome: SharedGraphOutcome | undefined;
  native: readonly RenderFeaturePlanExecution[] | undefined;
  encoding:
    | { readonly kind: 'waiting' | 'scene-input-pending' | 'encoded' }
    | { readonly kind: 'failed'; readonly error: RenderFeatureStageFailedError };
}

const SharedFeatureGraph = Object.freeze({ name: 'SharedFeatureGraph' });
const SharedFeatureGraphOwner = Object.freeze({ name: 'SharedFeatureGraphOwner' });

interface SharedOwner {
  shell: SharedFrameNativeCommands | undefined;
  nativeFrames: number;
  fallbackFrames: number;
  emptyFrames: number;
  shellBuilds: number;
  shellReuses: number;
  encodeFailures: number;
  last: SharedFeatureGraphInspection['last'];
}

function sharedOwner(world: World): SharedOwner {
  if (!world.hasResource(SharedFeatureGraphOwner))
    world.insertResource<SharedOwner>(SharedFeatureGraphOwner, {
      shell: undefined,
      nativeFrames: 0,
      fallbackFrames: 0,
      emptyFrames: 0,
      shellBuilds: 0,
      shellReuses: 0,
      encodeFailures: 0,
      last: { frame: 0, generation: 0, route: 'none', receipt: undefined, encoded: false },
    });
  return world.getResource<SharedOwner>(SharedFeatureGraphOwner);
}

/** Detached inspection; reading it never creates an owner or changes admission. */
export function inspectSharedFeatureGraphs(world: World): SharedFeatureGraphInspection | undefined {
  if (!world.hasResource(SharedFeatureGraphOwner)) return undefined;
  const { shell: _shell, ...counters } = world.getResource<SharedOwner>(SharedFeatureGraphOwner);
  return Object.freeze({ ...counters, last: Object.freeze({ ...counters.last }) });
}

function sharedGraphOf(world: World): SharedFeatureGraphState | undefined {
  if (!world.hasResource(SharedFeatureGraph)) return undefined;
  const state = world.getResource<SharedFeatureGraphState>(SharedFeatureGraph);
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

function stageFailure(cause: unknown): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError('renderer:shared', -1, 'record', 'next-frame', cause);
}

/** The submission selects its shared view before RenderRecord; no callback or batch mirror. */
export function stageSharedFeatureGraph(world: World, internals: RenderSystemInternals): void {
  world.insertResource<SharedFeatureGraphState>(SharedFeatureGraph, {
    frame: renderSubmission(world).frame,
    internals,
    generation: recordContext(internals).deviceScope?.generation ?? 0,
    queue: internals.device.queue,
    outcome: undefined,
    native: undefined,
    encoding: { kind: 'waiting' },
  });
}

function compileSharedGraph(world: World, state: SharedFeatureGraphState): SharedGraphOutcome {
  const sealed = featureFrameOutcome(world);
  if (sealed?.kind !== 'sealed')
    return { ok: false, error: stageFailure('Feature frame is not sealed') };
  try {
    const owner = sharedOwner(world);
    const graph = prepareSharedGraph(state, sealed.batch.frame, owner);
    const plans = sealed.batch.frame.plans;
    const identity = { frame: state.frame, generation: state.generation, view: undefined, plans };
    const receipt: RenderFeatureGraphReceipt<Graph> =
      graph === undefined
        ? { kind: 'empty', ...identity }
        : { kind: 'compiled', ...identity, graph };
    owner.last = {
      frame: state.frame,
      generation: state.generation,
      route:
        graph === undefined
          ? 'empty'
          : state.native === undefined
            ? 'compiled-graph'
            : 'native-shell',
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

function prepareSharedGraph(
  state: SharedFeatureGraphState,
  result: import('../features/host').RenderFeatureFrameResult,
  owner: SharedOwner,
): Graph | undefined {
  const { internals } = state;
  const sharedInputs = internals.featureSceneInputs?.hasSharedWork === true;
  const executions = sharedInputs
    ? undefined
    : sharedFrameNativeExecutions(result, internals.device.caps);
  if (executions?.every((execution) => execution.passes.length === 0)) {
    owner.emptyFrames++;
    return undefined;
  }
  const scope = recordContext(internals).deviceScope;
  if (
    executions === undefined ||
    scope === undefined ||
    typeof scope._adopt !== 'function' ||
    typeof scope.isAlive !== 'function' ||
    !scope.isAlive()
  ) {
    owner.fallbackFrames++;
    return compileSharedFeatureGraph(internals, result);
  }
  if (owner.shell?.current(scope, internals.device) !== true) {
    void owner.shell?.dispose();
    owner.shell = new SharedFrameNativeCommands(scope, internals.device);
  }
  const prepared = owner.shell.prepare();
  if (prepared.built) owner.shellBuilds++;
  else owner.shellReuses++;
  owner.nativeFrames++;
  state.native = executions;
  return prepared.graph;
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
  if (state.encoding.kind === 'encoded')
    return err(stageFailure('Shared Feature graph was already encoded'));
  const receipt = outcome.receipt;
  const owner = sharedOwner(world);
  try {
    if (receipt.kind === 'compiled') {
      const { internals } = state;
      const timing = internals.gpuPassTimingCapture;
      const nativePassNames: string[] = [];
      const encoded = receipt.graph.execute(
        {
          encoder,
          featureExecutions: state.native,
          nativePassNames,
          reportError: (error) => internals.errorRegistry.fire(error),
        },
        undefined,
        timing === undefined ? undefined : createPassTimingInstrumentation(timing),
      );
      if (!encoded.ok) {
        const error = stageFailure(
          state.native === undefined ? encoded.error : sharedFrameNativeFailure(encoded.error),
        );
        owner.encodeFailures++;
        state.encoding = { kind: 'failed', error };
        return err(error);
      }
      internals.framePassNames?.push(
        ...(state.native === undefined
          ? receipt.graph.inspect().passes.map((pass) => pass.name)
          : nativePassNames),
      );
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
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
      after: [RENDER_ENCODER_OPEN_SYSTEM],
      queries: [],
      fn: (world) => {
        const state = sharedGraphOf(world);
        if (state === undefined || renderFrameEncoder(world).kind !== 'open') return;
        state.outcome = compileSharedGraph(world, state);
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_FEATURE_GRAPH_RETIRE_SYSTEM,
      before: [RENDER_SUBMISSION_RETIRE_SYSTEM],
      queries: [],
      fn: (world) => {
        const state = sharedGraphOf(world);
        world.removeResource(SharedFeatureGraph);
        const outcome = state?.outcome;
        if (state === undefined || outcome?.ok !== true || outcome.receipt.kind !== 'compiled')
          return;
        const graph = outcome.receipt.graph;
        // The empty native shell belongs to DeviceScope, not this frame's leases.
        if (state.native !== undefined) return;
        if (state.encoding.kind !== 'encoded') {
          void graph.retire();
          return;
        }
        retireAfterSubmission(world, {
          generation: state.generation,
          queue: state.queue,
          release: () => {
            void graph.retire();
          },
        });
      },
    })
    .unwrap();
}
