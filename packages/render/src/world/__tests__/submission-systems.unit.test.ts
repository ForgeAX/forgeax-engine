import { type EntityHandle, World } from '@forgeax/engine-ecs';
import type { TextureView } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyFrameRecordingOutputs,
  resetFrameRecordingOutputs,
} from '../../record/frame-snapshot';
import type { RecordAttempt } from '../../render-system-record-attempt';
import { ShadowDepthLayers } from '../../shadow-depth-layers';
import { viewDirectionalShadow } from '../../view-inspection';
import { RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM } from '../capture-graph-systems';
import { RENDER_DISPLAY_DISCARD_SYSTEM } from '../display-submission-systems';
import { RENDER_FEATURE_GRAPH_RETIRE_SYSTEM } from '../feature-graph-systems';
import { RENDER_GRAPH_SEAL_RELEASE_SYSTEM } from '../graph-seal-systems';
import { RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM } from '../graph-submission-systems';
import { RENDER_GRAPH_COMPILE_RELEASE_SYSTEM } from '../graph-systems';
import { RENDER_POST_CLEANUP_SYSTEM } from '../post-systems';
import { adoptViewRecordHistory, viewRecordHistory } from '../record-history';
import { ViewCascadeFit } from '../render-lights';
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
import type { ViewSettlementOwner } from '../view-settlement';
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
function recordedView(
  options: {
    readonly pipeline?: boolean;
    readonly shadow?: { readonly layers: ShadowDepthLayers; readonly view: TextureView };
  } = {},
) {
  // Only the submission lifecycle runs: the other per-view settlement systems
  // would read the real owner this fake stands for.
  const world = new World();
  registerSubmissionSystems(world);
  const order: string[] = [];
  const lights = {
    pointShadow: [],
    spot: [],
    ...(options.shadow === undefined
      ? {}
      : {
          cascades: {
            directionalShadowQuality: { kind: 'pcf-vogel' as const },
            cascadeCount: 3,
            lightViewProj: [new Float32Array(16), new Float32Array(16), new Float32Array(16)],
          },
        }),
  };
  const graph = {
    targets: { graphGeneration: 8 },
    graph: {
      inspect: vi.fn(() => ({
        passes: [
          { name: 'shadowCascade0' },
          { name: 'shadowCascade1' },
          { name: 'shadowCascade2' },
        ],
      })),
    },
  };
  const owner = {
    frameState: {
      pipelinePreparationPending: false,
      compiledFrameGraph: options.pipeline === false ? null : graph,
      frameOutputs: {
        ...emptyFrameRecordingOutputs(),
        directionalShadowView: options.shadow?.view ?? null,
      },
      directionalShadowCache: null,
      shadowDepthLayers: options.shadow?.layers,
      graphGeneration: 8,
    },
    internals: {
      errorRegistry: { fire: vi.fn() },
      getPipelineState: () =>
        options.pipeline === false ? null : { perPassResources: { shadowMapSize: 32 } },
      deviceScope: { generation: 7 },
      observationFrameId: 41,
      renderWorld: world,
      viewEntity: undefined as EntityHandle | undefined,
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
  owner.internals.viewEntity = view;
  if (options.shadow !== undefined)
    world
      .addComponent(view, {
        component: ViewCascadeFit,
        data: { fit: world.allocUniqueRef('ViewCascadeFit', { lights }) },
      })
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
            lights,
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
  return { world, view, owner, history, stage, order, graph };
}

function queue() {
  const work = deferred();
  return { work, queue: { onSubmittedWorkDone: vi.fn(() => work.promise) } };
}

async function shadowRecordedView() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layers = new ShadowDepthLayers(device);
  layers.texture('directional-shadow-depth', 32, 3);
  for (let layer = 0; layer < 3; layer++) layers.rastered('directional-shadow-depth', layer);
  layers._commit();
  const fixture = recordedView({
    shadow: { layers, view: layers.view('directional-shadow-depth') },
  });
  const inspect = () => viewDirectionalShadow(fixture.owner as unknown as ViewSettlementOwner);
  beginRenderFrame(fixture.world, 1);
  fixture.stage({ frame: 1, accepted: true });
  accept(fixture.world, true);
  endRenderFrame(fixture.world);
  return { ...fixture, layers, inspect };
}

describe('Render submission lifecycle', () => {
  it('keeps settled receiver facts while the next attempt resets only recording outputs', async () => {
    const { owner, graph, layers, inspect } = await shadowRecordedView();
    try {
      // Publishing an attempt must not inspect/scan the graph on the draw hot path.
      expect(graph.graph.inspect).not.toHaveBeenCalled();
      const held = inspect();
      expect(held).toMatchObject({
        status: 'accepted',
        pixelEvidence: 'available',
        shadowMapBytes: 12288,
      });
      const heldJson = JSON.stringify(held);
      resetFrameRecordingOutputs(owner.frameState.frameOutputs);
      expect(inspect()).toEqual(held);
      expect(inspect()).toMatchObject({
        settlement: {
          scope: 'settled-view-record-attempt',
          renderAttempt: 1,
          observationFrameId: 41,
          submitted: true,
          sceneSubmitted: true,
          accepted: true,
        },
      });
      expect(Object.isFrozen(held)).toBe(true);
      expect(JSON.stringify(held)).toBe(heldJson);
    } finally {
      layers.dispose();
    }
  });

  it.each([
    ['preparation barrier', undefined],
    ['record failure', new Error('record failed')],
  ])('publishes rejected evidence for %s with no record outcome', async (_name, failure) => {
    const { world, owner, stage, layers, inspect } = await shadowRecordedView();
    try {
      const held = inspect();
      beginRenderFrame(world, 2);
      resetFrameRecordingOutputs(owner.frameState.frameOutputs);
      stage({ frame: 2, accepted: false, submitted: false, failure });
      accept(world, false);
      endRenderFrame(world);
      expect(inspect()).toMatchObject({
        status: 'rejected',
        pixelEvidence: 'not-available',
        shadowMapBytes: 0,
        settlement: { renderAttempt: 2, submitted: false, sceneSubmitted: false, accepted: false },
      });
      expect(held.status).toBe('accepted');
      expect(held.pixelEvidence).toBe('available');
    } finally {
      layers.dispose();
    }
  });

  it.each([
    'pending-outcome',
    'held-without-outcome',
    'scene-input-pending',
  ] as const)('settles %s preparation work without inventing a directional shadow failure', async (kind) => {
    const { world, owner, stage, layers, inspect } = await shadowRecordedView();
    try {
      const held = inspect();
      beginRenderFrame(world, 2);
      resetFrameRecordingOutputs(owner.frameState.frameOutputs);
      const accepted = kind !== 'scene-input-pending';
      const attempt = stage({ frame: 2, accepted });
      attempt.sceneSubmitted = false;
      if (attempt.outcome === undefined) throw new Error('Missing preparation outcome');
      attempt.outcome.presentation.presentation = 'pending';
      if (kind === 'held-without-outcome') attempt.outcome = undefined;
      accept(world, accepted);
      endRenderFrame(world);
      expect(inspect()).toMatchObject({
        status: 'rejected',
        pixelEvidence: 'not-available',
        shadowMapBytes: 0,
        settlement: { renderAttempt: 2, submitted: true, sceneSubmitted: false, accepted },
      });
      expect(inspect().error).toBeUndefined();
      expect(held.status).toBe('accepted');
    } finally {
      layers.dispose();
    }
  });

  it.each([
    'queue-rejected',
    'record-failed',
    'scene-submitted',
    'ready-without-scene',
    'light-invalid',
  ] as const)('retains directional shadow failure evidence for %s', async (kind) => {
    const { world, owner, stage, layers, inspect } = await shadowRecordedView();
    try {
      beginRenderFrame(world, 2);
      resetFrameRecordingOutputs(owner.frameState.frameOutputs);
      const accepted = kind !== 'queue-rejected';
      const attempt = stage({
        frame: 2,
        accepted,
        submitted: kind !== 'queue-rejected',
        ...(kind === 'record-failed' ? { failure: new Error('record failed') } : {}),
      });
      attempt.sceneSubmitted = kind === 'scene-submitted';
      const lightError = {
        code: 'shadow-invalid-config',
        expected: 'valid directional shadow configuration',
        hint: 'repair the light configuration',
      };
      if (attempt.outcome !== undefined) {
        if (kind === 'light-invalid')
          Object.assign(attempt.outcome.lights, { directionalShadowError: lightError });
        attempt.outcome.presentation.presentation =
          kind === 'ready-without-scene' ? 'ready' : 'pending';
      }
      accept(world, accepted);
      endRenderFrame(world);
      expect(inspect().error?.code).toBe(
        kind === 'light-invalid' ? lightError.code : 'directional-shadow-candidate-failed',
      );
    } finally {
      layers.dispose();
    }
  });

  it('publishes a failed recorded attempt and only a later successful attempt recovers it', async () => {
    const { world, stage, layers, inspect } = await shadowRecordedView();
    try {
      const held = inspect();
      beginRenderFrame(world, 2);
      stage({ frame: 2, accepted: false, failure: new Error('failed after recording') });
      accept(world, false);
      endRenderFrame(world);
      expect(inspect()).toMatchObject({
        status: 'rejected',
        pixelEvidence: 'not-available',
        settlement: { renderAttempt: 2 },
      });
      beginRenderFrame(world, 3);
      stage({ frame: 3, accepted: true });
      accept(world, true);
      endRenderFrame(world);
      expect(inspect()).toMatchObject({
        status: 'accepted',
        pixelEvidence: 'available',
        settlement: { renderAttempt: 3 },
      });
      expect(held.settlement?.renderAttempt).toBe(1);
    } finally {
      layers.dispose();
    }
  });

  it('invalidates resource loss or a different device generation without mutating held facts', async () => {
    const { owner, layers, inspect } = await shadowRecordedView();
    try {
      const held = inspect();
      layers.discard('directional-shadow-depth', 1);
      expect(inspect()).toMatchObject({ status: 'rejected', pixelEvidence: 'not-available' });
      layers.rastered('directional-shadow-depth', 1);
      layers._commit();
      expect(inspect().status).toBe('accepted');
      owner.internals.deviceScope.generation++;
      expect(inspect()).toMatchObject({ status: 'rejected', pixelEvidence: 'not-available' });
      owner.internals.deviceScope.generation--;
      layers.dispose();
      expect(inspect()).toMatchObject({ status: 'rejected', pixelEvidence: 'not-available' });
      expect(held).toMatchObject({
        status: 'accepted',
        pixelEvidence: 'available',
        deviceGeneration: 7,
      });
    } finally {
      layers.dispose();
    }
  });

  it('invalidates a settled receiver after a same-size allocation replacement, even when all layers become retained', async () => {
    const { layers, inspect } = await shadowRecordedView();
    try {
      const held = inspect();
      layers.texture('directional-shadow-depth', 64, 3);
      layers.texture('directional-shadow-depth', 32, 3);
      for (let layer = 0; layer < 3; layer++) layers.rastered('directional-shadow-depth', layer);
      layers._commit();
      expect(layers.byteSize('directional-shadow-depth')).toBe(held.shadowMapBytes);
      expect(inspect()).toMatchObject({
        status: 'rejected',
        pixelEvidence: 'not-available',
        shadowMapBytes: 0,
      });
      expect(held.status).toBe('accepted');
    } finally {
      layers.dispose();
    }
  });
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

  it('a submitted scene still pending pipeline preparation does not advance temporal history', () => {
    const { world, view, owner, history, stage, order } = recordedView();
    beginRenderFrame(world, 1);
    stage({ frame: 1, accepted: true });
    owner.frameState.pipelinePreparationPending = true;
    accept(world, true);
    endRenderFrame(world);
    expect(history.presentation).toBe('pending');
    expect(history.pendingReason).toEqual({ code: 'pipeline-preparation' });
    expect(order).toEqual(['temporal-discard', 'end-frame:attempt']);
    expect(world.get(view, ViewSubmission).unwrap().temporal).toBe(false);
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
