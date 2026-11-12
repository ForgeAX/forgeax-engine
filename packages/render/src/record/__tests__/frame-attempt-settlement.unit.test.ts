import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { registerGraphSystems } from '../../world/graph-systems';
import { RenderView, ViewRecorder, ViewSubmission } from '../../world/render-views';
import {
  beginRenderFrame,
  endRenderFrame,
  publishRenderSubmission,
} from '../../world/render-world';
import { createFrameRecordingAttempt, releaseFrameRecordingAttempt } from '../frame';
import type { RenderFrameState } from '../frame-snapshot';

function fixture() {
  const world = new World();
  registerGraphSystems(world);
  let resolveRetirement!: (value: { readonly ok: true; readonly value: undefined }) => void;
  const retirement = new Promise<{ readonly ok: true; readonly value: undefined }>((resolve) => {
    resolveRetirement = resolve;
  });
  const retirePrevious = vi.fn(() => retirement);
  const retireCandidate = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const graph = (retire: typeof retirePrevious) => ({
    inspect: () => ({
      resources: [],
      resourceAllocation: { liveBytes: 16, pendingRetirementBytes: 0 },
    }),
    retire,
  });
  const previousGraph = graph(retirePrevious);
  const candidateGraph = graph(retireCandidate);
  const previousInstalled = { graph: previousGraph };
  const candidateInstalled = { graph: candidateGraph };
  const previous = {
    installed: previousInstalled,
    graphGeneration: 7,
    compiledGeneration: 3,
    lightingSignature: 'accepted',
  };
  const state = {
    frameNumber: 0,
    pipelinePreparationPending: true,
    compiledFrameGraphCandidate: { graph: candidateGraph, previous },
    compiledFrameGraph: candidateInstalled,
    graphGeneration: 8,
    compiledFrameGraphGeneration: 4,
    standardLightingGraphSignature: 'candidate',
    retiredCompiledFrameGraphs: new Set(),
    standardOncePerFrameFired: new Set(),
  } as unknown as RenderFrameState;
  const internals = { renderWorld: world, errorRegistry: { fire: vi.fn() } };
  const view = world
    .spawn(
      { component: RenderView, data: {} },
      {
        component: ViewRecorder,
        data: {
          state: world.allocUniqueRef('ViewRecorder', { owner: { frameState: state, internals } }),
        },
      },
      {
        component: ViewSubmission,
        data: { accepted: false, attempt: 1, scene: false, temporal: false },
      },
    )
    .unwrap();
  let frame = 0;
  const settle = (queueSubmitted: boolean, sceneAccepted: boolean) => {
    beginRenderFrame(world, ++frame);
    world
      .set(view, ViewSubmission, { accepted: sceneAccepted, attempt: frame, scene: sceneAccepted })
      .unwrap();
    publishRenderSubmission(world, {
      accepted: queueSubmitted,
      generation: 1,
      completion: queueSubmitted ? Promise.resolve() : undefined,
      creditCompletion: undefined,
    });
    endRenderFrame(world);
  };
  return {
    state,
    internals,
    previous,
    previousGraph,
    candidateGraph,
    previousInstalled,
    candidateInstalled,
    retirePrevious,
    retireCandidate,
    resolveRetirement,
    settle,
  };
}

describe('frame recording attempt settlement', () => {
  it.each([
    true,
    false,
  ])('stashes a preparing graph without promoting a barrier (queueSubmitted=%s)', (queueSubmitted) => {
    const f = fixture();
    f.settle(queueSubmitted, false);
    expect(f.state.compiledFrameGraph).toBe(f.previousInstalled);
    expect(f.state.graphGeneration).toBe(7);
    expect(f.state.standardLightingGraphSignature).toBe('accepted');
    expect(f.state.unsubmittedCompiledFrameGraph).toMatchObject({
      installed: f.candidateInstalled,
    });
    expect(f.retirePrevious).not.toHaveBeenCalled();
    expect(f.retireCandidate).not.toHaveBeenCalled();
  });

  it('promotes only an accepted scene and retires LKG on its retirement fence', async () => {
    const f = fixture();
    f.settle(true, false);
    expect(f.state.compiledFrameGraph).toBe(f.previousInstalled);
    f.state.pipelinePreparationPending = false;
    f.state.compiledFrameGraphCandidate = {
      graph: f.candidateGraph,
      previous: f.previous,
    } as never;
    f.state.compiledFrameGraph = f.candidateInstalled as never;
    f.state.graphGeneration = 8;
    f.state.standardLightingGraphSignature = 'candidate';
    f.settle(true, true);
    expect(f.state.compiledFrameGraphCandidate).toBeUndefined();
    expect(f.state.unsubmittedCompiledFrameGraph).toBeUndefined();
    expect(f.state.compiledFrameGraph).toBe(f.candidateInstalled);
    expect(f.retirePrevious).toHaveBeenCalledOnce();
    expect(f.state.retiredCompiledFrameGraphs.has(f.previousGraph as never)).toBe(true);
    f.resolveRetirement({ ok: true, value: undefined });
    await Promise.resolve();
    expect(f.state.retiredCompiledFrameGraphs.has(f.previousGraph as never)).toBe(false);
    expect(f.retireCandidate).not.toHaveBeenCalled();
  });

  it('discards unsubmitted resample resources when a recording exits early', () => {
    const f = fixture();
    const attempt = createFrameRecordingAttempt(undefined);
    const discard = vi.fn();
    attempt.lightTextureResamples.push({ work: { discard }, onSubmitted: vi.fn() } as never);
    releaseFrameRecordingAttempt(f.internals as never, f.state, attempt, {} as never, undefined);
    expect(discard).toHaveBeenCalledOnce();
    expect(attempt.lightTextureResamples).toHaveLength(0);
    expect(f.state.compiledFrameGraph).toBe(f.candidateInstalled);
    expect(f.retirePrevious).not.toHaveBeenCalled();
  });
});
