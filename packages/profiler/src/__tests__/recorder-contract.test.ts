import { describe, expect, it } from 'vitest';
import { createProfiler } from '../profiler.js';

const TEST_PHASE_CATALOG = { app: ['frame-total'], render: ['record'] } as const;

function createClock() {
  let current = 1000;
  return {
    nowMicros() {
      current += 10;
      return current;
    },
  };
}

function expectOk<T>(result: { ok: boolean; value?: T; error?: { code: string } }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error?.code ?? 'unexpected profiler error');
  return result.value as T;
}

describe('bounded profiler recorder contract', () => {
  it('owns automatic frame identities across explicit and automatic callers', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 3, eventLimit: 4 }));
    expect(expectOk(session.beginFrame())).toEqual({ captureId: session.captureId, frameId: 1 });
    expect(session.beginFrame().ok).toBe(false);
    expectOk(session.beginPhase('render', 'record'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    expect(session.beginFrame(7)).toEqual({ ok: true, value: undefined });
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    expect(expectOk(session.beginFrame())).toEqual({ captureId: session.captureId, frameId: 8 });
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());
    expect(artifact.records.map((record) => record.frameId)).toEqual([1, 7, 8]);
    expect(artifact.completeness.status).toBe('complete');
  });

  it('does not wrap automatic identities beyond the safe integer boundary', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 2, eventLimit: 4 }));
    expectOk(session.beginFrame(Number.MAX_SAFE_INTEGER));
    expectOk(session.endFrame());
    expect(session.beginFrame().ok).toBe(false);
    expectOk(session.finish());
  });

  it('rejects invalid limits before entering an active capture', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });

    for (const limits of [
      { frameLimit: 0, eventLimit: 1 },
      { frameLimit: 1, eventLimit: 0 },
      { frameLimit: -1, eventLimit: 1 },
      { frameLimit: 1.5, eventLimit: 1 },
      { frameLimit: Number.POSITIVE_INFINITY, eventLimit: 1 },
    ]) {
      const result = profiler.startCapture(limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('capture-boundary-invalid');
    }
    expect(profiler.activeCaptureId()).toBeUndefined();
  });

  it('keeps one active capture and reports its identity on conflict', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 2, eventLimit: 4 }));
    const second = profiler.startCapture({ frameLimit: 2, eventLimit: 4 });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('capture-already-active');
      if (second.error.code === 'capture-already-active') {
        expect(second.error.detail.captureId).toBe(session.captureId);
      }
    }
    expect(profiler.activeCaptureId()).toBe(session.captureId);
  });

  it('pairs open phases and preserves a complete bounded artifact', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase({ source: 'app', phase: 'frame-total' }));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());

    expect(artifact.completeness.status).toBe('complete');
    expect(artifact.records).toHaveLength(1);
    expect(artifact.records[0]?.kind).toBe('phase');
  });

  it('defers capture event object materialization until finish', () => {
    const allocationReport = { profilerEventObjectAllocations: 0 };
    const profiler = createProfiler({
      clock: createClock(),
      phaseCatalog: TEST_PHASE_CATALOG,
      allocationReport,
    });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase({ source: 'app', phase: 'frame-total' }));
    expectOk(session.endPhase());
    expect(allocationReport.profilerEventObjectAllocations).toBe(0);
    expectOk(session.endFrame());
    expectOk(session.finish());
    expect(allocationReport.profilerEventObjectAllocations).toBe(1);
  });

  it('freezes the admitted phase catalog for a capture', () => {
    const profiler = createProfiler({ clock: createClock() });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app));
    expectOk(session.beginFrame(1));
    expect(session.beginPhase('app', 'frame-total').ok).toBe(false);
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());

    expect(artifact.phaseCatalog.app).toEqual([]);
    expect(artifact.records).toHaveLength(0);
    expect(artifact.completeness.status).toBe('partial');
    expect(artifact.completeness.incompleteReason).toBe('phase-not-declared');

    const next = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));
    expectOk(next.beginFrame(1));
    expectOk(next.beginPhase('app', 'frame-total'));
    expectOk(next.endPhase());
    expectOk(next.endFrame());
    expect(expectOk(next.finish()).records).toHaveLength(1);
  });

  it('retains a detached first source failure through finish and isolates captures', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const first = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 4 }));
    expect(first.firstSourceFailure()).toBeUndefined();
    expectOk(first.beginFrame(1));

    const firstFailureResult = first.beginPhase('render', 'missing-first-phase');
    expect(firstFailureResult.ok).toBe(false);
    if (firstFailureResult.ok) throw new Error('expected undeclared phase failure');
    expect(firstFailureResult.error.code).toBe('profile-source-failed');
    if (firstFailureResult.error.code !== 'profile-source-failed')
      throw new Error('unexpected profiler error');
    expect(firstFailureResult.error.detail).toEqual({
      source: 'render',
      phase: 'missing-first-phase',
      frameId: 1,
    });
    expect(Reflect.set(firstFailureResult.error.detail, 'phase', 'mutated-operation-result')).toBe(
      true,
    );

    const firstObservedFailure = first.firstSourceFailure();
    expect(firstObservedFailure?.code).toBe('profile-source-failed');
    if (firstObservedFailure?.code !== 'profile-source-failed')
      throw new Error('missing retained failure');
    expect(firstObservedFailure.detail.phase).toBe('missing-first-phase');
    expect(Reflect.set(firstObservedFailure.detail, 'source', 'mutated-query-result')).toBe(true);

    const laterFailure = first.recordSkip({
      source: 'app',
      phase: 'missing-later-phase',
      reason: 'regression-control',
    });
    expect(laterFailure.ok).toBe(false);
    const repeatedQuery = first.firstSourceFailure();
    expect(repeatedQuery).not.toBe(firstObservedFailure);
    expect(repeatedQuery).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-first-phase', frameId: 1 },
    });

    expectOk(first.endFrame());
    expectOk(first.finish());
    const postFinish = first.firstSourceFailure();
    expect(postFinish).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-first-phase', frameId: 1 },
    });
    if (postFinish?.code !== 'profile-source-failed')
      throw new Error('missing post-finish failure');
    expect(Reflect.set(postFinish.detail, 'frameId', 99)).toBe(true);
    expect(first.firstSourceFailure()).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-first-phase', frameId: 1 },
    });

    const second = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));
    expect(second.firstSourceFailure()).toBeUndefined();
    expectOk(second.beginFrame(1));
    expect(
      second.recordSkip({
        source: 'render',
        phase: 'missing-first-skip',
        reason: 'first-failure-in-next-capture',
      }).ok,
    ).toBe(false);
    expect(second.firstSourceFailure()).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-first-skip', frameId: 1 },
    });
    expect(first.firstSourceFailure()).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-first-phase', frameId: 1 },
    });
    expectOk(second.endFrame());
  });

  it('retains the exact source and phase read when a skip input has changing getters', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));
    let sourceReads = 0;
    let phaseReads = 0;
    let reasonReads = 0;
    const input = {
      get source(): 'app' | 'render' {
        sourceReads += 1;
        return sourceReads === 1 ? 'render' : 'app';
      },
      get phase() {
        phaseReads += 1;
        return phaseReads === 1 ? 'missing-on-first-read' : 'record';
      },
      get reason() {
        reasonReads += 1;
        return 'not-reached';
      },
    };

    expectOk(session.beginFrame(1));
    const result = session.recordSkip(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected undeclared skip phase failure');
    expect(result.error).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-on-first-read', frameId: 1 },
    });
    expect(session.firstSourceFailure()).toMatchObject({
      code: 'profile-source-failed',
      detail: { source: 'render', phase: 'missing-on-first-read', frameId: 1 },
    });
    expect(sourceReads).toBe(1);
    expect(phaseReads).toBe(1);
    expect(reasonReads).toBe(0);
    expectOk(session.endFrame());
  });

  it('snapshots and validates limits before running dynamic catalog providers', () => {
    const profiler = createProfiler({ clock: createClock() });
    let providerCalls = 0;
    let frameLimitReads = 0;
    let eventLimitReads = 0;
    expect(
      profiler.registerPhaseCatalog('render', [], () => {
        providerCalls += 1;
        return ['render/phase'];
      }).ok,
    ).toBe(true);
    const invalidLimits = {
      get frameLimit() {
        frameLimitReads += 1;
        return 0;
      },
      get eventLimit() {
        eventLimitReads += 1;
        return 8;
      },
    };

    const result = profiler.startCapture(invalidLimits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capture-boundary-invalid');
    expect(frameLimitReads).toBe(1);
    expect(eventLimitReads).toBe(1);
    expect(providerCalls).toBe(0);
  });

  it('releases a phase catalog lease without mutating a finished capture', () => {
    const profiler = createProfiler({ clock: createClock() });
    const release = expectOk(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app));
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());
    release();
    release();

    expect(profiler.phaseCatalog.app).toEqual([]);
    expect(artifact.phaseCatalog.app).toEqual(TEST_PHASE_CATALOG.app);
    expect(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app).ok).toBe(true);
  });

  it('stops record growth after event overflow while retaining scalar accounting', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 20, eventLimit: 2 }));

    for (let frameId = 1; frameId <= 20; frameId += 1) {
      expectOk(session.beginFrame(frameId));
      expectOk(session.recordSkip({ source: 'render', phase: 'record', reason: 'no-render' }));
      expectOk(session.endFrame());
    }
    const artifact = expectOk(session.finish());

    expect(artifact.completeness.status).toBe('overflow');
    expect(artifact.records.length).toBe(2);
    expect(artifact.completeness.retainedEventCount).toBe(2);
    expect(artifact.completeness.droppedEventCount).toBeGreaterThan(0);
    expect(artifact.completeness.firstAffectedFrameId).toBe(3);
    expect(artifact.completeness.lastAffectedFrameId).toBe(20);
  });

  it('returns partial structured errors for a sink Result.err and a sink throw', () => {
    const sinks = [
      { write: () => ({ ok: false as const, error: { code: 'profile-sink-failed' as const } }) },
      {
        write: () => {
          throw new Error('sink unavailable');
        },
      },
    ];

    for (const sink of sinks) {
      const profiler = createProfiler({ clock: createClock(), sink });
      const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 1 }));
      const result = session.finish();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('profile-sink-failed');
        expect(result.error.expected).toContain('partial');
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('capture finalization ownership', () => {
  it.each([
    'owner',
    'passes',
    'nested',
  ] as const)('retains the requested %s detail mode', (detail) => {
    const profiler = createProfiler();
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 4, detail }));
    expect(session.detail).toBe(detail);
  });

  it('publishes the completed receipt before calling a reentrant sink', () => {
    let session: import('../recorder.js').RecorderSession;
    let writes = 0;
    const profiler = createProfiler({
      phaseCatalog: TEST_PHASE_CATALOG,
      sink: {
        write(capture) {
          writes += 1;
          expect(session.finish()).toEqual({ ok: true, value: capture });
          expect(profiler.activeSession()).toBeUndefined();
          expect(profiler.latestCapture()).toBe(capture);
        },
      },
    });
    session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 4 }));
    expectOk(session.beginFrame(10));
    expectOk(session.endFrame());
    const result = session.finish();
    expect(result.ok).toBe(true);
    expect(writes).toBe(1);
  });
  it('retains admitted limits independently of later caller edits', () => {
    const limits = { frameLimit: 1, eventLimit: 4 };
    const profiler = createProfiler({ phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture(limits));
    limits.frameLimit = 20;
    limits.eventLimit = 0;
    expectOk(session.beginFrame(100));
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const capture = expectOk(session.finish());
    expect(capture.frameLimit).toBe(1);
    expect(capture.eventLimit).toBe(4);
    expect(capture.records).toHaveLength(1);
    expect(capture.completeness.status).toBe('complete');
  });
});

it('samples accessor limits once before validating and retains them through auto-finish', () => {
  const profiler = createProfiler({ enabled: true });
  let frameReads = 0;
  let eventReads = 0;
  let detailReads = 0;
  class Limits {
    get frameLimit() {
      return ++frameReads === 1 ? 1 : 0;
    }
    get eventLimit() {
      return ++eventReads === 1 ? 4 : 0;
    }
    get detail() {
      return ++detailReads === 1 ? ('nested' as const) : ('owner' as const);
    }
  }
  const result = profiler.startCapture(new Limits());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.hint);
  expect(result.value.detail).toBe('nested');
  result.value.beginFrame(1);
  result.value.endFrame();
  expect(profiler.activeSession()).toBeUndefined();
  expect(result.value.finish()).toMatchObject({
    ok: true,
    value: { frameLimit: 1, eventLimit: 4 },
  });
  expect([frameReads, eventReads, detailReads]).toEqual([1, 1, 1]);
});
