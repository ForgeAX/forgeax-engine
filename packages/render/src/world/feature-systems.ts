import {
  defineComponent,
  defineSystemSet,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { RhiError } from '@forgeax/engine-rhi';
import {
  type RenderError,
  RenderFeatureBatchIncompleteError,
  type RenderFeatureInputUnavailableError,
} from '../errors/render';
import type { RenderFeatureGraphReceipt } from '../features/graph-receipt';
import type {
  RenderFeatureFrameBatch,
  RenderFeatureFrameInput,
  RenderFeatureFrameOpen,
  RenderFeatureFrameResult,
  RenderFeatureHost,
} from '../features/host';
import type { MotionBlurFeatureInput } from '../features/motion-blur/motion-blur-feature';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit, RenderPrepare, renderSubmission } from './render-world';
import { requireViewField } from './view-field';

/*
 * Installed RenderFeatures prepare in RenderPrepare, once per Renderer frame:
 *
 *   render-feature-views -> render-motion-blur-plan -> render-feature-open
 *     -> RenderFeatureSet (render-feature:<id>, chained in installation order)
 *     -> render-feature-batch
 *
 * `render-feature-views` derives each recording view's {@link ViewFeatureInput};
 * `render-motion-blur-plan` plans its motion blur; `render-feature-open` opens the frame over every view's input; each Feature's
 * system extracts, plans and prepares its slot; `render-feature-batch` seals the
 * frame. Recording reads the sealed batch and never prepares a Feature; it
 * stages the plans its graphs recorded ({@link stageRecordedFeatureGraph}).
 *
 * The frame settles after submission: `render-feature-commit` (RenderCommit)
 * acknowledges the recorded plans of an accepted `RenderSubmission`, and
 * `render-feature-abort` (RenderCleanup) aborts a frame no submission accepted.
 */

/** RenderPrepare system deriving each recording view's Feature frame input. */
export const RENDER_FEATURE_VIEWS_SYSTEM = 'render-feature-views';
/** RenderPrepare system planning each recording view's motion blur Feature input. */
export const RENDER_MOTION_BLUR_PLAN_SYSTEM = 'render-motion-blur-plan';
/** RenderPrepare system staging the Feature views of capture faces (see capture-face-feature-systems). */
export const RENDER_CAPTURE_FACE_INPUTS_SYSTEM = 'render-capture-face-inputs';

/** World resource key of the capture-face Feature inputs staged for one Renderer frame. */
export const CaptureFaceInputsKey = Object.freeze({ name: 'RenderCaptureFaceInputs' });

/** Capture faces' Feature frame inputs for `frame`; merged into the open Feature frame. */
export interface CaptureFaceInputs {
  frame: number;
  inputs: readonly RenderFeatureFrameInput[];
}

function captureFaceInputsOf(world: World): readonly RenderFeatureFrameInput[] {
  if (!world.hasResource(CaptureFaceInputsKey)) return [];
  const staged = world.getResource<CaptureFaceInputs>(CaptureFaceInputsKey);
  return staged.frame === renderSubmission(world).frame ? staged.inputs : [];
}

/** Stage the capture faces' Feature inputs of this frame. */
export function stageCaptureFaceInputs(
  world: World,
  inputs: readonly RenderFeatureFrameInput[],
): void {
  const staged: CaptureFaceInputs = { frame: renderSubmission(world).frame, inputs };
  if (world.hasResource(CaptureFaceInputsKey)) {
    Object.assign(world.getResource<CaptureFaceInputs>(CaptureFaceInputsKey), staged);
  } else world.insertResource(CaptureFaceInputsKey, staged);
}
/** RenderPrepare system opening the Renderer's Feature frame over every view's input. */
export const RENDER_FEATURE_OPEN_SYSTEM = 'render-feature-open';
/** RenderPrepare system sealing the Feature frame after every installed Feature joined it. */
export const RENDER_FEATURE_BATCH_SYSTEM = 'render-feature-batch';
/** RenderCommit system acknowledging the recorded Feature plans of an accepted submission. */
export const RENDER_FEATURE_COMMIT_SYSTEM = 'render-feature-commit';
/** RenderCleanup system aborting a Feature frame no submission accepted. */
export const RENDER_FEATURE_ABORT_SYSTEM = 'render-feature-abort';

/** Features prepare in installation order. */
export const RenderFeatureSet = defineSystemSet({ name: 'render-features', chained: true });

/** One recording view's Feature frame facts, prepared in RenderPrepare. */
export interface ViewFeatureFrameInput {
  /** The host frame input; undefined when the view's Renderer has no Feature host. */
  readonly input: RenderFeatureFrameInput | undefined;
  /** The material skylight prepared Feature graphics bind this frame. */
  readonly skylight: SkylightBindGroupResources | undefined;
}

/**
 * One view's `render-feature-views` outcome. `unavailable` is the structured
 * reason the view records no Features this frame; `failed` is an unexpected
 * cause its recording rethrows.
 */
export type ViewFeatureInputOutcome =
  | { readonly kind: 'prepared'; readonly value: ViewFeatureFrameInput }
  | { readonly kind: 'unavailable'; readonly error: RenderFeatureInputUnavailableError }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** One view's motion blur plan; `render-motion-blur-plan` writes it for `frame`. */
export interface ViewMotionBlurPlan {
  readonly frame: number;
  /** Undefined when the view's camera requests no motion blur. */
  readonly input: MotionBlurFeatureInput | undefined;
}

export interface ViewFeatureInputState {
  frame: number;
  outcome: ViewFeatureInputOutcome;
  motionBlur: ViewMotionBlurPlan | undefined;
}

/** A recording view's Feature input; written only by `render-feature-views`. */
export const ViewFeatureInput = defineComponent('ViewFeatureInput', {
  state: 'unique<ViewFeatureInput>',
});

/** The view's Feature input prepared this renderer frame; undefined when the system did not run for it. */
export function viewFeatureInputOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewFeatureInputOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewFeatureInput)) return undefined;
  const state = world
    .resolveUniqueRef<ViewFeatureInputState>(
      requireViewField(world, entity, ViewFeatureInput, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The Renderer scene-input transaction a Feature frame opens and its submission settles. */
type FeatureSceneInputs = NonNullable<RenderFeatureFrameInput['sceneResources']>;

/**
 * A sealed Feature frame. `sealed` carries the batch recording consumes;
 * `incomplete` and `failed` reject every view's Feature recording this frame.
 */
export type FeatureFrameOutcome =
  | { readonly kind: 'sealed'; readonly batch: RenderFeatureFrameBatch }
  | { readonly kind: 'incomplete'; readonly error: RenderFeatureBatchIncompleteError }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** One Renderer frame's Feature preparation, from `render-feature-open` until its submission settles. */
export interface FeatureFrame {
  readonly frame: number;
  readonly host: RenderFeatureHost;
  readonly sceneInputs: FeatureSceneInputs | undefined;
  open: RenderFeatureFrameOpen | undefined;
  failure: { readonly cause: unknown } | undefined;
  outcome: FeatureFrameOutcome | undefined;
  /** Graph receipts the encoders consumed; acknowledged only if their frame, generation and view were accepted. */
  readonly recordedGraphs: Set<RenderFeatureGraphReceipt>;
  /** Whether its submission (or an abort) already settled it. */
  settled: boolean;
}

/** Receives a settlement failure; the settlement systems never throw. */
export type FeatureSettlementReporter = (error: RenderError | RhiError) => void;

/** Feature producer and transaction failures of one settlement, reported together. */
export function featureSettlementError(failures: readonly unknown[]): RhiError {
  return new RhiError({
    code: 'internal-error',
    expected: 'every Feature of the frame settles its submission or abort',
    hint: 'inspect the Feature producer and prepared-resource causes; the next frame retries',
    detail: {
      error: {
        code: 'render-feature-settlement-failed',
        message: 'Feature frame settlement failed',
        detail: {
          error: new AggregateError(failures, 'Feature frame settlement failed', {
            cause: failures[0],
          }),
        },
      },
    },
  });
}

interface FeatureFrameState {
  readonly host: RenderFeatureHost;
  readonly report: FeatureSettlementReporter;
  current: FeatureFrame | undefined;
}

/** World resource key of the Renderer's Feature frame. */
const RenderFeatureFrameKey = Object.freeze({ name: 'RenderFeatureFrame' });

/** The system that extracts, plans and prepares one installed Feature. */
export function renderFeatureSystemName(identity: string): string {
  return `render-feature:${identity}`;
}

function featureFrameState(world: World): FeatureFrameState | undefined {
  return world.hasResource(RenderFeatureFrameKey)
    ? world.getResource<FeatureFrameState>(RenderFeatureFrameKey)
    : undefined;
}

/** The current Renderer frame's Feature frame; undefined when no view opened one. */
function currentFeatureFrame(world: World): FeatureFrame | undefined {
  const current = featureFrameState(world)?.current;
  return current?.frame === renderSubmission(world).frame ? current : undefined;
}

/** The sealed Feature frame of the current Renderer frame, if one opened. */
export function featureFrameOutcome(world: World): FeatureFrameOutcome | undefined {
  return currentFeatureFrame(world)?.outcome;
}

/** A recording view's sealed Feature result. */
export function viewFeatureFrameResult(
  outcome: Extract<FeatureFrameOutcome, { kind: 'sealed' }>,
  view: string,
): RenderFeatureFrameResult | undefined {
  return outcome.batch.views.get(view);
}

/**
 * Stage the compiler receipt one graph encoder consumed. Commit derives plan
 * acknowledgments from these receipts, never from a requested candidate.
 */
export function stageRecordedFeatureGraph(world: World, receipt: RenderFeatureGraphReceipt): void {
  const current = currentFeatureFrame(world);
  if (current?.frame === receipt.frame) current.recordedGraphs.add(receipt);
}

/** Record an encoded view graph only when it matches its compiler's provenance. */
export function recordViewFeatureGraph(
  world: World,
  receipt: RenderFeatureGraphReceipt | undefined,
  graph: object,
): void {
  if (receipt?.kind !== 'compiled' || receipt.graph !== graph) return;
  stageRecordedFeatureGraph(world, receipt);
}

/**
 * Abort a Feature frame no submission accepted: end its scene-input
 * transaction and discard every prepared batch. Idempotent; returns the
 * failures it contained.
 */
function abortFeatureFrame(
  frame: FeatureFrame,
  report: FeatureSettlementReporter,
  completion?: Promise<unknown>,
  batch = frame.outcome?.kind === 'sealed' ? frame.outcome.batch : undefined,
): unknown[] {
  if (frame.settled) return [];
  frame.settled = true;
  const failures: unknown[] = [];
  attempt(failures, () => frame.sceneInputs?.complete(false, completion));
  if (batch === undefined) return failures;
  failures.push(...frame.host.abortFrame(batch));
  for (const resources of batch.preparedResourceBatches)
    attempt(failures, () => {
      const released = resources.release();
      if (!released.ok) report(released.error);
    });
  return failures;
}

/**
 * Settle a sealed frame its submission accepted: end the scene-input
 * transaction, acknowledge exactly the recorded plans and retire the prepared
 * graphics once the submitted work completed.
 */
function commitFeatureFrame(
  world: World,
  frame: FeatureFrame,
  batch: RenderFeatureFrameBatch,
  report: FeatureSettlementReporter,
): unknown[] {
  frame.settled = true;
  const { completion } = renderSubmission(world);
  const failures: unknown[] = [];
  attempt(failures, () => frame.sceneInputs?.complete(true, completion));
  const recorded = new Set<RenderFeaturePlannedFrame>();
  const { generation } = renderSubmission(world);
  for (const receipt of frame.recordedGraphs) {
    if (receipt.generation !== generation) continue;
    if (receipt.view !== undefined && !viewAccepted(world, receipt.view)) continue;
    for (const plan of receipt.plans) recorded.add(plan);
  }
  failures.push(...frame.host.submitFrame(batch, recorded));
  // Queue acceptance survives producer failures: newly retired GPU resources
  // are marked submitted before any cleanup can see them.
  const resources = batch.preparedResourceBatches;
  attempt(failures, () => frame.host.markPreparedGraphicsSubmitted(resources));
  const retire = () => {
    const retired = frame.host.retirePreparedGraphics(resources);
    if (!retired.ok) report(retired.error);
  };
  void completion?.then(retire, retire);
  return failures;
}

function attempt(failures: unknown[], action: () => void): void {
  try {
    action();
  } catch (cause) {
    failures.push(cause);
  }
}

/** Bind a host's Feature frame and its open/seal/settle systems to its Render World. */
export function bindRenderFeatureFrame(
  world: World,
  host: RenderFeatureHost,
  report: FeatureSettlementReporter,
): void {
  const state: FeatureFrameState = { host, report, current: undefined };
  world.insertResource(RenderFeatureFrameKey, state);
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_FEATURE_OPEN_SYSTEM,
      after: [
        RENDER_FEATURE_VIEWS_SYSTEM,
        RENDER_MOTION_BLUR_PLAN_SYSTEM,
        RENDER_CAPTURE_FACE_INPUTS_SYSTEM,
      ],
      queries: [{ read: [ViewFeatureInput] }],
      fn: (world, [rows]) => {
        const inputs: RenderFeatureFrameInput[] = [];
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          const view = world
            .resolveUniqueRef<ViewFeatureInputState>(
              requireViewField(world, entity, ViewFeatureInput, 'state'),
            )
            .unwrap();
          if (view.frame !== frame || view.outcome.kind !== 'prepared') return;
          const input = view.outcome.value.input;
          if (input === undefined) return;
          const motionBlur = view.motionBlur?.frame === frame ? view.motionBlur.input : undefined;
          inputs.push(motionBlur === undefined ? input : { ...input, motionBlur });
        });
        inputs.push(...captureFaceInputsOf(world));
        openFeatureFrame(state, frame, inputs);
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_FEATURE_BATCH_SYSTEM,
      after: [RENDER_FEATURE_OPEN_SYSTEM],
      queries: [],
      fn: (world) => {
        const current = state.current;
        if (current?.frame === renderSubmission(world).frame) sealFeatureFrame(state, current);
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_FEATURE_COMMIT_SYSTEM,
      queries: [],
      fn: (world) => {
        const current = currentFeatureFrame(world);
        if (current === undefined || current.settled || current.outcome?.kind !== 'sealed') return;
        if (!renderSubmission(world).accepted) return;
        reportFailures(
          state,
          commitFeatureFrame(world, current, current.outcome.batch, state.report),
        );
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_FEATURE_ABORT_SYSTEM,
      queries: [],
      fn: (world) => {
        const current = currentFeatureFrame(world);
        if (current === undefined) return;
        state.current = undefined;
        reportFailures(
          state,
          abortFeatureFrame(current, state.report, renderSubmission(world).completion),
        );
      },
    })
    .unwrap();
}

function reportFailures(state: FeatureFrameState, failures: readonly unknown[]): void {
  if (failures.length > 0) state.report(featureSettlementError(failures));
}

/** Abort an unsettled earlier frame, then open this frame over its views' inputs. */
function openFeatureFrame(
  state: FeatureFrameState,
  frame: number,
  inputs: readonly RenderFeatureFrameInput[],
): void {
  const stale = state.current;
  state.current = undefined;
  // A frame whose RenderCleanup never ran (its owner failed before closing it).
  if (stale !== undefined) reportFailures(state, abortFeatureFrame(stale, state.report));
  const first = inputs[0];
  if (first === undefined) return;
  const current: FeatureFrame = {
    frame,
    host: state.host,
    sceneInputs: first.sceneResources,
    open: undefined,
    failure: undefined,
    outcome: undefined,
    recordedGraphs: new Set(),
    settled: false,
  };
  state.current = current;
  try {
    current.sceneInputs?.begin(first.frameNumber);
    current.open = state.host.beginFrame(inputs);
  } catch (cause) {
    current.failure = { cause };
  }
}

function sealFeatureFrame(state: FeatureFrameState, current: FeatureFrame): void {
  const open = current.open;
  current.open = undefined;
  if (open === undefined) {
    current.outcome = { kind: 'failed', cause: current.failure?.cause };
    reportFailures(state, abortFeatureFrame(current, state.report));
    return;
  }
  try {
    const missing = current.host.unjoinedFeatures(open);
    const batch = current.host.finishFrame(open);
    current.outcome =
      current.failure !== undefined
        ? { kind: 'failed', cause: current.failure.cause }
        : missing.length > 0
          ? { kind: 'incomplete', error: new RenderFeatureBatchIncompleteError({ missing }) }
          : { kind: 'sealed', batch };
    // An unsealed frame records no Feature work: release what it prepared.
    if (current.outcome.kind !== 'sealed')
      reportFailures(state, abortFeatureFrame(current, state.report, undefined, batch));
  } catch (cause) {
    current.outcome = { kind: 'failed', cause };
    reportFailures(state, abortFeatureFrame(current, state.report));
  }
}

export function addRenderFeatureSystem(world: World, identity: string): void {
  world
    .addSystems(RenderPrepare, RenderFeatureSet, [
      {
        name: renderFeatureSystemName(identity),
        after: [RENDER_FEATURE_OPEN_SYSTEM],
        before: [RENDER_FEATURE_BATCH_SYSTEM],
        queries: [],
        fn: (world) => {
          const current = currentFeatureFrame(world);
          if (current?.open === undefined || current.failure !== undefined) return;
          try {
            current.host.prepareFeature(current.open, identity);
          } catch (cause) {
            current.failure = { cause };
          }
        },
      },
    ])
    .unwrap();
}

/** Idempotent: a system already removed from the schedule stays removed. */
export function removeRenderFeatureSystem(world: World, identity: string): void {
  const removed = world.removeSystem(RenderPrepare, renderFeatureSystemName(identity));
  if (!removed.ok && removed.error.code !== 'system-before-unknown') throw removed.error;
}
