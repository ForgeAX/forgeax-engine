import { expect, it, vi } from 'vitest';
import { stageDisplaySubmission } from '../../world/display-submission-systems';
import { publishRenderSubmission, renderWorldFor } from '../../world/render-world';
import type { FrameRecordingAttempt } from '../frame';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';

function setup() {
  const mark = vi.fn();
  const internals = { markRenderTargetSubmitted: mark } as unknown as RenderSystemInternals;
  const frameState = { frameOutputs: { sceneSubmitted: false } } as unknown as RenderFrameState;
  const completion = Promise.resolve();
  const attempt = {
    captureFrames: [],
    completion,
    captureCompletion: undefined,
  } as unknown as FrameRecordingAttempt;
  const resolution = { commit: vi.fn(), observe: vi.fn() };
  return { internals, frameState, attempt, resolution, completion };
}

it.each([
  { accepted: true, committed: 1 },
  { accepted: false, committed: 0 },
])('a queue-submitted display frame commits resolution history only when accepted=$accepted', ({
  accepted,
  committed,
}) => {
  const { internals, frameState, attempt, resolution, completion } = setup();
  publishRenderSubmission(renderWorldFor(internals), {
    accepted,
    completion,
    creditCompletion: undefined,
    generation: 1,
  });
  stageDisplaySubmission(internals, frameState, {
    frame: 0,
    attempt,
    resolution: resolution as never,
    extent: undefined,
    rasterRows: undefined,
    renderableCount: 0,
    sampleResolution: true,
    timing: undefined,
    barrelMapping: undefined,
  });
  expect(resolution.commit).toHaveBeenCalledTimes(committed);
  expect(resolution.observe).toHaveBeenCalledTimes(committed);
  expect(frameState.frameOutputs.sceneSubmitted).toBe(accepted);
  // The submitted GPU work is fenced either way, so its capture graphs retire on it.
  expect(attempt.captureCompletion).toBe(completion);
});
