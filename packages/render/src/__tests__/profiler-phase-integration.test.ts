import { defineSystem, scheduleWorkNames } from '@forgeax/engine-ecs';
import { createProfiler, type ProfileFrameToken } from '@forgeax/engine-profiler';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { viewSharedFeatureGraphPassName } from '../features/frame-plan';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { graphExecutionProfilePhase } from '../record/frame-targets';
import { RENDER_PHASE_CATALOG } from '../render-contract';
import {
  addRenderFeatureSystem,
  renderFeatureAdmissionProfileWork,
  renderFeaturePlanProfileWork,
} from '../world/feature-systems';
import {
  renderSchedulePhaseCatalog,
  renderSystemInvocationPhase,
  renderSystemPhase,
  renderWorkPhase,
} from '../world/profiled-schedule-runs';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
} from '../world/render-world';

function start(profiler: ReturnType<typeof createProfiler>, detail: 'owner' | 'nested' = 'owner') {
  const result = profiler.startCapture({ frameLimit: 2, eventLimit: 16, detail });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function finish(profiler: ReturnType<typeof createProfiler>) {
  const session = profiler.activeSession();
  if (session === undefined) throw new Error('capture is not active');
  const result = session.finish();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('Render profiler phase integration', () => {
  it('publishes installed feature work names and releases them with the feature system', () => {
    const world = createRenderWorld();
    const workNames = [
      renderFeatureAdmissionProfileWork('water-profile-test'),
      renderFeaturePlanProfileWork('water-profile-test'),
      'water/render/mesh-owner-matching',
    ].sort();
    const release = addRenderFeatureSystem(world, 'water-profile-test', [
      'water/render/mesh-owner-matching',
    ]);

    expect(scheduleWorkNames(world)).toEqual(workNames);
    for (const name of workNames)
      expect(renderSchedulePhaseCatalog(world)).toContain(renderWorkPhase(name));

    release();
    expect(scheduleWorkNames(world)).toEqual([]);
    for (const name of workNames)
      expect(renderSchedulePhaseCatalog(world)).not.toContain(renderWorkPhase(name));
  });

  it('registers default and declared host work names and freezes their active capture catalog', () => {
    const world = createRenderWorld();
    const feature = (
      identity: string,
      profileWorkNames?: readonly string[],
    ): RenderFeature<undefined> => ({
      identity,
      ...(profileWorkNames === undefined ? {} : { profileWorkNames }),
      extract: () => ok(undefined),
      plan: () => ok({ work: [] }),
    });
    const omitted = feature('profile-omitted');
    const empty = feature('profile-empty', []);
    const extra = feature('profile-extra', ['water/render/mesh-owner-matching']);
    const host = createRenderFeatureHost([omitted, empty], world).unwrap();
    try {
      host.install(extra).unwrap();

      const expected = [
        ...['profile-omitted', 'profile-empty', 'profile-extra'].flatMap((identity) => [
          renderFeaturePlanProfileWork(identity),
          renderFeatureAdmissionProfileWork(identity),
        ]),
        'water/render/mesh-owner-matching',
      ].sort();
      expect(scheduleWorkNames(world)).toEqual(expected);
      for (const name of expected)
        expect(renderSchedulePhaseCatalog(world)).toContain(renderWorkPhase(name));

      const profiler = createProfiler();
      const registered = profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG, () =>
        renderSchedulePhaseCatalog(world),
      );
      expect(registered.ok).toBe(true);
      const session = start(profiler);
      const removedPhase = renderWorkPhase(renderFeaturePlanProfileWork('profile-empty'));
      expect(renderSchedulePhaseCatalog(world)).toContain(removedPhase);
      host.uninstall(empty).unwrap();
      expect(renderSchedulePhaseCatalog(world)).not.toContain(removedPhase);

      expect(session.beginFrame(1).ok).toBe(true);
      expect(session.beginPhase('render', removedPhase).ok).toBe(true);
      expect(session.endPhase().ok).toBe(true);
      expect(session.endFrame().ok).toBe(true);
      host.dispose().unwrap();

      expect(scheduleWorkNames(world)).toEqual([]);
      const capture = finish(profiler);
      expect(capture.phaseCatalog.render).toContain(removedPhase);
      expect(capture.records).toContainEqual(
        expect.objectContaining({ kind: 'phase', source: 'render', phase: removedPhase }),
      );
    } finally {
      host.dispose().unwrap();
    }
    expect(scheduleWorkNames(world)).toEqual([]);
  });

  it('admits exact shared graph passes for current scopes and keeps an active capture frozen', () => {
    const world = createRenderWorld();
    let viewScopes = ['camera:live'];
    let passRoster = [
      {
        view: 'camera:live',
        name: viewSharedFeatureGraphPassName('camera:live', 'water-query-receiver-0'),
        kind: 'compute' as const,
      },
      {
        view: 'camera:live',
        name: viewSharedFeatureGraphPassName('camera:live', 'water-query-sample'),
        kind: 'compute' as const,
      },
      {
        view: 'camera:live',
        name: viewSharedFeatureGraphPassName('camera:live', 'water-query-readback'),
        kind: 'copy' as const,
      },
    ];
    const feature: RenderFeature<undefined> = {
      identity: 'profile-conditional-passes',
      extract: () => ok(undefined),
      plan: () => ok({ work: [] }),
      profileGraphPasses: () => passRoster,
    };
    const host = createRenderFeatureHost([feature], world).unwrap();
    const profiler = createProfiler();
    const registered = profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG, () => [
      ...renderSchedulePhaseCatalog(world),
      ...host
        .profileGraphPasses(viewScopes)
        .map(({ view: _view, ...pass }) => graphExecutionProfilePhase({ owner: 'shared', pass })),
    ]);
    expect(registered.ok).toBe(true);
    const receiverPhase = graphExecutionProfilePhase({
      owner: 'shared',
      pass: {
        name: viewSharedFeatureGraphPassName('camera:live', 'water-query-receiver-0'),
        kind: 'compute',
      },
    });
    const readbackPhase = graphExecutionProfilePhase({
      owner: 'shared',
      pass: {
        name: viewSharedFeatureGraphPassName('camera:live', 'water-query-readback'),
        kind: 'copy',
      },
    });

    // The query branch has not run; its bounded owner declaration still admits its exact names.
    const active = start(profiler);
    expect(active.beginFrame(1).ok).toBe(true);
    host.uninstall(feature).unwrap();
    expect(active.beginPhase('render', receiverPhase).ok).toBe(true);
    expect(active.endPhase().ok).toBe(true);
    expect(active.beginPhase('render', readbackPhase).ok).toBe(true);
    expect(active.endPhase().ok).toBe(true);
    expect(active.endFrame().ok).toBe(true);
    expect(finish(profiler).phaseCatalog.render).toContain(receiverPhase);

    const replacement: RenderFeature<undefined> = {
      identity: 'profile-conditional-passes-replacement',
      extract: () => ok(undefined),
      plan: () => ok({ work: [] }),
      profileGraphPasses: () => passRoster,
    };
    host.install(replacement).unwrap();
    viewScopes = ['camera:replacement'];
    passRoster = [
      {
        view: 'camera:replacement',
        name: viewSharedFeatureGraphPassName('camera:replacement', 'water-query-receiver-0-new'),
        kind: 'compute',
      },
    ];
    const replacementPhase = graphExecutionProfilePhase({
      owner: 'shared',
      pass: {
        name: viewSharedFeatureGraphPassName('camera:replacement', 'water-query-receiver-0-new'),
        kind: 'compute',
      },
    });
    const replacementCapture = start(profiler);
    expect(replacementCapture.beginFrame(1).ok).toBe(true);
    expect(replacementCapture.beginPhase('render', replacementPhase).ok).toBe(true);
    expect(replacementCapture.endPhase().ok).toBe(true);
    expect(replacementCapture.endFrame().ok).toBe(true);
    const replacementResult = finish(profiler);
    expect(replacementResult.phaseCatalog.render).toContain(replacementPhase);
    expect(replacementResult.phaseCatalog.render).not.toContain(receiverPhase);

    viewScopes = [];
    const expired = start(profiler);
    expect(expired.beginFrame(1).ok).toBe(true);
    expect(expired.endFrame().ok).toBe(true);
    expect(finish(profiler).phaseCatalog.render).not.toContain(replacementPhase);

    host.dispose().unwrap();
  });

  it('routes profile pass declaration failures through capture admission errors', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'profile-conditional-pass-failure',
      extract: () => ok(undefined),
      plan: () => ok({ work: [] }),
      profileGraphPasses: () => {
        throw new Error('owner roster unavailable');
      },
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const profiler = createProfiler();
    profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG, () =>
      host
        .profileGraphPasses(['camera:live'])
        .map(({ view: _view, ...pass }) => graphExecutionProfilePhase({ owner: 'shared', pass })),
    );

    const started = profiler.startCapture({ frameLimit: 2, eventLimit: 16, detail: 'owner' });
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error('capture should reject a failed pass declaration owner');
    expect(started.error).toMatchObject({
      code: 'phase-catalog-provider-failed',
      detail: { source: 'render', message: 'owner roster unavailable' },
    });
    host.dispose().unwrap();
  });

  it('joins an App token to a Render-only frame without a second capture', () => {
    const profiler = createProfiler({
      phaseCatalog: { app: ['frame-total'], render: RENDER_PHASE_CATALOG },
    });
    const session = start(profiler);
    const token: ProfileFrameToken = { captureId: session.captureId, frameId: 1 };

    expect(session.beginFrame(token.frameId).ok).toBe(true);
    expect(session.beginPhase({ source: 'app', phase: 'frame-total' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'extract' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(
      session.recordSkip({ source: 'render', phase: 'bind-groups', reason: 'no-render' }).ok,
    ).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'record' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    expect(capture.captureId).toBe(token.captureId);
    expect(capture.records.map((record) => record.frameId)).toEqual([1, 1, 1, 1]);
    const skip = capture.records.find((record) => record.kind === 'skip');
    expect(skip).toMatchObject({ phase: 'bind-groups', reason: 'no-render' });
    expect(skip && 'durationMicros' in skip).toBe(false);
  });

  it('retains direct Render-only frames with a new frame identity', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const session = start(profiler);

    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'record' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    expect(capture.phaseCatalog.app).toEqual([]);
    expect(capture.phaseCatalog.render).toEqual(RENDER_PHASE_CATALOG);
    expect(capture.records[0]).toMatchObject({ source: 'render', frameId: 1, phase: 'record' });
  });

  it('profiles the complete RenderPrepare schedule under the App draw phase', () => {
    let nowMicros = 0;
    const order: string[] = [];
    const profiler = createProfiler({
      clock: { nowMicros: () => nowMicros },
      phaseCatalog: { app: ['renderer-draw'], render: RENDER_PHASE_CATALOG },
    });
    const session = start(profiler);
    const world = createRenderWorld();
    world
      .addSystem(
        RenderExtract,
        defineSystem({
          commands: 'none',
          name: 'test-profile-extract-order',
          queries: [],
          fn: () => {
            order.push('extract');
            nowMicros += 3;
          },
        }),
      )
      .unwrap();
    world
      .addSystem(
        RenderPrepare,
        defineSystem({
          commands: 'none',
          name: 'test-profile-prepare-order',
          queries: [],
          fn: () => {
            order.push('prepare');
            nowMicros += 11;
          },
        }),
      )
      .unwrap();

    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase('app', 'renderer-draw').ok).toBe(true);
    beginRenderFrame(world, 1, session);
    expect(order).toEqual(['extract', 'prepare']);
    expect(session.endPhase().ok).toBe(true);
    endRenderFrame(world);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    const prepare = capture.records.find(
      (record) =>
        record.kind === 'phase' && record.source === 'render' && record.phase === 'prepare',
    );
    expect(prepare).toMatchObject({
      kind: 'phase',
      source: 'render',
      frameId: 1,
      phase: 'prepare',
      startMicros: 3,
      endMicros: 14,
      durationMicros: 11,
      parentSource: 'app',
      parentPhase: 'renderer-draw',
    });
  });

  it('runs RenderExtract and RenderPrepare in order without sampling when no session is passed', () => {
    let clockReads = 0;
    const order: string[] = [];
    const world = createRenderWorld();
    world
      .addSystem(
        RenderExtract,
        defineSystem({
          commands: 'none',
          name: 'test-unprofiled-extract-order',
          queries: [],
          fn: () => void order.push('extract'),
        }),
      )
      .unwrap();
    world
      .addSystem(
        RenderPrepare,
        defineSystem({
          commands: 'none',
          name: 'test-unprofiled-prepare-order',
          queries: [],
          fn: () => void order.push('prepare'),
        }),
      )
      .unwrap();
    const profiler = createProfiler({
      clock: {
        nowMicros() {
          clockReads += 1;
          return clockReads;
        },
      },
    });
    const session = profiler.activeSession();
    expect(session).toBeUndefined();

    beginRenderFrame(world, 1, session);
    endRenderFrame(world);

    expect(order).toEqual(['extract', 'prepare']);
    expect(clockReads).toBe(0);
  });

  it('keeps skip phases distinct across arbitrary ECS names', () => {
    expect(renderSystemPhase('a/system/b', 'c')).not.toBe(renderSystemPhase('a', 'b/system/c'));
    expect(renderWorkPhase('system/X')).not.toBe(renderSystemPhase('work', 'X'));
    expect(renderSystemPhase('work', 'X')).not.toBe(renderSystemInvocationPhase('work', 'X'));
  });

  it('retains a skipped system fact while its schedule phase remains open', () => {
    let nowMicros = 0;
    const world = createRenderWorld();
    world
      .addSystem(
        RenderExtract,
        defineSystem({
          commands: 'none',
          name: 'test-profile-skipped-system',
          queries: [],
          runIf: () => false,
          fn: () => {
            throw new Error('runIf=false system must not run');
          },
        }),
      )
      .unwrap();
    world
      .addSystem(
        RenderExtract,
        defineSystem({
          commands: 'none',
          name: 'test-profile-invoked-system',
          queries: [],
          fn: () => {
            nowMicros += 7;
          },
        }),
      )
      .unwrap();
    const profiler = createProfiler({
      clock: { nowMicros: () => nowMicros },
      phaseCatalog: {
        app: [],
        render: [...RENDER_PHASE_CATALOG, ...renderSchedulePhaseCatalog(world)],
      },
    });
    const session = start(profiler, 'nested');
    expect(session.beginFrame(1).ok).toBe(true);
    beginRenderFrame(world, 1, session);
    endRenderFrame(world);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    const skipped = capture.records.find(
      (record) =>
        record.kind === 'skip' &&
        record.phase === renderSystemPhase('RenderExtract', 'test-profile-skipped-system'),
    );
    expect(skipped).toMatchObject({
      kind: 'skip',
      source: 'render',
      frameId: 1,
      phase: renderSystemPhase('RenderExtract', 'test-profile-skipped-system'),
      reason: 'system-skipped',
    });
    expect(skipped && 'durationMicros' in skipped).toBe(false);
    const normalSystem = capture.records.find(
      (record) =>
        record.kind === 'phase' &&
        record.phase === renderSystemPhase('RenderExtract', 'test-profile-invoked-system'),
    );
    expect(normalSystem).toMatchObject({
      kind: 'phase',
      parentSource: 'render',
      parentPhase: 'extract-schedule',
    });
    const normalInvocation = capture.records.find(
      (record) =>
        record.kind === 'phase' &&
        record.phase ===
          renderSystemInvocationPhase('RenderExtract', 'test-profile-invoked-system'),
    );
    expect(normalInvocation).toMatchObject({
      kind: 'phase',
      parentSource: 'render',
      parentPhase: renderSystemPhase('RenderExtract', 'test-profile-invoked-system'),
    });
  });
});
