import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { RecordAttempt } from '../../render-system-record-attempt';
import { RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM } from '../capture-graph-systems';
import { RENDER_DISPLAY_DISCARD_SYSTEM } from '../display-submission-systems';
import { RENDER_FEATURE_GRAPH_RETIRE_SYSTEM } from '../feature-graph-systems';
import { RENDER_GRAPH_SEAL_RELEASE_SYSTEM } from '../graph-seal-systems';
import { RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM } from '../graph-submission-systems';
import { RENDER_GRAPH_COMPILE_RELEASE_SYSTEM } from '../graph-systems';
import { RENDER_POST_CLEANUP_SYSTEM } from '../post-systems';
import { adoptViewRecordHistory, viewRecordHistory } from '../record-history';
import { RenderView, ViewRecorder, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCleanup,
  RenderCommit,
} from '../render-world';
import {
  RENDER_RECORD_COMMIT_SYSTEM,
  RENDER_RECORD_RETIRE_SYSTEM,
  RENDER_SUBMISSION_RETIRE_SYSTEM,
  registerSubmissionSystems,
  retireAfterSubmission,
} from '../submission-systems';
import { RENDER_TEMPORAL_DISCARD_SYSTEM } from '../temporal-systems';
import { RENDER_SETTLEMENT_CLEANUP_SYSTEMS } from '../view-settlement';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

function accept(world: World, accepted: boolean): void {
  publishRenderSubmission(world, {
    accepted,
    completion: undefined,
    creditCompletion: undefined,
    generation: 7,
  });
}

/**
 * One recording view: a ViewRecorder whose owner is a fake scene, frame state
 * and error registry, its ViewSubmission and ViewRecordHistory. `stage` stages
 * an attempt the way the recording's `finally` does.
 */
function recordedView(options: { readonly pipeline?: boolean } = {}) {
  // Only the submission lifecycle runs: the other per-view settlement systems
  // would read the real owner this fake stands for.
  const world = new World();
  registerSubmissionSystems(world);
  const order: string[] = [];
  const owner = {
    frameState: {
      pipelinePreparationPending: false,
      compiledFrameGraph: options.pipeline === false ? null : {},
      frameOutputs: { directionalShadowView: null },
    },
    internals: {
      errorRegistry: { fire: vi.fn() },
      getPipelineState: () => (options.pipeline === false ? null : {}),
      gpuStore: {},
    },
    scene: {
      temporalStaged: true,
      commitTemporalFrame: (ready: boolean) => {
        order.push(`temporal-commit:${ready}`);
        return { ok: true };
      },
      discardTemporalFrame: () => order.push('temporal-discard'),
    } as Record<string, unknown>,
  };
  const state = world.allocUniqueRef('ViewRecorder', { owner });
  const view = world
    .spawn(
      { component: RenderView, data: {} },
      { component: ViewRecorder, data: { state } },
      {
        component: ViewSubmission,
        data: { accepted: true, attempt: 1, scene: true, temporal: false },
      },
    )
    .unwrap();
  adoptViewRecordHistory(world, view);
  const history = viewRecordHistory(world, view) as NonNullable<
    ReturnType<typeof viewRecordHistory>
  >;
  const stage = (input: {
    readonly frame: number;
    readonly accepted: boolean;
    readonly submitted?: boolean;
    readonly cameraCount?: number;
    readonly profile?: string;
    readonly failure?: unknown;
  }): RecordAttempt => {
    const submitted = input.submitted ?? true;
    const attempt = {
      scopes: [],
      composition: { owners: { resourceOwner: 0 } },
      profileSession: { endFrame: () => order.push(`end-frame:${input.profile ?? 'attempt'}`) },
      submitted,
      sceneSubmitted: submitted,
      outcome: submitted
        ? {
            frame: {},
            lights: { pointShadow: [], spot: [] },
            cameraCount: input.cameraCount ?? 0,
            presentation: { presentation: 'ready', reason: undefined },
            presentationRenderables: [],
            worldKeys: [],
            draws: {
              presentedDraws: {},
              drawObservation: { commit: () => ({ status: 'complete', draws: [] }) },
            },
          }
        : undefined,
    } as unknown as RecordAttempt;
    if (input.accepted)
      world.set(view, ViewSubmission, {
        accepted: true,
        attempt: input.frame,
        scene: true,
        temporal: false,
      });
    history.stage({
      frame: input.frame,
      generation: 7,
      attempt,
      accepted: input.accepted,
      failure: input.failure,
      ownsProfileFrame: true,
    });
    return attempt;
  };
  return { world, view, owner, history, stage, order };
}

function queue() {
  const work = deferred();
  return { work, queue: { onSubmittedWorkDone: vi.fn(() => work.promise) } };
}

describe('Render submission lifecycle', () => {
  it('schedules record commit/retire and the completion retirement with their data', () => {
    const data = createRenderWorld().scheduleData();
    const commit = data.find((schedule) => schedule.name === 'RenderCommit');
    const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
    expect(commit?.systems.map((system) => system.name)).toContain(RENDER_RECORD_COMMIT_SYSTEM);
    const recordCommit = commit?.systems.find(({ name }) => name === RENDER_RECORD_COMMIT_SYSTEM);
    expect(recordCommit?.queries[0]?.write).toEqual(['ViewSubmission']);
    expect(recordCommit?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewRecordHistory']);
    expect(recordCommit?.queries[0]?.optional).toEqual(['ViewDraws']);
    // The first RenderCommit root: no other commit has run when it verifies.
    expect(commit?.systems[0]?.name).toBe(RENDER_RECORD_COMMIT_SYSTEM);
    const recordRetire = cleanup?.systems.find(({ name }) => name === RENDER_RECORD_RETIRE_SYSTEM);
    expect(recordRetire?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewRecordHistory']);
    expect(cleanup?.systems.map((system) => system.name)).toEqual([
      RENDER_RECORD_RETIRE_SYSTEM,
      RENDER_SUBMISSION_RETIRE_SYSTEM,
      RENDER_POST_CLEANUP_SYSTEM,
      RENDER_TEMPORAL_DISCARD_SYSTEM,
      ...RENDER_SETTLEMENT_CLEANUP_SYSTEMS,
      RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
      RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM,
      RENDER_GRAPH_SEAL_RELEASE_SYSTEM,
      RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM,
      RENDER_DISPLAY_DISCARD_SYSTEM,
      RENDER_FEATURE_GRAPH_RETIRE_SYSTEM,
      'render-view-record-abandon',
      'render-view-record-release',
    ]);
    expect(cleanup?.dependencies).toContainEqual([
      RENDER_RECORD_RETIRE_SYSTEM,
      RENDER_SUBMISSION_RETIRE_SYSTEM,
    ]);
  });

  it('commits an accepted attempt before consumers and retires every attempt once', () => {
    const { world, view, owner, history, stage, order } = recordedView();
    world
      .addSystem(RenderCommit, {
        name: 'consumer',
        queries: [{ read: [ViewSubmission] }],
        after: [RENDER_RECORD_COMMIT_SYSTEM],
        fn: (_world, [rows]) => {
          for (const row of rows) order.push(`consumer:${row.get(ViewSubmission).temporal}`);
        },
      })
      .unwrap();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: true, profile: 'display' });
    stage({ frame: 1, accepted: false, profile: 'rejected' });
    stage({ frame: 0, accepted: true, profile: 'stale' });
    accept(world, true);
    endRenderFrame(world);
    expect(order).toEqual([
      'temporal-commit:true',
      'consumer:true',
      'end-frame:display',
      'temporal-discard',
      'end-frame:rejected',
      'end-frame:stale',
    ]);
    expect(history.submittedFrames).toBe(1);
    expect(history.lastGeneration).toBe(7);
    expect(history.presentation).toBe('ready');
    expect(history.materialDraws.status).toBe('complete');
    expect(history.directionalShadow.candidate).toBe('accepted');
    expect(world.get(view, ViewSubmission).unwrap().temporal).toBe(true);
    expect(owner.internals.errorRegistry.fire).not.toHaveBeenCalled();
    // Retired attempts never commit or retire again.
    order.length = 0;
    beginRenderFrame(world, 2);
    endRenderFrame(world);
    expect(order.filter((step) => !step.startsWith('consumer'))).toEqual([]);
    expect(history.submittedFrames).toBe(1);
  });

  it('verifies the submitted presentation in RenderCommit, not at record time', () => {
    const { world, history, stage } = recordedView({ pipeline: false });
    beginRenderFrame(world, 1);
    const attempt = stage({ frame: 1, accepted: true, cameraCount: 1 });
    // The recording leaves its candidate unverified.
    expect(attempt.outcome?.presentation.presentation).toBe('ready');
    accept(world, true);
    endRenderFrame(world);
    expect(history.presentation).toBe('pending');
    expect(history.pendingReason).toEqual({ code: 'compiled-graph-unavailable' });
  });

  it('a failed submit retires its attempt without committing history', () => {
    const { world, history, stage, order } = recordedView();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: false, submitted: false });
    accept(world, false);
    endRenderFrame(world);
    expect(history.submittedFrames).toBe(0);
    expect(history.presentation).toBe('pending');
    expect(order).toEqual(['temporal-discard', 'end-frame:attempt']);
  });

  it('a queue-accepted submit with a pending Feature scene input commits no history', () => {
    const { world, view, history, stage, order } = recordedView();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: true });
    // The queue accepted the work (a completion exists) but a Feature scene input was not ready.
    publishRenderSubmission(world, {
      accepted: false,
      completion: Promise.resolve(),
      creditCompletion: undefined,
      generation: 7,
    });
    endRenderFrame(world);
    expect(history.submittedFrames).toBe(0);
    expect(order).toEqual(['end-frame:attempt']);
    expect(world.get(view, ViewSubmission).unwrap().temporal).toBe(false);
  });

  it('reports commit and retirement failures with closed codes and never throws', () => {
    const { world, owner, stage } = recordedView();
    owner.scene.commitTemporalFrame = () => {
      throw new Error('commit');
    };
    owner.scene.discardTemporalFrame = () => {
      throw new Error('discard');
    };
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: true });
    stage({ frame: 1, accepted: false, failure: new Error('record') });
    accept(world, true);
    expect(() => endRenderFrame(world)).not.toThrow();
    const codes = owner.internals.errorRegistry.fire.mock.calls.map(
      ([error]) => (error as { code: string }).code,
    );
    expect(codes).toEqual(['webgpu-runtime-error', 'internal-error']);
  });

  it('closes only an open frame: a frame entry may close one that never opened', () => {
    const { world, stage, order } = recordedView();
    stage({ frame: 0, accepted: false });
    endRenderFrame(world);
    expect(order).toEqual([]);
  });

  it('without the commit system an accepted attempt publishes nothing', () => {
    const { world, history, stage, order } = recordedView();
    world.removeSystem(RenderCommit, RENDER_RECORD_COMMIT_SYSTEM).unwrap();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: true });
    accept(world, true);
    endRenderFrame(world);
    expect(history.submittedFrames).toBe(0);
    expect(history.presentation).toBe('pending');
    expect(history.directionalShadow.candidate).toBe('failed');
    expect(order).toEqual(['end-frame:attempt']);
  });

  it('without the retire system a staged attempt never ends its profiler frame', () => {
    const { world, history, stage, order } = recordedView();
    world.removeSystem(RenderCleanup, RENDER_RECORD_RETIRE_SYSTEM).unwrap();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: false });
    accept(world, false);
    endRenderFrame(world);
    expect(order).toEqual([]);
    expect(history.staged).toHaveLength(1);
  });

  it('releases a retirement only after the frame completion of its generation', async () => {
    const world = createRenderWorld();
    const frameCompletion = deferred();
    const own = queue();
    const release = vi.fn();
    beginRenderFrame(world, 1);
    retireAfterSubmission(world, { generation: 3, queue: own.queue, release });
    publishRenderSubmission(world, {
      accepted: true,
      completion: frameCompletion.promise,
      creditCompletion: undefined,
      generation: 3,
    });
    endRenderFrame(world);
    // The completion is the frame's own fence, not a fresh queue fence.
    expect(own.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    await flush();
    expect(release).not.toHaveBeenCalled();
    frameCompletion.resolve();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a retirement from a lost device generation waits for its own queue', async () => {
    const world = createRenderWorld();
    const frameCompletion = deferred();
    const lost = queue();
    const release = vi.fn();
    beginRenderFrame(world, 1);
    retireAfterSubmission(world, { generation: 1, queue: lost.queue, release });
    publishRenderSubmission(world, {
      accepted: true,
      completion: frameCompletion.promise,
      creditCompletion: undefined,
      generation: 2,
    });
    endRenderFrame(world);
    expect(lost.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    frameCompletion.resolve();
    await flush();
    expect(release).not.toHaveBeenCalled();
    lost.work.resolve();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a retirement during a rejected frame, or outside any frame, waits for its own queue', async () => {
    const world = createRenderWorld();
    const inFrame = queue();
    const outside = queue();
    const released: string[] = [];
    beginRenderFrame(world, 1);
    retireAfterSubmission(world, {
      generation: 0,
      queue: inFrame.queue,
      release: () => released.push('in-frame'),
    });
    // The view retired mid-flight; its work completes only with the queue.
    expect(inFrame.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    endRenderFrame(world);
    expect(inFrame.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    retireAfterSubmission(world, {
      generation: 0,
      queue: outside.queue,
      release: () => released.push('outside'),
    });
    expect(outside.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    await flush();
    expect(released).toEqual([]);
    outside.work.resolve();
    inFrame.work.resolve();
    await flush();
    expect(released.sort()).toEqual(['in-frame', 'outside']);
  });

  it('without the retire system an in-frame retirement is never released', async () => {
    const world = createRenderWorld();
    world.removeSystem(RenderCleanup, RENDER_SUBMISSION_RETIRE_SYSTEM).unwrap();
    const release = vi.fn();
    beginRenderFrame(world, 1);
    retireAfterSubmission(world, {
      generation: 0,
      queue: { onSubmittedWorkDone: () => Promise.resolve() },
      release,
    });
    endRenderFrame(world);
    await flush();
    expect(release).not.toHaveBeenCalled();
  });
});
