import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  commitFeatureCandidate,
  getRenderFeatureGraphState,
  type RenderFeatureGraphCandidate,
} from '../../record/typed-frame-graph';
import {
  RENDER_GRAPH_SETTLE_SYSTEM,
  registerGraphSystems,
  ViewGraphCandidate,
  type ViewGraphCandidateSlot,
} from '../graph-systems';
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
  const acceptedInstall = { graph: accepted, targets: { graphGeneration: 1 } };
  const frameState = {
    frameNumber: 7,
    compiledFrameGraph: { graph: next, targets: { graphGeneration: 2 } },
    graphGeneration: 2,
    compiledFrameGraphGeneration: 2,
    standardLightingGraphSignature: 'next',
    compiledFrameGraphCandidate: {
      graph: next,
      previous: {
        installed: acceptedInstall,
        graphGeneration: 1,
        compiledGeneration: 1,
        lightingSignature: 'accepted',
      },
    },
    retiredCompiledFrameGraphs: new Set(),
    pipelinePreparationPending: false,
  } as unknown as RenderFrameState;
  const errorRegistry = { fire: vi.fn() };
  const internals = { errorRegistry } as unknown as RenderSystemInternals;
  const acceptedPlans = [{ plan: { passes: [] }, featureIdentity: 'accepted' }];
  getRenderFeatureGraphState(internals).plans = acceptedPlans as never;
  const candidatePlans = [{ plan: { passes: [] }, featureIdentity: 'candidate' }];
  commitFeatureCandidate(internals, {
    plans: candidatePlans,
    fullscreenEffects: new Map(),
    postProcessIdentities: ['candidate'],
  } as unknown as RenderFeatureGraphCandidate);
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
  const settled = () =>
    world.hasComponent(view, ViewGraphCandidate)
      ? world
          .resolveUniqueRef<ViewGraphCandidateSlot>(
            world.get(view, ViewGraphCandidate).unwrap().state,
          )
          .unwrap().settled
      : undefined;
  return {
    world,
    frameState,
    internals,
    errorRegistry,
    accepted,
    acceptedInstall,
    next,
    acceptedPlans,
    candidatePlans,
    settle,
    settled,
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
      optional: ['ViewGraphCandidate'],
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
        .addSystem(RenderCommit, {
          name: 'probe-commit',
          queries: [],
          fn: () => seen.push(frameState?.compiledFrameGraphCandidate),
        })
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
    expect(getRenderFeatureGraphState(view.internals).plans).toBe(view.candidatePlans);
    expect(getRenderFeatureGraphState(view.internals).rollback).toBeUndefined();
    expect(view.settled()).toEqual({
      frame: 3,
      kind: 'settled',
      accepted: true,
      graph: 'promoted',
    });
  });

  it('stashes an unencoded graph when a queue-accepted preparation barrier has no scene submission', () => {
    const view = adoptedView();
    view.frameState.pipelinePreparationPending = true;
    view.settle(true, 3, false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.graphGeneration).toBe(1);
    expect(view.frameState.compiledFrameGraphGeneration).toBe(1);
    expect(view.frameState.unsubmittedCompiledFrameGraph?.installed.graph).toBe(view.next);
    expect(view.accepted.retire).not.toHaveBeenCalled();
    expect(view.next.retire).not.toHaveBeenCalled();
    expect(getRenderFeatureGraphState(view.internals).plans).toBe(view.acceptedPlans);
  });

  it('rolls back the graph and Feature state of a queue-accepted view while scene inputs are pending', () => {
    const view = adoptedView();
    // The view submitted, but the Renderer frame was not accepted.
    view.settle(false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.graphGeneration).toBe(1);
    expect(view.frameState.compiledFrameGraphGeneration).toBe(1);
    expect(view.frameState.standardLightingGraphSignature).toBe('accepted');
    expect(view.next.retire).toHaveBeenCalledOnce();
    expect(view.accepted.retire).not.toHaveBeenCalled();
    const feature = getRenderFeatureGraphState(view.internals);
    expect(feature.plans).toBe(view.acceptedPlans);
    expect(feature.postProcessIdentities).toEqual([]);
    expect(feature.rollback).toBeUndefined();
    expect(view.frameState.frameNumber).toBe(8);
    expect(view.settled()).toEqual({
      frame: 3,
      kind: 'settled',
      accepted: false,
      graph: 'rolled-back',
    });
  });

  it('stashes a rejected candidate that waits on pipeline preparation', () => {
    const view = adoptedView();
    view.frameState.pipelinePreparationPending = true;
    view.settle(false);
    expect(view.frameState.compiledFrameGraph).toBe(view.acceptedInstall);
    expect(view.frameState.unsubmittedCompiledFrameGraph?.installed.graph).toBe(view.next);
    expect(view.next.retire).not.toHaveBeenCalled();
    expect(view.settled()).toMatchObject({ kind: 'settled', graph: 'stashed' });
  });

  it('leaves a view that did not record this frame untouched', () => {
    const view = adoptedView();
    view.settle(true, 2);
    expect(view.frameState.compiledFrameGraphCandidate).toBeDefined();
    expect(view.frameState.frameNumber).toBe(7);
    expect(view.settled()).toBeUndefined();
  });

  it('stores a thrown settlement as data without poisoning the World', () => {
    const view = adoptedView();
    const cause = new Error('settle exploded');
    Object.defineProperty(view.frameState, 'compiledFrameGraphCandidate', {
      get: () => {
        throw cause;
      },
    });
    expect(() => view.settle(true)).not.toThrow();
    expect(view.settled()).toEqual({ frame: 3, kind: 'failed', cause });
    expect(view.errorRegistry.fire).toHaveBeenCalledOnce();
    expect(view.frameState.frameNumber).toBe(8);
    view.settle(true);
    expect(view.frameState.frameNumber).toBe(9);
  });
});
