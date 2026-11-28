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
import { MaterialBgAssemblyCache } from '../material-bg-assembly-cache';

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
  const previousInstalled = { graph: previousGraph, standardLighting: 'current' };
  const candidateInstalled = { graph: candidateGraph, standardLighting: 'missing' };
  const previous = {
    installed: previousInstalled,
    graphGeneration: 7,
  };
  const state = {
    frameNumber: 0,
    pipelinePreparationPending: true,
    compiledFrameGraphCandidate: { installed: candidateInstalled, previous },
    compiledFrameGraph: candidateInstalled,
    graphGeneration: 8,
    retiredCompiledFrameGraphs: new Set(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    meshBindGroupCache: new WeakMap(),
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
    expect(f.state.compiledFrameGraph?.standardLighting).toBe('current');
    expect(f.state.unsubmittedCompiledFrameGraph).toBe(f.candidateInstalled);
    expect(f.retirePrevious).not.toHaveBeenCalled();
    expect(f.retireCandidate).not.toHaveBeenCalled();
  });

  it('promotes only an accepted scene and retires LKG on its retirement fence', async () => {
    const f = fixture();
    f.settle(true, false);
    expect(f.state.compiledFrameGraph).toBe(f.previousInstalled);
    f.state.pipelinePreparationPending = false;
    f.state.compiledFrameGraphCandidate = {
      installed: f.candidateInstalled,
      previous: f.previous,
    } as never;
    f.state.compiledFrameGraph = f.candidateInstalled as never;
    f.state.graphGeneration = 8;
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
