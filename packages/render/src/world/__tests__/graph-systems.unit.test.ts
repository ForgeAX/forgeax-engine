import { defineSystem, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { type ViewFeatureWork, viewFeaturesOf } from '../../features/view-feature-work';
import type { RenderFrameState } from '../../record/frame-snapshot';
import { MaterialBgAssemblyCache } from '../../record/material-bg-assembly-cache';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  commitFeatureCandidate,
  type RenderFeatureGraphCandidate,
} from '../../record/typed-frame-graph';
import { RENDER_GRAPH_SETTLE_SYSTEM, registerGraphSystems } from '../graph-systems';
import { RenderView, ViewRecorder, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCommit,
} from '../render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from '../submission-systems';

function fakeGraph(label: string) {
  return {
    label,
    inspect: () => ({ resources: [], resourceAllocation: undefined }),
    retire: vi.fn(async () => ({ ok: true })),
  };
}

/**
 * One recording view whose frame state adopted `next` over `accepted` this
 * frame (the staged graph candidate `installAdoptedGraph` leaves) and whose
 * Feature state committed `plans` over the accepted plans.
 */
function adoptedView(beforeRegister?: (world: World) => void) {
  const world = new World();
  beforeRegister?.(world);
  registerGraphSystems(world);
  const accepted = fakeGraph('accepted');
  const next = fakeGraph('next');
  const acceptedInstall = {
    graph: accepted,
    standardLighting: 'current',
    targets: { graphGeneration: 1 },
  };
  const nextInstall = { graph: next, targets: { graphGeneration: 2 } };
  const frameState = {
    frameNumber: 7,
    compiledFrameGraph: nextInstall,
    graphGeneration: 2,
    compiledFrameGraphCandidate: {
      installed: nextInstall,
      previous: {
        installed: acceptedInstall,
        graphGeneration: 1,
      },
    },
    retiredCompiledFrameGraphs: new Set(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    meshBindGroupCache: new WeakMap(),
    pipelinePreparationPending: false,
  } as unknown as RenderFrameState;
  const errorRegistry = { fire: vi.fn() };
  const internals = { errorRegistry } as unknown as RenderSystemInternals;
  const acceptedPlans = [{ plan: { passes: [] }, featureIdentity: 'accepted' }];
  const acceptedFeature = {
    ...viewFeaturesOf(frameState),
    work: {
      plans: acceptedPlans,
      executions: [{ featureIdentity: 'accepted' }],
      atomic: undefined,
    } as unknown as ViewFeatureWork,
  };
  frameState.viewFeatures = acceptedFeature;
  const candidatePlans = [{ plan: { passes: [] }, featureIdentity: 'candidate' }];
  const candidateWork = {
    plans: candidatePlans,
    executions: [{ featureIdentity: 'candidate' }],
    atomic: undefined,
  } as unknown as ViewFeatureWork;
  commitFeatureCandidate(
    internals,
    frameState,
    {
      plans: candidateWork.plans,
      fullscreenEffects: new Map(),
      postProcessIdentities: ['candidate'],
    } as RenderFeatureGraphCandidate,
    candidateWork,
  );
  const state = world.allocUniqueRef('ViewRecorder', { owner: { frameState, internals } });
  const view = world
    .spawn(
      { component: RenderView, data: {} },
      { component: ViewRecorder, data: { state } },
      {
        component: ViewSubmission,
        data: { accepted: true, attempt: 3, scene: true, temporal: false },
      },
    )
    .unwrap();
  const settle = (renderAccepted: boolean, attempt = 3, scene = true) => {
    beginRenderFrame(world, 3);
    world.set(view, ViewSubmission, { accepted: true, attempt, scene, temporal: false });
    publishRenderSubmission(world, {
      accepted: renderAccepted,
      completion: undefined,
      creditCompletion: undefined,
      generation: 1,
    });
    endRenderFrame(world);
  };
  return {
    world,
    frameState,
    internals,
    errorRegistry,
    accepted,
    acceptedInstall,
    next,
    acceptedFeature,
    candidateWork,
    settle,
  };
}

describe('render-graph-settle system', () => {
  it('runs first in RenderCommit, reading the view submission', () => {
    const commit = createRenderWorld()
      .scheduleData()
      .find((schedule) => schedule.name === 'RenderCommit');
    const settle = commit?.systems.find((system) => system.name === RENDER_GRAPH_SETTLE_SYSTEM);
    expect(settle?.before).toContain('RenderCommit');
    expect(settle?.queries[0]).toMatchObject({
      read: ['ViewRecorder', 'ViewSubmission'],
    });
    expect(commit?.systems.some((system) => system.name === RENDER_RECORD_COMMIT_SYSTEM)).toBe(
      true,
    );
  });

  it('promotes an accepted view graph before any other commit and advances frameNumber', () => {
    const seen: unknown[] = [];
    let frameState: RenderFrameState | undefined;
    // Registered first, so only the schedule-level `before` orders the settle ahead of it.
    const view = adoptedView((world) =>
      world
        .addSystem(
          RenderCommit,
          defineSystem({
            name: 'probe-commit',
            queries: [],
            fn: () => seen.push(frameState?.compiledFrameGraphCandidate),
          }),
        )
        .unwrap(),
    );
    frameState = view.frameState;
    view.settle(true);
    expect(seen).toEqual([undefined]);
    expect(view.frameState.compiledFrameGraph?.graph).toBe(view.next);
    expect(view.frameState.graphGeneration).toBe(2);
    expect(view.accepted.retire).toHaveBeenCalledOnce();
    expect(view.next.retire).not.toHaveBeenCalled();
    expect(view.frameState.frameNumber).toBe(8);
    expect(viewFeaturesOf(view.frameState).work).toBe(view.candidateWork);
    expect(view.frameState.previousViewFeatures).toBeUndefined();
  });

  it('stashes an unencoded graph when a queue-accepted preparation barrier has no scene submission', () => {
    const view = adoptedView();
    view.frameState.pipelinePreparationPending = true;
    view.settle(true, 3, false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.graphGeneration).toBe(1);
    expect(view.frameState.unsubmittedCompiledFrameGraph?.graph).toBe(view.next);
    expect(view.accepted.retire).not.toHaveBeenCalled();
    expect(view.next.retire).not.toHaveBeenCalled();
    expect(viewFeaturesOf(view.frameState)).toBe(view.acceptedFeature);
  });

  it('rolls back the graph and Feature state of a queue-accepted view while scene inputs are pending', () => {
    const view = adoptedView();
    // The view submitted, but the Renderer frame was not accepted.
    view.settle(false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.graphGeneration).toBe(1);
    expect(view.frameState.compiledFrameGraph?.standardLighting).toBe('current');
    expect(view.next.retire).toHaveBeenCalledOnce();
    expect(view.accepted.retire).not.toHaveBeenCalled();
    const feature = viewFeaturesOf(view.frameState);
    expect(feature).toBe(view.acceptedFeature);
    expect(feature.work.executions).toBe(view.acceptedFeature.work.executions);
    expect(feature.postProcessIdentities).toEqual([]);
    expect(view.frameState.previousViewFeatures).toBeUndefined();
    expect(view.frameState.frameNumber).toBe(8);
  });

  it('stashes a rejected candidate that waits on pipeline preparation', () => {
    const view = adoptedView();
    view.frameState.pipelinePreparationPending = true;
    view.settle(false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.unsubmittedCompiledFrameGraph?.graph).toBe(view.next);
    expect(view.next.retire).not.toHaveBeenCalled();
  });

  it('leaves a view that did not record this frame untouched', () => {
    const view = adoptedView();
    view.settle(true, 2);
    expect(view.frameState.compiledFrameGraphCandidate).toBeDefined();
    expect(view.frameState.frameNumber).toBe(7);
  });

  it('reports a thrown settlement without poisoning the World', () => {
    const view = adoptedView();
    const cause = new Error('settle exploded');
    Object.defineProperty(view.frameState, 'compiledFrameGraphCandidate', {
      get: () => {
        throw cause;
      },
    });
    expect(() => view.settle(true)).not.toThrow();
    expect(view.errorRegistry.fire).toHaveBeenCalledOnce();
    expect(view.frameState.frameNumber).toBe(8);
    view.settle(true);
    expect(view.frameState.frameNumber).toBe(9);
  });
});
