import { expect, it, vi } from 'vitest';
import {
  createRenderWorld,
  publishRenderSubmission,
  renderSubmission,
} from '../../world/render-world';
import { ViewSsrAdmission } from '../../world/ssr-admission-systems';
import {
  type CubeCaptureFrameInput,
  createFrameRecordingAttempt,
  stageFrameCaptureCompletion,
} from '../frame';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';

it.each([
  { accepted: true, fence: 'none', expected: false },
  { accepted: false, fence: 'display', expected: false },
  { accepted: true, fence: 'display', expected: true },
  { accepted: true, fence: 'capture', expected: true },
] as const)('settles probe tickets only for accepted encoded work ($accepted / $fence)', ({
  accepted,
  fence,
  expected,
}) => {
  const world = createRenderWorld();
  renderSubmission(world).accepted = accepted;
  const completion = Promise.resolve();
  const completed = vi.fn((_accepted: boolean, _completion: Promise<void> | undefined) =>
    Promise.resolve(),
  );
  const attempt = createFrameRecordingAttempt(undefined);
  attempt.submitted = true;
  if (fence === 'display') attempt.completion = completion;
  if (fence === 'capture') attempt.captureCompletion = completion;
  const internals = { renderWorld: world } as unknown as RenderSystemInternals;
  const frameState = {} as RenderFrameState;
  const captures = {
    state: {},
    reflectionProbes: { completeSubmission: completed },
  } as unknown as CubeCaptureFrameInput;
  stageFrameCaptureCompletion(internals, frameState, attempt, captures, fence !== 'none');
  expect(completed.mock.calls[0]?.[0]).toBe(expected);
  expect(completed.mock.calls[0]?.[1]).toBe(fence === 'none' ? undefined : completion);
  stageFrameCaptureCompletion(internals, frameState, attempt, captures, fence !== 'none');
  expect(completed).toHaveBeenCalledTimes(1);
});

it.each([
  { encoded: true, physical: false, accepted: false, fallback: true },
  { encoded: false, physical: false, accepted: false, fallback: false },
  { encoded: false, physical: true, accepted: true, fallback: false },
  { encoded: true, physical: true, accepted: false, fallback: true },
  { encoded: true, physical: true, accepted: true, fallback: true },
])('settles probe demand from actual graph encoding: %j', ({
  encoded,
  physical,
  accepted,
  fallback,
}) => {
  const world = createRenderWorld();
  const view = world
    .spawn({
      component: ViewSsrAdmission,
      data: {
        state: world.allocUniqueRef('ViewSsrAdmission', {
          frame: renderSubmission(world).frame,
          outcome: { kind: 'resolved', reflectionFallbackDemand: true },
        }),
      },
    })
    .unwrap();
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  const frameState = {} as RenderFrameState;
  const attempt = createFrameRecordingAttempt(undefined);
  attempt.submitted = physical;
  const completion = physical ? Promise.resolve() : undefined;
  attempt.completion = completion;
  publishRenderSubmission(world, {
    accepted,
    completion,
    creditCompletion: undefined,
    generation: 0,
  });
  const completeSubmission = vi.fn();
  const cube = {
    state: {},
    reflectionProbes: { completeSubmission },
  } as unknown as CubeCaptureFrameInput;

  stageFrameCaptureCompletion(internals, frameState, attempt, cube, encoded);
  expect(completeSubmission).toHaveBeenCalledExactlyOnceWith(
    encoded && physical && accepted,
    attempt.completion,
    undefined,
    fallback,
  );
  stageFrameCaptureCompletion(internals, frameState, attempt, cube, encoded);
  expect(completeSubmission).toHaveBeenCalledTimes(1);
});
