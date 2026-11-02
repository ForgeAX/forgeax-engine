import type {
  RenderFeatureFrameBatch,
  RenderFeatureFrameInput,
  RenderFeatureHost,
} from '../features/host';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import {
  type FeatureFrameOutcome,
  featureFrameOutcome,
  stageRecordedFeatureGraph,
  ViewFeatureInput,
  type ViewFeatureInputState,
} from '../world/feature-systems';
import {
  endRenderFrame,
  publishRenderSubmission,
  RenderPrepare,
  renderSubmission,
} from '../world/render-world';

/**
 * Run one Renderer frame's RenderPrepare over the host's Render World the way
 * a Renderer does: each input stands for a view whose `render-feature-views`
 * prepared it, then RenderPrepare opens, prepares and seals the Feature frame.
 * The frame stays current for a frame-recording coordinator to settle.
 */
export function stageFeatureFrame(
  host: RenderFeatureHost,
  inputs: readonly RenderFeatureFrameInput[],
): FeatureFrameOutcome {
  const world = host.world;
  const submission = renderSubmission(world);
  const frame = submission.frame + 1;
  submission.frame = frame;
  submission.open = true;
  const views = inputs.map((input) => {
    const state: ViewFeatureInputState = {
      frame,
      outcome: { kind: 'prepared', value: { input, skylight: undefined } },
      motionBlur: undefined,
    };
    return world
      .spawn({
        component: ViewFeatureInput,
        data: { state: world.allocUniqueRef('ViewFeatureInput', state) },
      })
      .unwrap();
  });
  try {
    const ran = world.run(RenderPrepare);
    if (!ran.ok) throw ran.error;
  } finally {
    for (const view of views) world.despawn(view).unwrap();
  }
  const outcome = featureFrameOutcome(world);
  if (outcome === undefined) throw new Error('RenderPrepare opened no Feature frame');
  return outcome;
}

/**
 * Prepare one Feature frame and hand its sealed batch to the caller. The
 * frame stays current: the caller settles it with {@link submitFeatureFrame}
 * or {@link abortFeatureFrame}, or the next frame aborts it as stale.
 */
export function prepareFeatureFrame(
  host: RenderFeatureHost,
  inputs: readonly RenderFeatureFrameInput[],
): RenderFeatureFrameBatch {
  const outcome = stageFeatureFrame(host, inputs);
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'incomplete') throw outcome.error;
  return outcome.batch;
}

/** Every plan of a sealed batch: the shared frame's and each view's. */
export function allFeaturePlans(batch: RenderFeatureFrameBatch): RenderFeaturePlannedFrame[] {
  return [...batch.frame.plans, ...[...batch.views.values()].flatMap((view) => view.plans)];
}

/**
 * Close the current Feature frame as an accepted submission that recorded
 * `recorded` (every plan by default): RenderCommit acknowledges them, then
 * RenderCleanup closes the frame. A frame already closed is left alone.
 */
export function submitFeatureFrame(
  host: RenderFeatureHost,
  recorded?: readonly RenderFeaturePlannedFrame[],
  completion?: Promise<void>,
): void {
  const world = host.world;
  const outcome = featureFrameOutcome(world);
  if (outcome === undefined) return;
  const plans = recorded ?? (outcome.kind === 'sealed' ? allFeaturePlans(outcome.batch) : []);
  stageRecordedFeatureGraph(world, {
    kind: 'empty',
    frame: renderSubmission(world).frame,
    generation: renderSubmission(world).generation,
    view: undefined,
    plans,
  });
  closeFeatureFrame(world, true, completion);
}

/** Close the current Feature frame as a rejected submission: RenderCleanup aborts it. */
export function abortFeatureFrame(host: RenderFeatureHost): void {
  if (featureFrameOutcome(host.world) !== undefined) closeFeatureFrame(host.world, false);
}

function closeFeatureFrame(
  world: RenderFeatureHost['world'],
  accepted: boolean,
  completion?: Promise<void>,
): void {
  const { generation } = renderSubmission(world);
  publishRenderSubmission(world, {
    accepted,
    completion,
    creditCompletion: completion,
    generation,
  });
  endRenderFrame(world);
}
