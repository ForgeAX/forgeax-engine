import type { World } from '@forgeax/engine-ecs';
import { RendererOperationError } from '../errors/render';
import { MaterialUniformRecording } from '../record/material-uniforms';
import { featureFrameOutcome } from '../world/feature-systems';
import { beginFrameSubmission, frameSubmitOutcome } from '../world/frame-submit-systems';
import {
  closeFrameEncoder,
  RenderRecordInput,
  type RenderRecordInputState,
} from '../world/record-systems';
import {
  publishRenderSubmission,
  renderSubmission,
  runRenderQueue,
  runRenderRecord,
} from '../world/render-world';
import { requirePreparedSurfaceUi } from '../world/surface-ui-systems';
import type { FramePreparation } from './frame-recording';

/** The only cooperative driver boundary: all view work is performed by World systems. */
export function* prepareRenderFrame(
  input: RenderRecordInputState & { readonly world: World },
): FramePreparation {
  const { world, rendererInternals: owner } = input;
  const uniforms = new MaterialUniformRecording();
  const generation = owner?.deviceScope.generation;
  const isCurrent = () =>
    input.isCurrent?.() !== false && owner?.deviceScope.generation === generation;
  const staged: RenderRecordInputState = { ...input, generation: generation ?? 0, isCurrent };
  let release: (() => void) | undefined;
  let failure: unknown;
  beginFrameSubmission(world);
  world.insertResource(RenderRecordInput, staged);
  if (owner !== undefined) owner.framePassNames = [];
  if (!renderSubmission(world).open)
    publishRenderSubmission(world, {
      accepted: false,
      completion: undefined,
      creditCompletion: undefined,
      generation: generation ?? 0,
    });
  try {
    if (!isCurrent()) return false;
    if (renderSubmission(world).open) {
      requirePreparedSurfaceUi(world, input.frameId);
      uniforms.run(() => runRenderQueue(world));
      release = input.device.queue.holdCompletions?.();
      yield {
        kind:
          featureFrameOutcome(world)?.kind === 'sealed'
            ? 'features-prepared'
            : 'recording-checkpoint',
      };
      if (!isCurrent()) return false;
    }
    const recorded = uniforms.run(() => runRenderRecord(world, staged));
    if (!recorded.ok) throw recorded.error;
    const outcome = frameSubmitOutcome(world);
    if (outcome.failures.length === 1) throw outcome.failures[0];
    if (outcome.failures.length > 1)
      throw new AggregateError(outcome.failures, 'Renderer frame submission failed');
    if (!outcome.result.ok && outcome.result.stage === 'submit')
      throw new RendererOperationError('frame-submit-rejected', {
        operation: 'draw',
        stage: 'submit',
        accepted: false,
        ...(outcome.rejectionCause === undefined
          ? {}
          : {
              cause: {
                code: outcome.rejectionCause.code,
                expected: outcome.rejectionCause.expected,
                hint: outcome.rejectionCause.hint,
                ...(outcome.rejectionCause.detail === undefined
                  ? {}
                  : { detail: outcome.rejectionCause.detail }),
              },
            }),
      });
    return outcome.result.ok;
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    completeFramePreparation(uniforms, world, release, failure);
  }
}

function completeFramePreparation(
  uniforms: MaterialUniformRecording,
  world: World,
  release: (() => void) | undefined,
  failure: unknown,
): void {
  const failures: unknown[] = [];
  try {
    uniforms.complete();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    closeFrameEncoder(world);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    release?.();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length === 0) return;
  if (failure !== undefined) failures.unshift(failure);
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Renderer frame preparation cleanup failed');
}
